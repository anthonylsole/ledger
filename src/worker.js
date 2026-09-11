// Tony's General Ledger — Cloudflare Worker
// Serves the single-page frontend at GET / and a JSON API under /api/*.
// Requires a D1 binding named `DB` (see wrangler.toml).
// Put this Worker behind Cloudflare Access (Zero Trust) — see README.md.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Adds `n` months to an ISO date string (yyyy-mm-dd), clamping overflow
// days to the last day of the resulting month (e.g. Jan 31 + 1mo -> Feb 28).
function addMonths(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + n);
  if (d.getUTCDate() !== day) {
    d.setUTCDate(0); // rolls back to the last day of the intended month
  }
  return d.toISOString().slice(0, 10);
}

// If a bill is marked paid AND its due date has already passed,
// auto-advance the due date by a month at a time until it's in the future.
function advanceDueDateIfPast(dueDate) {
  const today = todayISO();
  if (dueDate >= today) return dueDate;
  let next = addMonths(dueDate, 1);
  let guard = 0;
  while (next < today && guard < 60) {
    next = addMonths(next, 1);
    guard++;
  }
  return next;
}

function billStatus(bill) {
  if (bill.status === 'paid') return 'paid';
  if (bill.split <= 0) return 'needs_funding';
  if (bill.split < bill.total) return 'partial';
  return 'funded';
}

async function getState(env) {
  const balanceRow = await env.DB.prepare("SELECT value FROM meta WHERE key='balance'").first();
  const balance = balanceRow ? parseFloat(balanceRow.value) : 0;

  const { results: cats } = await env.DB.prepare(
    'SELECT id, name, sort_order FROM categories ORDER BY sort_order, id'
  ).all();

  const { results: bills } = await env.DB.prepare(
    'SELECT * FROM bills ORDER BY sort_order, id'
  ).all();

  let expenses = 0;
  const categories = cats.map((c) => {
    const catBills = bills
      .filter((b) => b.category_id === c.id)
      .map((b) => ({ ...b, status: billStatus(b) }));
    const total = catBills.reduce((s, b) => s + b.total, 0);
    const split = catBills.reduce((s, b) => s + b.split, 0);
    expenses += split;
    return { id: c.id, name: c.name, total, split, bills: catBills };
  });

  const needsFunding = bills.filter((b) => b.split < b.total);
  const remainingToFund = needsFunding.reduce((s, b) => s + (b.total - b.split), 0);

  return {
    balance,
    expenses,
    spending: balance - expenses,
    needsFundingCount: needsFunding.length,
    remainingToFund,
    categories,
  };
}

