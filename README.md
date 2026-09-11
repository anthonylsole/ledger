# Tony's General Ledger

A personal bill/sinking-fund tracker: one page showing your checking balance,
what's earmarked (funded) toward upcoming bills, and what's actually safe to
spend — plus a per-category ledger of every bill, its funding progress, and
its due date.

Runs entirely on a single Cloudflare Worker (serves both the page and the
API) backed by a D1 (SQLite) database. No other services required.

## What's here

- `src/worker.js` — the Worker: serves the frontend HTML and the `/api/*` JSON endpoints
- `schema.sql` — table definitions (run once)
- `seed.sql` — your existing bills/categories from the Google Sheet, preloaded (run once, optional)
- `wrangler.toml` — Worker + D1 config

## 1. Prerequisites

- A Cloudflare account
- Node.js installed
- `npm install -g wrangler` (or use `npx wrangler`)
- `wrangler login`

## 2. Create the D1 database

```
wrangler d1 create tonys-ledger-db
```

This prints a `database_id`. Copy it into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_D1_DATABASE_ID`.

## 3. Create the tables

```
wrangler d1 execute tonys-ledger-db --file=./schema.sql --remote
```

## 4. Preload your bills (optional but recommended)

This inserts the categories and bills from your original spreadsheet as a
starting point — edit `seed.sql` first if you want different numbers, or
just run it as-is and edit everything in the app afterward.

```
wrangler d1 execute tonys-ledger-db --file=./seed.sql --remote
```

If you'd rather start completely empty, skip this step — the app handles
zero categories/bills gracefully.

## 5. Deploy the Worker

```
wrangler deploy
```

Wrangler will print your live URL, something like
`https://tonys-general-ledger.<your-subdomain>.workers.dev`.

## 6. Lock it down with Cloudflare Access (important)

Before you put real account numbers in here, put a login wall in front of
the whole Worker:

1. In the Cloudflare dashboard, go to **Zero Trust → Access → Applications**.
2. **Add an application** → **Self-hosted**.
3. Set the domain to your Worker's URL (or a custom domain you've attached to it).
4. Under **Policies**, create an **Allow** policy where the rule is
   **Emails** → your own email address (or **One-time PIN** with your email
   as the identity provider). This means only you can ever reach the app —
   anyone else hitting the URL gets Cloudflare's login screen, not your data.
5. Save. Visit your Worker URL — you should now be prompted to authenticate
   before seeing anything.

That's the single most important security step: it means the sensitive data
sitting in D1 is never reachable by anyone who doesn't pass your Access
policy first, regardless of whether the URL leaks.

## How the bill logic works

- **Total** — the full amount due.
- **Split** — how much you've earmarked/funded toward it so far this cycle.
- **Status** — auto-computed from Split vs. Total: *Needs funding* (Split =
  0) → *Partially funded* (0 < Split < Total) → *Fully funded* (Split ≥
  Total). *Paid* is a distinct state set only by Mark Paid.
- **Mark Paid** (manual bills only) — records `date_paid`, resets Split to 0
  for the next cycle, and **auto-advances the due date by one month if the
  due date has already passed**. If you mark something paid before its due
  date, the due date is left alone (it hasn't "expired" yet).
- **Auto-pay bills** don't get a Mark Paid button — there's nothing for you
  to do; update their Split/status as money moves, same as any bill.
- Every date field (Due, Paid, Withdrawn) and every dollar amount is
  editable by hand via **Edit** — the auto-advance is a convenience, not a
  restriction.
- **Balance**, **Expenses** (sum of all Split values), and **Spending**
  (Balance − Expenses) live at the top and recompute on every change.

## Next steps you might want later

- Multiple pay-period views / a "fund this period" allocator across bills
- CSV export
- Auth beyond Cloudflare Access (e.g. per-field encryption for account numbers)

None of that is built yet — this is the working v1 covering everything
discussed so far.
