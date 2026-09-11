-- Tony's General Ledger — D1 schema
-- Run once: wrangler d1 execute tonys-ledger-db --file=./schema.sql --remote

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bills (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id    INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  method         TEXT NOT NULL CHECK (method IN ('A','M')),  -- A = Auto-pay, M = Manual
  total          REAL NOT NULL DEFAULT 0,
  split          REAL NOT NULL DEFAULT 0,   -- amount earmarked/funded so far toward `total`
  due_date       TEXT NOT NULL,             -- ISO yyyy-mm-dd
  date_paid      TEXT,                      -- ISO yyyy-mm-dd, nullable
  date_withdrawn TEXT,                      -- ISO yyyy-mm-dd, nullable
  confirmation   TEXT,
  status         TEXT NOT NULL DEFAULT 'needs_funding', -- needs_funding | partial | funded | paid
  sort_order     INTEGER NOT NULL DEFAULT 0
);

-- Starting balance so the app isn't showing $0 on first load.
-- Categories/bills intentionally NOT seeded here — see seed.sql to preload sample data.
INSERT OR IGNORE INTO meta (key, value) VALUES ('balance', '0');