async function handleApi(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = request.method;

  // GET /api/state
  if (method === 'GET' && parts[1] === 'state') {
    return json(await getState(env));
  }

  // POST /api/balance  { balance: number }
  if (method === 'POST' && parts[1] === 'balance') {
    const body = await request.json();
    if (typeof body.balance !== 'number') return json({ error: 'balance must be a number' }, 400);
    await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('balance', ?)")
      .bind(String(body.balance))
      .run();
    return json(await getState(env));
  }

  // POST /api/categories  { name: string }
  if (method === 'POST' && parts[1] === 'categories' && parts.length === 2) {
    const body = await request.json();
    if (!body.name) return json({ error: 'name is required' }, 400);
    const { results } = await env.DB.prepare(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM categories'
    ).all();
    const nextOrder = results[0].n;
    await env.DB.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)')
      .bind(body.name, nextOrder)
      .run();
    return json(await getState(env));
  }

  // DELETE /api/categories/:id
  if (method === 'DELETE' && parts[1] === 'categories' && parts.length === 3) {
    const id = parseInt(parts[2], 10);
    await env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(id).run();
    return json(await getState(env));
  }

  // POST /api/bills  { category_id, name, method, total, due_date }
  if (method === 'POST' && parts[1] === 'bills' && parts.length === 2) {
    const b = await request.json();
    if (!b.category_id || !b.name || !b.method || !b.due_date) {
      return json({ error: 'category_id, name, method, and due_date are required' }, 400);
    }
    await env.DB.prepare(
      `INSERT INTO bills (category_id, name, method, total, split, due_date, status)
       VALUES (?, ?, ?, ?, 0, ?, 'needs_funding')`
    )
      .bind(b.category_id, b.name, b.method, b.total || 0, b.due_date)
      .run();
    return json(await getState(env));
  }

  // PUT /api/bills/:id  — manual full edit (name, method, total, split, dates, confirmation)
  if (method === 'PUT' && parts[1] === 'bills' && parts.length === 3) {
    const id = parseInt(parts[2], 10);
    const b = await request.json();
    const existing = await env.DB.prepare('SELECT * FROM bills WHERE id = ?').bind(id).first();
    if (!existing) return json({ error: 'not found' }, 404);

    const merged = {
      name: b.name ?? existing.name,
      method: b.method ?? existing.method,
      total: b.total ?? existing.total,
      split: b.split ?? existing.split,
      due_date: b.due_date ?? existing.due_date,
      date_paid: b.date_paid !== undefined ? b.date_paid : existing.date_paid,
      date_withdrawn: b.date_withdrawn !== undefined ? b.date_withdrawn : existing.date_withdrawn,
      confirmation: b.confirmation !== undefined ? b.confirmation : existing.confirmation,
    };
    // Manual edits recompute status from split/total unless caller explicitly
    // marks it paid via the dedicated mark-paid endpoint.
    const status = merged.split >= merged.total && merged.total > 0 ? 'funded'
      : merged.split > 0 ? 'partial' : 'needs_funding';

    await env.DB.prepare(
      `UPDATE bills SET name=?, method=?, total=?, split=?, due_date=?, date_paid=?, date_withdrawn=?, confirmation=?, status=?
       WHERE id=?`
    )
      .bind(
        merged.name, merged.method, merged.total, merged.split, merged.due_date,
        merged.date_paid, merged.date_withdrawn, merged.confirmation, status, id
      )
      .run();
    return json(await getState(env));
  }

  // POST /api/bills/:id/mark-paid  { date_paid?, date_withdrawn?, confirmation? }
  if (method === 'POST' && parts[1] === 'bills' && parts[3] === 'mark-paid') {
    const id = parseInt(parts[2], 10);
    const b = await request.json().catch(() => ({}));
    const existing = await env.DB.prepare('SELECT * FROM bills WHERE id = ?').bind(id).first();
    if (!existing) return json({ error: 'not found' }, 404);

    const datePaid = b.date_paid || todayISO();
    const newDueDate = advanceDueDateIfPast(existing.due_date);
    const dateWithdrawn = b.date_withdrawn !== undefined ? b.date_withdrawn : existing.date_withdrawn;
    const confirmation = b.confirmation !== undefined ? b.confirmation : existing.confirmation;

    await env.DB.prepare(
      `UPDATE bills SET date_paid=?, due_date=?, date_withdrawn=?, confirmation=?, split=0, status='paid'
       WHERE id=?`
    )
      .bind(datePaid, newDueDate, dateWithdrawn, confirmation, id)
      .run();
    return json(await getState(env));
  }

  // DELETE /api/bills/:id
  if (method === 'DELETE' && parts[1] === 'bills' && parts.length === 3) {
    const id = parseInt(parts[2], 10);
    await env.DB.prepare('DELETE FROM bills WHERE id = ?').bind(id).run();
    return json(await getState(env));
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ error: String(err) }, 500);
      }
    }
    return new Response(PAGE_HTML, { headers: { 'content-type': 'text/html;charset=UTF-8' } });
  },
};

