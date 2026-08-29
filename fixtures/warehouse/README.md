# warehouse (fixture)

An orders database for the `analytics` agent: 180 customers, 638 orders, 1,273 line items and 46
refunds across six months. Five tables, no server, no credentials.

```bash
sqlite3 warehouse.db < seed.sql
sqlite3 warehouse.db "SELECT count(*) FROM orders;"
```

That works on a machine with the SQLite command line. **The agent's sandbox does not have one** — it
has python3 and no database binary at all — so in there the same thing is done through the `sqlite3`
module inside Python:

```bash
python3 - <<'SQL'
import sqlite3
db = sqlite3.connect('warehouse.db')
db.executescript(open('seed.sql').read())
print(db.execute('select count(*) from orders').fetchone()[0])
db.commit()
SQL
```

Both build the same database. The distinction is worth keeping straight, because a command that
fails with `sqlite3: command not found` is a command that did not run — not a query that returned
nothing, which is the confusion this agent exists to refuse.

## The shape

| Table | Rows | What one row is |
| --- | --- | --- |
| `customers` | 180 | a person, with a signup date, a plan, and sometimes no country |
| `products` | 8 | a SKU, its category, and its unit cost |
| `orders` | 638 | one order — 518 paid, 120 **cancelled** |
| `order_items` | 1,273 | one line of one order, with quantity and the price paid |
| `refunds` | 46 | a **partial or full** refund, dated after the order and often in a later month |

## It is deliberately not clean

Every one of these is a way a plausible query returns a confident wrong number. That is the point:
an agent that gets the right answer here has actually read the schema.

| Trap | What a careless query does |
| --- | --- |
| 120 **cancelled** orders | counts them as revenue |
| Refunds are **partial**, and dated after the order | reports gross as though it were net, or puts a refund in the wrong month |
| **One paid order has no line items** (`id 1636`) | `SUM` over an inner join drops it silently |
| **Two customers have no country** | `GROUP BY country` loses them; the totals no longer add up to the whole |
| **43 customers never ordered** | an average per customer over the orders table is an average over the wrong population |
| **Two people share a name** (`Customer 041`) | grouping by name merges two customers into one |
| **Two orders one second either side of `2026-05-01T00:00:00Z`** | an inclusive-vs-exclusive boundary moves revenue between months |

## The answers

Computed from the data, not from memory — `generate.py` prints these and the file is deterministic,
so they cannot drift from what is in `seed.sql`.

| Question | Answer |
| --- | --- |
| Paid orders | **518** |
| Gross revenue on paid orders | **13,775,026 cents** (₹/$137,750.26) |
| Refunded against paid orders | **595,204 cents** |
| **Net revenue** | **13,179,822 cents** |
| Orders with no line items | **1** |
| Customers with no country | **2** |
| Customers who never ordered | **43** |

If an agent answers a revenue question with 13,775,026 it has ignored refunds. If it answers with
anything that counts the 120 cancelled orders, it has ignored `status`. Both are the failure this
project is about: a confident number that nobody checked.

## Rebuilding it

```bash
cd fixtures/warehouse && python3 generate.py
```

Deterministic, on a fixed seed, so the same file comes out every time. Edit the generator rather
than `seed.sql` — a fixture whose contents move can only ever prove that a query ran, never that it
returned the right thing.
