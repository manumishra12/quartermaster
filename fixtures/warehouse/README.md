# warehouse (fixture)

A small orders database for the `analytics` agent. Build it anywhere with SQLite - no server, no
credentials:

```bash
sqlite3 warehouse.db < seed.sql
sqlite3 warehouse.db "SELECT count(*) FROM orders;"
```

That works on a machine with the SQLite command line. **The agent's sandbox does not have one** - it
has python3 and no database binary at all - so in there the same thing is done through the sqlite3
module inside Python:

```bash
python3 -c "import sqlite3;sqlite3.connect('warehouse.db').executescript(open('seed.sql').read())"
python3 -c "import sqlite3;print(sqlite3.connect('warehouse.db').execute('select count(*) from orders').fetchone()[0])"
```

Both build the same database. The distinction is worth keeping straight, because a command that
fails with `sqlite3: command not found` is a command that did not run - not a query that returned
nothing, which is the confusion this agent exists to refuse.

It is deliberately not clean. There are refunds, one cancelled order, customers in three countries,
and a signup that never ordered anything within the window. Questions like "what was revenue in
Q2?" have a right answer and a tempting wrong one, depending on whether refunded and cancelled
orders are counted.

Good questions to ask the agent:

- What was our revenue in Q2 2026?
- Which customers have refunded more than they have kept?
- Which country has the highest average order value?

`amount_cents` is integer cents. Any answer in rupees or dollars has to divide by 100 - another
place a confident wrong number can appear.
