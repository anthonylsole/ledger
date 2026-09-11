-- Preloaded sample data, based on the existing Google Sheet.
-- Run AFTER schema.sql: wrangler d1 execute tonys-ledger-db --file=./seed.sql --remote
-- Edit the values below (or just edit in the app afterward) to match reality exactly.

INSERT OR REPLACE INTO meta (key, value) VALUES ('balance', '4812.09');

INSERT INTO categories (name, sort_order) VALUES
  ('Giving', 1),
  ('Credit & Travel', 2),
  ('Auto & Insurance', 3),
  ('Utilities', 4),
  ('Subscriptions & Savings', 5);

-- Giving
INSERT INTO bills (category_id, name, method, total, split, due_date, date_paid, date_withdrawn, confirmation, sort_order)
VALUES
  ((SELECT id FROM categories WHERE name='Giving'), 'Compassion Intl',   'A', 43.00,  21.50, '2026-09-13', NULL, '2026-08-13', '180301027', 1),
  ((SELECT id FROM categories WHERE name='Giving'), 'FCA Monmouth Co.',  'A', 100.00, 50.00, '2026-09-20', NULL, '2026-08-20', NULL, 2),
  ((SELECT id FROM categories WHERE name='Giving'), 'Lifesong',          'A', 68.00,  34.00, '2026-09-22', NULL, '2026-07-27', NULL, 3),
  ((SELECT id FROM categories WHERE name='Giving'), 'Bible Project',     'A', 50.00,  25.00, '2026-09-24', NULL, '2026-08-24', NULL, 4);

-- Credit & Travel
INSERT INTO bills (category_id, name, method, total, split, due_date, date_paid, date_withdrawn, confirmation, sort_order)
VALUES
  ((SELECT id FROM categories WHERE name='Credit & Travel'), 'JetBlue',                  'M', 218.67, 0, '2026-10-05', NULL, NULL, '1408863884', 1),
  ((SELECT id FROM categories WHERE name='Credit & Travel'), 'Citi Balance Transfer',     'M', 0,      0, '2026-10-05', NULL, NULL, NULL, 2),
  ((SELECT id FROM categories WHERE name='Credit & Travel'), 'BOA CC - Travel',           'M', 0,      0, '2026-10-05', NULL, NULL, NULL, 3),
  ((SELECT id FROM categories WHERE name='Credit & Travel'), 'Erika BOA Regular Card',    'M', 0,      0, '2026-10-05', NULL, NULL, NULL, 4),
  ((SELECT id FROM categories WHERE name='Credit & Travel'), 'Checks',                    'M', 0,      0, '2026-10-05', NULL, NULL, NULL, 5);

-- Auto & Insurance
INSERT INTO bills (category_id, name, method, total, split, due_date, date_paid, date_withdrawn, confirmation, sort_order)
VALUES
  ((SELECT id FROM categories WHERE name='Auto & Insurance'), 'Jeep',           'M', 323.38, 0,      '2026-09-30', NULL, NULL, '1007202020293924V522115', 1),
  ((SELECT id FROM categories WHERE name='Auto & Insurance'), 'Verizon',        'A', 89.99,  0,      '2026-10-01', NULL, '2026-08-31', 'YGT34-7JGFK', 2),
  ((SELECT id FROM categories WHERE name='Auto & Insurance'), 'Car Insurance',  'A', 257.83, 257.83, '2026-10-01', NULL, '2026-09-02', '2843-1B5078I8-17JFFGG', 3),
  ((SELECT id FROM categories WHERE name='Auto & Insurance'), 'Audi',          'A', 420.00, 0,      '2026-10-04', NULL, '2026-09-04', '1258540260008', 4),
  ((SELECT id FROM categories WHERE name='Auto & Insurance'), 'IRA',           'A', 50.00,  25.00,  '2026-09-15', NULL, '2026-07-15', NULL, 5);

-- Utilities
INSERT INTO bills (category_id, name, method, total, split, due_date, date_paid, date_withdrawn, confirmation, sort_order)
VALUES
  ((SELECT id FROM categories WHERE name='Utilities'), 'Electric',              'A', 355.24,  177.62, '2026-09-24', NULL, '2026-08-24', '151004443508842355Y', 1),
  ((SELECT id FROM categories WHERE name='Utilities'), 'Natural',               'A', 144.93,  0,      '2026-09-25', NULL, '2026-08-27', '109882734', 2),
  ((SELECT id FROM categories WHERE name='Utilities'), 'Mortgage - Walnut Ave', 'M', 2962.17, 0,      '2026-10-01', NULL, '2026-08-31', '2591012761', 3),
  ((SELECT id FROM categories WHERE name='Utilities'), 'Water',                 'A', 95.78,   47.89,  '2026-09-14', NULL, '2026-07-14', '2403486497', 4);

-- Subscriptions & Savings
INSERT INTO bills (category_id, name, method, total, split, due_date, date_paid, date_withdrawn, confirmation, sort_order)
VALUES
  ((SELECT id FROM categories WHERE name='Subscriptions & Savings'), 'Transfer/Savings', 'M', 900.00, 0,     '2026-10-06', NULL, NULL, NULL, 1),
  ((SELECT id FROM categories WHERE name='Subscriptions & Savings'), 'Peacock',          'A', 10.99,  0,     '2026-10-06', NULL, '2026-09-08', NULL, 2),
  ((SELECT id FROM categories WHERE name='Subscriptions & Savings'), 'Planet Fitness',   'A', 10.66,  5.50,  '2026-09-16', NULL, '2026-08-18', NULL, 3),
  ((SELECT id FROM categories WHERE name='Subscriptions & Savings'), 'Visible',          'A', 60.00,  0,     '2026-09-16', NULL, '2026-08-31', NULL, 4),
  ((SELECT id FROM categories WHERE name='Subscriptions & Savings'), 'Hulu',             'A', 100.00, 50.00, '2026-09-17', NULL, '2026-08-17', NULL, 5),
  ((SELECT id FROM categories WHERE name='Subscriptions & Savings'), 'Netflix',          'A', 26.65,  12.50, '2026-09-17', NULL, '2026-08-17', NULL, 6),
  ((SELECT id FROM categories WHERE name='Subscriptions & Savings'), 'Midd Sewer',       'M', 123.54, 80.00, '2026-09-30', NULL, '2026-07-22', '3907033607', 7);
