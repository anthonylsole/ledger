// Tony's General Ledger — Cloudflare Worker
// Serves the frontend and the JSON API backed by D1.
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

function addMonths(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + n);
  if (d.getUTCDate() !== day) {
    d.setUTCDate(0);
  }
  return d.toISOString().slice(0, 10);
}

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
  const parts = url.pathname.split('/').filter(Boolean);
  const method = request.method;

  if (method === 'GET' && parts[1] === 'state') {
    return json(await getState(env));
  }

  if (method === 'POST' && parts[1] === 'balance') {
    const body = await request.json();
    if (typeof body.balance !== 'number') return json({ error: 'balance must be a number' }, 400);
    await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('balance', ?)")
      .bind(String(body.balance))
      .run();
    return json(await getState(env));
  }

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

  if (method === 'DELETE' && parts[1] === 'categories' && parts.length === 3) {
    const id = parseInt(parts[2], 10);
    await env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(id).run();
    return json(await getState(env));
  }

  if (method === 'POST' && parts[1] === 'bills' && parts.length === 2) {
    const b = await request.json();
    if (!b.category_id || !b.name || !b.method || !b.due_date) {
      return json({ error: 'category_id, name, method, and due_date are required' }, 400);
    }
    const total = b.total || 0;
    const split = b.split || 0;
    const status = split >= total && total > 0 ? 'funded' : split > 0 ? 'partial' : 'needs_funding';
    await env.DB.prepare(
      `INSERT INTO bills (category_id, name, method, total, split, due_date, date_paid, date_withdrawn, confirmation, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        b.category_id, b.name, b.method, total, split, b.due_date,
        b.date_paid || null, b.date_withdrawn || null, b.confirmation || null, status
      )
      .run();
    return json(await getState(env));
  }

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
'.app{max-width:1240px;margin:0 auto;padding:28px 24px 80px;}' +
'header.topbar{display:flex;align-items:center;margin-bottom:28px;padding-bottom:16px;border-bottom:2px solid #000;}' +
'.brand{font-family:"Spectral",serif;font-weight:700;font-size:26px;letter-spacing:0.2px;color:#000;}' +
'.brand span{color:var(--peach);}' +
'.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:22px;}' +
'.card{background:var(--paper-raised);border:1px solid var(--slate);border-radius:8px;padding:16px 18px;text-align:center;}' +
'.card .label{font-size:14.5px;color:var(--muted);font-weight:600;cursor:default;}' +
'.card .value{font-family:"IBM Plex Mono",monospace;font-size:26px;font-weight:600;margin-top:6px;}' +
'.card.editable .value{cursor:pointer;}' +
'.card.safe{background:var(--peach);border-color:var(--peach);}' +
'.card.safe .label{color:#7A3E22;}' +
'.card.safe .value{color:#4A2312;}' +
'.funding-banner{display:flex;align-items:center;justify-content:space-between;background:var(--amber-bg);border:1px solid var(--amber);border-radius:8px;padding:14px 18px;margin-bottom:28px;flex-wrap:wrap;gap:10px;}' +
'.funding-banner .msg{font-size:14px;}' +
'.funding-banner .msg strong{font-family:"IBM Plex Mono",monospace;}' +
'.category{margin-bottom:26px;}' +
'.category-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:6px;}' +
'.category-title{font-family:"Spectral",serif;font-weight:600;font-size:18px;color:#fff;}' +
'.category-total{font-family:"IBM Plex Mono",monospace;font-size:17px;color:#000;font-weight:700;}' +
'.table-wrap{overflow-x:auto;border-radius:8px;}' +
'table.ledger{width:100%;border-collapse:collapse;background:var(--paper-raised);border:1px solid var(--slate);border-radius:8px;overflow:hidden;}' +
'table.ledger th{text-align:left;font-size:11.5px;font-weight:600;color:var(--muted);padding:9px 12px;border-bottom:1.5px solid var(--slate);background:#F4F7F5;white-space:nowrap;}' +
'table.ledger td{padding:10px 12px;font-size:13.5px;border-bottom:1px solid #E4E9E6;vertical-align:middle;white-space:nowrap;}' +
'table.ledger tr:last-child td{border-bottom:none;}' +
'td.num,th.num{font-family:"IBM Plex Mono",monospace;text-align:right;}' +
'td.datecell{color:var(--ink);}' +
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
'.mini-btn.save{background:var(--teal);border-color:var(--teal);color:#fff;}' +
'.mini-btn.danger{color:var(--rust);border-color:var(--rust-bg);}' +
'.add-row{text-align:left;padding:9px 12px;font-size:12.5px;font-weight:600;color:var(--teal);cursor:pointer;background:#F4F7F5;border:none;width:100%;}' +
'footer.bottom{display:flex;justify-content:center;margin-top:12px;}' +
'.empty{color:#fff;text-align:center;padding:40px 0;font-size:14.5px;}' +
'.edit-input{width:100%;min-width:80px;padding:5px 6px;border:1px solid var(--slate);border-radius:4px;font-size:12.5px;font-family:"IBM Plex Sans",sans-serif;}' +
'.edit-input.num{font-family:"IBM Plex Mono",monospace;text-align:right;}' +
'.edit-name-wrap{display:flex;flex-direction:column;gap:4px;min-width:150px;}' +
'.edit-name-wrap select{padding:4px;border:1px solid var(--slate);border-radius:4px;font-size:11.5px;}' +
'</style></head><body>' +
'<div class="app" id="app"><div class="empty">Loading…</div></div>' +
'<script>' +
'var state=null;' +
'var editingBillId=null;' +
'var addingInCategoryId=null;' +
'function el(tag,attrs,children){var e=document.createElement(tag);attrs=attrs||{};for(var k in attrs){if(k==="class")e.className=attrs[k];else if(k==="html")e.innerHTML=attrs[k];else e.setAttribute(k,attrs[k]);}children=children||[];for(var i=0;i<children.length;i++){if(children[i])e.appendChild(children[i]);}return e;}' +
'function fmt(n){var v=(Math.round((n+Number.EPSILON)*100)/100).toFixed(2);var neg=v.charAt(0)==="-";if(neg)v=v.slice(1);var parts=v.split(".");parts[0]=parts[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g,",");return (neg?"-$":"$")+parts.join(".");}' +
'function fmtDate(iso){if(!iso)return "—";var p=iso.split("-");var d=new Date(parseInt(p[0],10),parseInt(p[1],10)-1,parseInt(p[2],10));return d.toLocaleDateString("en-US",{month:"long",day:"numeric"});}' +
'function api(path,opts){opts=opts||{};opts.headers={"content-type":"application/json"};return fetch("/api"+path,opts).then(function(r){return r.json();});}' +
'function load(){return api("/state").then(function(s){state=s;render();});}' +
'function statusLabel(s){return {needs_funding:"Needs funding",partial:"Partially funded",funded:"Fully funded",paid:"Paid"}[s]||s;}' +
'function render(){' +
'  var app=document.getElementById("app");' +
'  app.innerHTML="";' +
'  var header=el("header",{class:"topbar"},[el("div",{class:"brand",html:"Tony\'s General Ledger<span>.</span>"})]);' +
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
'  var footer=el("footer",{class:"bottom"},[(function(){var b=el("button",{class:"btn btn-invert"},[document.createTextNode("+ Add Category")]);b.onclick=addCategory;b.style.border="1.5px solid #fff";b.style.color="#fff";b.style.background="transparent";b.style.padding="9px 16px";b.style.borderRadius="5px";b.style.fontWeight="600";b.style.fontSize="13.5px";b.style.cursor="pointer";return b;})()]);' +
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
'    el("th",{},[document.createTextNode("Paid")]),' +
'    el("th",{},[document.createTextNode("Withdrawn")]),' +
'    el("th",{},[document.createTextNode("Status")]),' +
'    el("th",{},[document.createTextNode("Actions")])' +
'  ]);' +
'  var table=el("table",{class:"ledger"},[thead]);' +
'  cat.bills.forEach(function(b){table.appendChild(b.id===editingBillId?renderBillEditRow(b):renderBillRow(b));});' +
'  if(cat.id===addingInCategoryId){' +
'    table.appendChild(renderNewBillRow(cat.id));' +
'  }else{' +
'    var addRowTd=el("td",{colspan:"8"},[]);' +
'    var addBtn=el("button",{class:"add-row"},[document.createTextNode("+ Add bill to "+cat.name)]);' +
'    addBtn.onclick=function(){addingInCategoryId=cat.id;render();};' +
'    addRowTd.appendChild(addBtn);' +
'    table.appendChild(el("tr",{},[addRowTd]));' +
'  }' +
'  return el("div",{class:"category"},[head,el("div",{class:"table-wrap"},[table])]);' +
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
'  editBtn.onclick=function(){editingBillId=b.id;render();};' +
'  actions.appendChild(editBtn);' +
'  var delBtn=el("button",{class:"mini-btn danger"},[document.createTextNode("Delete")]);' +
'  delBtn.onclick=function(){if(confirm("Delete "+b.name+"?")){api("/bills/"+b.id,{method:"DELETE"}).then(function(s){state=s;render();});}};' +
'  actions.appendChild(delBtn);' +
'  return el("tr",{},[' +
'    nameCell,' +
'    el("td",{class:"num"},[document.createTextNode(fmt(b.total))]),' +
'    el("td",{class:"num"},[document.createTextNode(fmt(b.split))]),' +
'    el("td",{class:"datecell"},[document.createTextNode(fmtDate(b.due_date))]),' +
'    el("td",{class:"datecell"},[document.createTextNode(fmtDate(b.date_paid))]),' +
'    el("td",{class:"datecell"},[document.createTextNode(fmtDate(b.date_withdrawn))]),' +
'    el("td",{class:"status status-"+b.status},[document.createTextNode(statusLabel(b.status))]),' +
'    actions' +
'  ]);' +
'}' +
'function renderBillEditRow(b){' +
'  var nameWrap=el("div",{class:"edit-name-wrap"},[]);' +
'  var nameInput=el("input",{class:"edit-input",value:b.name},[]);' +
'  var methodSelect=el("select",{},[el("option",{value:"A"},[document.createTextNode("Auto-pay")]),el("option",{value:"M"},[document.createTextNode("Manual")])]);' +
'  methodSelect.value=b.method;' +
'  var confInput=el("input",{class:"edit-input",placeholder:"Confirmation #",value:b.confirmation||""},[]);' +
'  nameWrap.appendChild(nameInput);nameWrap.appendChild(methodSelect);nameWrap.appendChild(confInput);' +
'  var nameCell=el("td",{},[nameWrap]);' +
'  var totalInput=el("input",{class:"edit-input num",type:"number",step:"0.01",value:b.total},[]);' +
'  var splitInput=el("input",{class:"edit-input num",type:"number",step:"0.01",value:b.split},[]);' +
'  var dueInput=el("input",{class:"edit-input",type:"date",value:b.due_date},[]);' +
'  var paidInput=el("input",{class:"edit-input",type:"date",value:b.date_paid||""},[]);' +
'  var withdrawnInput=el("input",{class:"edit-input",type:"date",value:b.date_withdrawn||""},[]);' +
'  var actions=el("td",{class:"row-actions"},[]);' +
'  var saveBtn=el("button",{class:"mini-btn save"},[document.createTextNode("Save")]);' +
'  saveBtn.onclick=function(){' +
'    var payload={' +
'      name:nameInput.value,' +
'      method:methodSelect.value,' +
'      total:parseFloat(totalInput.value)||0,' +
'      split:parseFloat(splitInput.value)||0,' +
'      due_date:dueInput.value,' +
'      date_paid:paidInput.value||null,' +
'      date_withdrawn:withdrawnInput.value||null,' +
'      confirmation:confInput.value||null' +
'    };' +
'    api("/bills/"+b.id,{method:"PUT",body:JSON.stringify(payload)}).then(function(s){state=s;editingBillId=null;render();});' +
'  };' +
'  var cancelBtn=el("button",{class:"mini-btn"},[document.createTextNode("Cancel")]);' +
'  cancelBtn.onclick=function(){editingBillId=null;render();};' +
'  actions.appendChild(saveBtn);actions.appendChild(cancelBtn);' +
'  return el("tr",{},[' +
'    nameCell,' +
'    el("td",{},[totalInput]),' +
'    el("td",{},[splitInput]),' +
'    el("td",{},[dueInput]),' +
'    el("td",{},[paidInput]),' +
'    el("td",{},[withdrawnInput]),' +
'    el("td",{},[document.createTextNode(statusLabel(b.status))]),' +
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
'function renderNewBillRow(categoryId){' +
'  var nameWrap=el("div",{class:"edit-name-wrap"},[]);' +
'  var nameInput=el("input",{class:"edit-input",placeholder:"Bill name"},[]);' +
'  var methodSelect=el("select",{},[el("option",{value:"A"},[document.createTextNode("Auto-pay")]),el("option",{value:"M"},[document.createTextNode("Manual")])]);' +
'  var confInput=el("input",{class:"edit-input",placeholder:"Confirmation #"},[]);' +
'  nameWrap.appendChild(nameInput);nameWrap.appendChild(methodSelect);nameWrap.appendChild(confInput);' +
'  var nameCell=el("td",{},[nameWrap]);' +
'  var totalInput=el("input",{class:"edit-input num",type:"number",step:"0.01",placeholder:"0.00"},[]);' +
'  var splitInput=el("input",{class:"edit-input num",type:"number",step:"0.01",placeholder:"0.00"},[]);' +
'  var dueInput=el("input",{class:"edit-input",type:"date"},[]);' +
'  var paidInput=el("input",{class:"edit-input",type:"date"},[]);' +
'  var withdrawnInput=el("input",{class:"edit-input",type:"date"},[]);' +
'  var actions=el("td",{class:"row-actions"},[]);' +
'  var saveBtn=el("button",{class:"mini-btn save"},[document.createTextNode("Save")]);' +
'  saveBtn.onclick=function(){' +
'    if(!nameInput.value||!dueInput.value){alert("Bill name and due date are required.");return;}' +
'    var payload={' +
'      category_id:categoryId,' +
'      name:nameInput.value,' +
'      method:methodSelect.value,' +
'      total:parseFloat(totalInput.value)||0,' +
'      split:parseFloat(splitInput.value)||0,' +
'      due_date:dueInput.value,' +
'      date_paid:paidInput.value||null,' +
'      date_withdrawn:withdrawnInput.value||null,' +
'      confirmation:confInput.value||null' +
'    };' +
'    api("/bills",{method:"POST",body:JSON.stringify(payload)}).then(function(s){state=s;addingInCategoryId=null;render();});' +
'  };' +
'  var cancelBtn=el("button",{class:"mini-btn"},[document.createTextNode("Cancel")]);' +
'  cancelBtn.onclick=function(){addingInCategoryId=null;render();};' +
'  actions.appendChild(saveBtn);actions.appendChild(cancelBtn);' +
'  return el("tr",{},[' +
'    nameCell,' +
'    el("td",{},[totalInput]),' +
'    el("td",{},[splitInput]),' +
'    el("td",{},[dueInput]),' +
'    el("td",{},[paidInput]),' +
'    el("td",{},[withdrawnInput]),' +
'    el("td",{},[document.createTextNode("—")]),' +
'    actions' +
'  ]);' +
'}' +
'function markPaid(b){' +
'  var conf=prompt("Confirmation # (optional)",b.confirmation||"");' +
'  api("/bills/"+b.id+"/mark-paid",{method:"POST",body:JSON.stringify({confirmation:conf})}).then(function(s){state=s;render();});' +
'}' +
'load();' +
'</' + 'script></body></html>';
