-- A small orders warehouse with the kind of mess real data has: refunds, a cancelled order,
-- a customer who churned, and a month where revenue looks better than it was.
--
-- Kept as SQL rather than a binary .db so it is diffable and a reviewer can see exactly what the
-- agent is querying.

CREATE TABLE customers (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  country     TEXT NOT NULL,
  signed_up   DATE NOT NULL
);

CREATE TABLE orders (
  id          INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  placed_at   DATE NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('paid', 'refunded', 'cancelled')),
  amount_cents INTEGER NOT NULL
);

INSERT INTO customers (id, name, country, signed_up) VALUES
  (1, 'Ardent Systems',   'IN', '2026-01-14'),
  (2, 'Brightloom',       'GB', '2026-02-02'),
  (3, 'Cinder & Co',      'US', '2026-02-19'),
  (4, 'Dovetail Works',   'IN', '2026-03-08'),
  (5, 'Everleigh Retail', 'US', '2026-05-30');

INSERT INTO orders (id, customer_id, placed_at, status, amount_cents) VALUES
  (1,  1, '2026-03-03', 'paid',      420000),
  (2,  1, '2026-04-11', 'paid',      380000),
  (3,  2, '2026-03-21', 'paid',      156000),
  (4,  2, '2026-04-02', 'refunded',  156000),
  (5,  3, '2026-04-17', 'paid',      925000),
  (6,  3, '2026-05-09', 'cancelled', 480000),
  (7,  4, '2026-05-14', 'paid',      210000),
  (8,  4, '2026-06-01', 'paid',      210000),
  (9,  1, '2026-06-22', 'refunded',  380000),
  (10, 5, '2026-06-28', 'paid',     1150000),
  (11, 5, '2026-07-15', 'paid',      640000),
  (12, 2, '2026-07-19', 'paid',      156000);