const PAGE_HTML = '<!DOCTYPE html>' +
'<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
'<title>Tony\'s General Ledger</title>' +
'<link rel="preconnect" href="https://fonts.googleapis.com">' +
'<link href="https://fonts.googleapis.com/css2?family=Spectral:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">' +
'<style>' +
':root{--ink:#1B2733;--paper-raised:#FFFFFF;--teal:#1F6F63;--sage:#4C9A6A;--sage-bg:#E4F1E8;--amber:#C98A2C;--amber-bg:#F7EBD8;--rust:#B54A3F;--rust-bg:#F8E4E1;--slate:#C7D0CC;--muted:#5D6B66;--peach:#FBB18F;}' +
'*{box-sizing:border-box;}' +
'body{margin:0;background:linear-gradient(180deg,#8FD9FB 0%,#022333 100%);background-attachment:fixed;color:var(--ink);font-family:"IBM Plex Sans",sans-serif;line-height:1.4;}' +
'.app{max-width:960px;margin:0 auto;padding:28px 24px 80px;}' +
'header.topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px;padding-bottom:16px;border-bottom:2px solid #000;flex-wrap:wrap;gap:12px;}' +
'.brand{font-family:"Spectral",serif;font-weight:700;font-size:26px;letter-spacing:0.2px;color:#000;}' +
'.brand span{color:var(--peach);}' +
'.topnav{display:flex;gap:10px;flex-wrap:wrap;}' +
'.btn{font-family:"IBM Plex Sans",sans-serif;font-size:13.5px;font-weight:600;padding:9px 16px;border-radius:5px;border:1.5px solid #000;background:transparent;color:#000;cursor:pointer;}' +
'.btn-primary{background:var(--teal);border-color:var(--teal);color:#fff;}' +
'.btn-ghost{border-color:#000;color:#000;}' +
'.btn-invert{border-color:#fff;color:#fff;background:transparent;}' +
'.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:22px;}' +
'.card{background:var(--paper-raised);border:1px solid var(--slate);border-radius:8px;padding:16px 18px;text-align:center;}' +
'.card .label{font-size:14.5px;color:var(--muted);font-weight:600;cursor:default;}' +
'.card .value{font-family:"IBM Plex Mono",monospace;font-size:26px;font-weight:600;margin-top:6px;}' +
'.card.editable .value{cursor:pointer;border-bottom:1px dashed var(--slate);}' +
'.card.safe{background:var(--peach);border-color:var(--peach);}' +
'.card.safe .label{color:#7A3E22;}' +
'.card.safe .value{color:#4A2312;}' +
'.funding-banner{display:flex;align-items:center;justify-content:space-between;background:var(--amber-bg);border:1px solid var(--amber);border-radius:8px;padding:14px 18px;margin-bottom:28px;flex-wrap:wrap;gap:10px;}' +
'.funding-banner .msg{font-size:14px;}' +
'.funding-banner .msg strong{font-family:"IBM Plex Mono",monospace;}' +
'.category{margin-bottom:26px;}' +
'.category-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:6px;}' +
'.category-title{font-family:"Spectral",serif;font-weight:600;font-size:18px;color:#fff;}' +
'.category-total{font-family:"IBM Plex Mono",monospace;font-size:14px;color:var(--peach);}' +
'table.ledger{width:100%;border-collapse:collapse;background:var(--paper-raised);border:1px solid var(--slate);border-radius:8px;overflow:hidden;}' +
'table.ledger th{text-align:left;font-size:11.5px;font-weight:600;color:var(--muted);padding:9px 12px;border-bottom:1.5px solid var(--slate);background:#F4F7F5;}' +
'table.ledger td{padding:10px 12px;font-size:13.5px;border-bottom:1px solid #E4E9E6;vertical-align:middle;}' +
'table.ledger tr:last-child td{border-bottom:none;}' +
'td.num,th.num{font-family:"IBM Plex Mono",monospace;text-align:right;}' +
'.method-flag{font-family:"IBM Plex Mono",monospace;font-weight:600;font-size:11.5px;margin-left:6px;padding:1px 5px;border-radius:3px;}' +
'.flag-A{background:var(--sage-bg);color:var(--sage);}' +
'.flag-M{background:var(--amber-bg);color:var(--amber);}' +
'.status{font-size:12px;font-weight:600;}' +
'.status-funded{color:var(--teal);}' +
'.status-partial{color:var(--amber);}' +
'.status-needs_funding{color:var(--rust);}' +
'.status-paid{color:var(--teal);}' +
'.row-actions{display:flex;gap:6px;flex-wrap:wrap;}' +
'.mini-btn{font-family:"IBM Plex Sans",sans-serif;font-size:11.5px;font-weight:600;padding:5px 10px;border-radius:4px;border:1px solid var(--slate);background:#fff;color:var(--ink);cursor:pointer;white-space:nowrap;}' +
'.mini-btn.pay{background:var(--teal);border-color:var(--teal);color:#fff;}' +
'.mini-btn.danger{color:var(--rust);border-color:var(--rust-bg);}' +
'.add-row{text-align:left;padding:9px 12px;font-size:12.5px;font-weight:600;color:var(--teal);cursor:pointer;background:#F4F7F5;border:none;width:100%;}' +
'footer.bottom{display:flex;justify-content:center;margin-top:12px;}' +
'.empty{color:#fff;text-align:center;padding:40px 0;font-size:14.5px;}' +
'.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:20px;z-index:50;}' +
'.modal{background:#fff;border-radius:8px;padding:22px;width:100%;max-width:420px;max-height:90vh;overflow:auto;}' +
'.modal h3{font-family:"Spectral",serif;margin-top:0;}' +
'.modal label{display:block;font-size:12.5px;font-weight:600;color:var(--muted);margin:10px 0 4px;}' +
'.modal input,.modal select{width:100%;padding:8px 10px;border:1px solid var(--slate);border-radius:5px;font-size:13.5px;font-family:"IBM Plex Sans",sans-serif;}' +
'.modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px;}' +
'</style></head><body>' +
'<div class="app" id="app"><div class="empty">Loading…</div></div>' +
'<script>' +
'var state=null;' +
'function el(tag,attrs,children){var e=document.createElement(tag);attrs=attrs||{};for(var k in attrs){if(k==="class")e.className=attrs[k];else if(k==="html")e.innerHTML=attrs[k];else e.setAttribute(k,attrs[k]);}children=children||[];for(var i=0;i<children.length;i++){if(children[i])e.appendChild(children[i]);}return e;}' +
'function fmt(n){var v=(Math.round((n+Number.EPSILON)*100)/100).toFixed(2);var neg=v.charAt(0)==="-";if(neg)v=v.slice(1);var parts=v.split(".");parts[0]=parts[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g,",");return (neg?"-$":"$")+parts.join(".");}' +
'function api(path,opts){opts=opts||{};opts.headers={"content-type":"application/json"};return fetch("/api"+path,opts).then(function(r){return r.json();});}' +
'function load(){return api("/state").then(function(s){state=s;render();});}' +
'function statusLabel(s){return {needs_funding:"Needs funding",partial:"Partially funded",funded:"Fully funded",paid:"Paid"}[s]||s;}' +
'function render(){' +
'  var app=document.getElementById("app");' +
'  app.innerHTML="";' +
'  var header=el("header",{class:"topbar"},[' +
'    el("div",{class:"brand",html:"Tony\'s General Ledger<span>.</span>"}),' +
'    el("div",{class:"topnav"},[' +
'      el("button",{class:"btn btn-ghost"},[document.createTextNode("Categories")]),' +
'      el("button",{class:"btn btn-ghost"},[document.createTextNode("Pay Periods")]),' +
'      (function(){var b=el("button",{class:"btn btn-primary"},[document.createTextNode("+ Add Bill")]);b.onclick=openAddBillPicker;return b;})()' +
'    ])' +
'  ]);' +
'  app.appendChild(header);' +
'  var summary=el("div",{class:"summary"},[' +
'    (function(){var c=el("div",{class:"card editable"},[el("div",{class:"label"},[document.createTextNode("Balance")]),el("div",{class:"value"},[document.createTextNode(fmt(state.balance))])]);c.querySelector(".value").onclick=editBalance;return c;})(),' +
'    el("div",{class:"card"},[el("div",{class:"label"},[document.createTextNode("Expenses")]),el("div",{class:"value"},[document.createTextNode(fmt(state.expenses))])]),' +
'    el("div",{class:"card safe"},[el("div",{class:"label"},[document.createTextNode("Spending")]),el("div",{class:"value"},[document.createTextNode(fmt(state.spending))])])' +
'  ]);' +
'  app.appendChild(summary);' +
'  if(state.needsFundingCount>0){' +
'    var banner=el("div",{class:"funding-banner"},[' +
'      el("div",{class:"msg",html:state.needsFundingCount+" bill(s) still need funding, totaling <strong>"+fmt(state.remainingToFund)+"</strong>."}),' +
'    ]);' +
'    app.appendChild(banner);' +
'  }' +
'  if(state.categories.length===0){' +
'    app.appendChild(el("div",{class:"empty"},[document.createTextNode("No categories yet.")]));' +
'  }' +
'  state.categories.forEach(function(cat){app.appendChild(renderCategory(cat));});' +
'  var footer=el("footer",{class:"bottom"},[(function(){var b=el("button",{class:"btn btn-invert"},[document.createTextNode("+ Add Category")]);b.onclick=addCategory;return b;})()]);' +
'  app.appendChild(footer);' +
'}' +
'function renderCategory(cat){' +
'  var head=el("div",{class:"category-head"},[' +
'    el("div",{class:"category-title"},[document.createTextNode(cat.name)]),' +
'    el("div",{class:"category-total"},[document.createTextNode("total "+fmt(cat.total)+"  ·  split "+fmt(cat.split))])' +
'  ]);' +
'  var thead=el("tr",{},[' +
'    el("th",{},[document.createTextNode("Bill")]),' +
'    el("th",{class:"num"},[document.createTextNode("Total")]),' +
'    el("th",{class:"num"},[document.createTextNode("Split")]),' +
'    el("th",{},[document.createTextNode("Due")]),' +
'    el("th",{},[document.createTextNode("Status")]),' +
'    el("th",{},[document.createTextNode("Actions")])' +
'  ]);' +
'  var table=el("table",{class:"ledger"},[thead]);' +
'  cat.bills.forEach(function(b){table.appendChild(renderBillRow(b));});' +
'  var addRowTd=el("td",{colspan:"6"},[]);' +
'  var addBtn=el("button",{class:"add-row"},[document.createTextNode("+ Add bill to "+cat.name)]);' +
'  addBtn.onclick=function(){openBillModal(null,cat.id);};' +
'  addRowTd.appendChild(addBtn);' +
'  table.appendChild(el("tr",{},[addRowTd]));' +
'  return el("div",{class:"category"},[head,table]);' +
'}' +
'function renderBillRow(b){' +
'  var nameCell=el("td",{},[document.createTextNode(b.name+" ")]);' +
'  nameCell.appendChild(el("span",{class:"method-flag flag-"+b.method},[document.createTextNode(b.method)]));' +
'  var actions=el("td",{class:"row-actions"},[]);' +
'  if(b.method==="M" && b.status!=="paid"){' +
'    var payBtn=el("button",{class:"mini-btn pay"},[document.createTextNode("Mark Paid")]);' +
'    payBtn.onclick=function(){markPaid(b);};' +
'    actions.appendChild(payBtn);' +
'  }' +
'  var editBtn=el("button",{class:"mini-btn"},[document.createTextNode("Edit")]);' +
'  editBtn.onclick=function(){openBillModal(b,b.category_id);};' +
'  actions.appendChild(editBtn);' +
'  var delBtn=el("button",{class:"mini-btn danger"},[document.createTextNode("Delete")]);' +
'  delBtn.onclick=function(){if(confirm("Delete "+b.name+"?")){api("/bills/"+b.id,{method:"DELETE"}).then(function(s){state=s;render();});}};' +
'  actions.appendChild(delBtn);' +
'  return el("tr",{},[' +
'    nameCell,' +
'    el("td",{class:"num"},[document.createTextNode(fmt(b.total))]),' +
'    el("td",{class:"num"},[document.createTextNode(fmt(b.split))]),' +
'    el("td",{},[document.createTextNode(b.due_date)]),' +
'    el("td",{class:"status status-"+b.status},[document.createTextNode(statusLabel(b.status))]),' +
'    actions' +
'  ]);' +
'}' +
'function editBalance(){' +
'  var v=prompt("Set balance",state.balance);' +
'  if(v===null)return;' +
'  var n=parseFloat(v);' +
'  if(isNaN(n))return;' +
'  api("/balance",{method:"POST",body:JSON.stringify({balance:n})}).then(function(s){state=s;render();});' +
'}' +
'function addCategory(){' +
'  var name=prompt("New category name");' +
'  if(!name)return;' +
'  api("/categories",{method:"POST",body:JSON.stringify({name:name})}).then(function(s){state=s;render();});' +
'}' +
'function markPaid(b){' +
'  var conf=prompt("Confirmation # (optional)",b.confirmation||"");' +
'  api("/bills/"+b.id+"/mark-paid",{method:"POST",body:JSON.stringify({confirmation:conf})}).then(function(s){state=s;render();});' +
'}' +
'function openAddBillPicker(){' +
'  if(!state.categories.length){alert("Add a category first.");return;}' +
'  openBillModal(null,state.categories[0].id);' +
'}' +
'function closeModal(){var m=document.querySelector(".modal-backdrop");if(m)m.remove();}' +
'function openBillModal(bill,categoryId){' +
'  closeModal();' +
'  var isEdit=!!bill;' +
'  var backdrop=el("div",{class:"modal-backdrop"},[]);' +
'  backdrop.onclick=function(e){if(e.target===backdrop)closeModal();};' +
'  var modal=el("div",{class:"modal"},[]);' +
'  modal.appendChild(el("h3",{},[document.createTextNode(isEdit?"Edit Bill":"Add Bill")]));' +
'  function field(labelText,inputId,type,value){' +
'    modal.appendChild(el("label",{},[document.createTextNode(labelText)]));' +
'    var inp=el("input",{id:inputId,type:type||"text",value:value!==undefined&&value!==null?value:""},[]);' +
'    modal.appendChild(inp);' +
'    return inp;' +
'  }' +
'  var catSelect;' +
'  if(!isEdit){' +
'    modal.appendChild(el("label",{},[document.createTextNode("Category")]));' +
'    catSelect=el("select",{id:"f_category"},[]);' +
'    state.categories.forEach(function(c){var o=el("option",{value:c.id},[document.createTextNode(c.name)]);if(c.id===categoryId)o.selected=true;catSelect.appendChild(o);});' +
'    modal.appendChild(catSelect);' +
'  }' +
'  var fName=field("Bill name","f_name","text",bill?bill.name:"");' +
'  modal.appendChild(el("label",{},[document.createTextNode("Method")]));' +
'  var fMethod=el("select",{id:"f_method"},[el("option",{value:"A"},[document.createTextNode("Auto-pay")]),el("option",{value:"M"},[document.createTextNode("Manual")])]);' +
'  fMethod.value=bill?bill.method:"A";' +
'  modal.appendChild(fMethod);' +
'  var fTotal=field("Total amount due","f_total","number",bill?bill.total:"");' +
'  var fSplit=field("Split (funded so far)","f_split","number",bill?bill.split:0);' +
'  var fDue=field("Due date","f_due","date",bill?bill.due_date:"");' +
'  var fPaid=field("Date paid","f_paid","date",bill?bill.date_paid:"");' +
'  var fWithdrawn=field("Date withdrawn","f_withdrawn","date",bill?bill.date_withdrawn:"");' +
'  var fConf=field("Confirmation #","f_conf","text",bill?bill.confirmation:"");' +
'  var actions=el("div",{class:"modal-actions"},[]);' +
'  var cancelBtn=el("button",{class:"btn btn-ghost"},[document.createTextNode("Cancel")]);' +
'  cancelBtn.onclick=closeModal;' +
'  var saveBtn=el("button",{class:"btn btn-primary"},[document.createTextNode("Save")]);' +
'  saveBtn.onclick=function(){' +
'    var payload={' +
'      name:fName.value,' +
'      method:fMethod.value,' +
'      total:parseFloat(fTotal.value)||0,' +
'      split:parseFloat(fSplit.value)||0,' +
'      due_date:fDue.value,' +
'      date_paid:fPaid.value||null,' +
'      date_withdrawn:fWithdrawn.value||null,' +
'      confirmation:fConf.value||null' +
'    };' +
'    if(isEdit){' +
'      api("/bills/"+bill.id,{method:"PUT",body:JSON.stringify(payload)}).then(function(s){state=s;render();closeModal();});' +
'    }else{' +
'      payload.category_id=parseInt(catSelect.value,10);' +
'      api("/bills",{method:"POST",body:JSON.stringify(payload)}).then(function(s){state=s;render();closeModal();});' +
'    }' +
'  };' +
'  actions.appendChild(cancelBtn);actions.appendChild(saveBtn);' +
'  modal.appendChild(actions);' +
'  backdrop.appendChild(modal);' +
'  document.body.appendChild(backdrop);' +
'}' +
'load();' +
'</' + 'script></body></html>';
