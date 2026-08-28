# Warehouse

A read-only SQL surface over the orders fixture, so the analytics agent's guarantee about writes
lives outside the model rather than inside its instructions.

## Why it exists

Every other agent here reaches its tools through a connector, so what it can and cannot do is
decided somewhere the model cannot argue with. `analytics` had no `mcp_servers` at all. Its SQL ran
through a Python heredoc in the sandbox shell, and the shell is not gated. Its own skill says so:

> the shell is not gated. There is no approval prompt between you and a `DELETE`. Whatever pause
> you keep before a write is one you are keeping yourself.

That is the model policing itself, which is the hole this whole project exists to close. Everywhere
else the guarantee is a mechanism. For SQL it was a promise, written in a document the model reads
and can therefore be argued out of. This server makes it a mechanism.

```bash
npm run warehouse             # http://localhost:8797/mcp
curl -s localhost:8797/health
```

It needs the fixture built first, because `fixtures/warehouse/*.db` is gitignored on purpose - the
database is generated from a seed that **is** checked in, so it can never drift from the answers
the fixture's README publishes:

```bash
cd fixtures/warehouse && sqlite3 warehouse.db < seed.sql
# or, on a machine with no sqlite3 binary:
cd fixtures/warehouse && python3 - <<'SQL'
import sqlite3
db = sqlite3.connect('warehouse.db')
db.executescript(open('seed.sql').read())
db.commit()
SQL
```

Register it once, then `npm run agents:apply`:

```bash
curl -X POST http://localhost:8790/api/v1/settings/mcp-servers \
  -H 'content-type: application/json' \
  -d '{"manifest":{"type":"remote","name":"warehouse","url":"http://localhost:8797/mcp",
       "description":"A read-only SQL surface over the orders warehouse. Every tool is a read, enforced by the connection rather than by the tool."}}'
```

## The two layers, and whose job is whose

This is the whole design, and getting the two the wrong way round is how it would quietly stop
working.

**1. The read-only connection is the guarantee.** `new DatabaseSync(path, { readOnly: true })` makes
SQLite itself refuse the write. It does not care what the model was persuaded of, what a row in the
data claimed, or what the user said was pre-approved. Verified refused on this connection, each one
with `attempt to write a readonly database`:

`DELETE`, `CREATE TABLE`, `CREATE TABLE AS SELECT`, `INSERT OR REPLACE`, `REPLACE INTO`,
`DROP TABLE`, `ALTER TABLE`, `CREATE INDEX`, `CREATE VIEW`, `UPDATE ... RETURNING`, `REINDEX`,
`ANALYZE`, `VACUUM`, `PRAGMA journal_mode=WAL`.

That is far stronger than matching statement keywords with a regular expression. A blacklist of
verbs is only ever as good as the last person who remembered to extend it, which is exactly the
"reciting the list" failure `sql-analysis` warns about.

**2. The statement check is the residue, not the boundary.** It exists for the small set of things a
read-only connection still permits. Its job is not to be the security boundary, and a reader who
thinks it is will improve it into one - at which point the value of layer 1, which is that it does
not depend on how good layer 2 is, has been quietly spent.

The test suite proves the two apart. `WITH x AS (SELECT 1) DELETE FROM orders` is legal SQLite, and
the allowlist admits it: the check looks at the first keyword, sees `WITH`, and lets it through **on
purpose**. What refuses it is the connection underneath. If that test ever starts failing with
`not_a_read` instead of `readonly database`, the two layers have collapsed into one and nobody is
checking the one that matters.

## The leak, which is why layer 2 is here at all

**`VACUUM INTO '/tmp/z.db'` succeeds on a read-only connection.**

It does not modify the source database. It writes a complete copy of it somewhere else. Confirmed
by opening the copy afterwards: all 638 orders, every table, in a file at a path the caller chose.

So "read-only" means *cannot modify this database*. It does not mean *cannot write to disk*, and it
does not mean the warehouse cannot leave the building. An agent that had been talked into
exfiltrating the data would have found the door open, on a connection whose whole selling point is
that it is shut. There is a test for it that asserts the file does not appear.

Three more things a read-only connection permits, found while checking whether `VACUUM INTO` was the
only one:

| Permitted | What it means |
| --- | --- |
| `ATTACH DATABASE '<a file that exists>'` | Its tables become queryable through this connection, so any readable SQLite file on the host is reachable. Attaching a path that does *not* exist fails, which is what makes ATTACH look refused if that is the only way you test it. |
| `CREATE TEMP TABLE ... AS SELECT`, `CREATE TEMP VIEW`, `CREATE TEMP TRIGGER`, and `INSERT` into a temp table | They live in the temp schema rather than in the warehouse, so nothing here is modified. But "the connection is read-only" plainly does not mean "no statement can create an object". |
| `PRAGMA temp_store_directory = '/somewhere'` | A caller choosing where SQLite writes, which pairs with the temp tables above. No file was observed landing there at fixture scale, so this is recorded as permitted rather than as a demonstrated leak. |

## What the allowlist actually admits

An allowlist rather than a blacklist, for the reason the skill gives about reads and writes being a
category: a blacklist has to name every way of writing, and an allowlist has to name every way of
reading, of which there are four.

| Form | Admitted |
| --- | --- |
| `SELECT ...` | yes |
| `WITH ... ` | yes, without proving the statement after the CTE list is a SELECT. `WITH ... DELETE` is a write, and layer 1 refuses it. |
| `VALUES (...)` | yes |
| `EXPLAIN` / `EXPLAIN QUERY PLAN` of one of the above | yes. `EXPLAIN` does not execute what it explains - `EXPLAIN VACUUM INTO` writes no file - but it is required to prefix a read anyway, because `EXPLAIN DELETE FROM orders` answering happily is a reply an agent can misread. |
| `PRAGMA table_info`, `table_xinfo`, `table_list`, `index_list`, `index_info`, `foreign_key_list` | yes, named individually. A PRAGMA is a read or a write depending on its argument, so the first keyword cannot decide it. |
| `PRAGMA anything = anything` | no. Setting is a write, however harmless the pragma sounds. |
| `PRAGMA database_list` | no. It reads nothing but metadata and prints the absolute filesystem path of every attached database, and this server has no reason to hand those to a model. |
| Two statements | no. See below. |

## Two statements are never one

`db.exec()` runs every statement in the string, and a `--` comment does not stop it: verified,
`SELECT 1 -- x\n; VACUUM INTO '/tmp/z.db'` wrote the file. **This server never calls `exec`.**

`db.prepare()` is not the safe alternative it looks like. It will execute a `VACUUM INTO` quite
happily; what it does with a *second* statement is compile the first and silently discard the rest.
`sourceSQL` for `SELECT 1 AS a; SELECT 2 AS b` comes back as `SELECT 1 AS a;`. Nothing runs, so it
is not dangerous - but the agent asked two questions, got one answer, and was never told which one
it was looking at. That is the same shape of quiet wrong answer as everything else here, so multiple
statements are refused rather than half-executed.

The scanner strips comments and quoted text before counting semicolons, which is what makes both
directions right: a second statement hidden behind `--` is caught, and `WHERE note = 'a;b'` is one
statement rather than a lecture.

## Pagination, and the flag that is not there to be skimmed past

A result that does not fit comes back as a page:

```json
{
  "rows_returned": 100,
  "truncated": true,
  "next_offset": 100,
  "note": "Rows 0 to 99 of a longer result. This is not the whole answer: do not total or average these rows..."
}
```

A partial result silently reported as complete is a false number arrived at honestly, which is the
single thing this project is about. So the flag is explicit and the note says what the rows must not
be used for.

Truncation is known rather than guessed: one row more than the limit is pulled and thrown away, so a
result of *exactly* the limit reports `truncated: false`. Inferring it from `rows.length === limit`
would send an agent to fetch a page that does not exist and then let it read the empty page as a
finding.

Which is also why a page past the end says so in its own words rather than coming back as an empty
result. Those are two different facts:

| What happened | What comes back |
| --- | --- |
| The query matched nothing | `rows_returned: 0`, `note: "The complete result."` |
| The page is past the end of a shorter result | `rows_returned: 0`, `rows_skipped: 4`, `note: "...this page is past the end of it. That is not the same as a query that matched nothing."` |
| The statement failed | `error: "query_failed"` with the SQLite message quoted, and a sentence saying it did not run |

The last row is `sql-analysis` Step 4 made enforceable: a query that ran and found nothing, a query
that failed, and a command that never ran are three different answers and must never be reported as
one.

## Binding, because Step 3b asks for it

```json
{ "sql": "SELECT count(*) FROM orders WHERE status = ?", "params": ["paid"] }
{ "sql": "SELECT count(*) FROM orders WHERE status = :status", "params": { "status": "paid" } }
```

The reply carries `executed_sql` with the values substituted, because the query worth showing beside
an answer is the one that ran.

A placeholder nobody supplied is refused. That is not tidiness: node:sqlite binds NULL for a missing
placeholder and says nothing, so `SELECT ?, ?` with one argument comes back with NULL in the second
column, and a `WHERE status = ?` that quietly became `= NULL` matches no row. No rows then reads as
a fact about the data rather than as a mistake in the call.

Identifiers cannot be bound in any database, so `describe_table` and `profile_table` check the name
against the list of tables read from the schema rather than concatenating it, exactly as Step 3b
says to.

## The tools, and which side of the gate they sit on

| Tool | Annotation | Gated |
| --- | --- | --- |
| `list_tables` | `readOnlyHint` | no |
| `describe_table` | `readOnlyHint` | no |
| `profile_table` | `readOnlyHint` | no |
| `run_query` | `readOnlyHint` | no |
| `explain_query` | `readOnlyHint` | no |

Every tool publishes annotations, and on this server that is the *only* thing that could go wrong
with the policy, because there is nothing here to gate. The selectors `@read-only`, `@write` and
`@destructive` are resolved from these hints; a tool that publishes none matches none of them and
runs ungated. The shipped deepwiki server publishes zero, which is the fail-open hole `SECURITY.md`
describes.

### What approval means for a server where everything is a read

The spec declares this:

```json
"enable_tools": ["list_tables", "describe_table", "profile_table", "run_query", "explain_query"],
"require_approval_for_tools": ["@write", "@destructive"]
```

Both halves are deliberate.

**The approval policy gates nothing today, and it is still the right policy.** Every tool here is a
read, so `@write` and `@destructive` match none of them and no call pauses. Writing `[]` instead
would say the same thing about today and a different thing about tomorrow: it is the shape the spec
validator refuses outright, because an empty policy means every tool on the server runs ungated
forever, including one added next week. The tags are a standing instruction - *if a write ever
appears on this connector, it stops for a person* - and they cost nothing to keep. An approval
prompt in front of a read would be worse than useless: it teaches the operator that the prompt is
noise, and the next one they wave through is a rollback.

**The admission list is where this connector actually fails closed.** Naming all five tools rather
than reaching them with `@read-only` means a tool this server grows later is not enabled at all -
not enabled and unannotated, not enabled and gated by a tag that happens to match. It has to be
added to the spec by somebody who thought about it. That is this project's stated preference over
relying on the gate, and it is the half that does real work here.

`npm run tools:audit` prints what each connector actually publishes and what each agent's policy
would let through.

## What it refuses

| Attempt | Answer |
| --- | --- |
| Any write to this database, however spelled | refused by SQLite, reported as `query_failed` quoting `attempt to write a readonly database` |
| `VACUUM INTO '<path>'` | `not_a_read`, and no copy is written. The read-only connection would have allowed it |
| `ATTACH DATABASE` | `not_a_read` - it succeeds on a read-only connection for any file that exists |
| Two statements, including one hidden behind a comment | `multiple_statements` - prepare would compile the first and discard the second in silence |
| A statement whose quoting cannot be resolved | `unreadable_sql` - if it cannot see where a string ends it cannot see where the statement ends, and either verdict would be a guess |
| A PRAGMA that sets anything | `not_a_read`, naming the ones that only report |
| A placeholder with no value supplied | `parameter_mismatch` - an unsupplied placeholder binds NULL without a word |
| A table name this database does not have | `unknown_table`, naming the ones it does, including for `constructor` and `__proto__` |
| More SQL than anyone writes, or a limit above 1000 | refused by the schema, before the handler is reached |
| A database that is not this fixture | the server refuses to start |

That last one deserves its own sentence. An empty file opens read-only without complaint and answers
every query with nothing, so serving one would make `list_tables` return an empty list and an agent
read it as a warehouse with no tables in it - a confident wrong answer from a server that never
failed. The same failure as an empty log search reading as a quiet service, which `ops-desk` refuses
for the same reason.

## What `profile_table` is for

`sql-analysis` Step 1b asks for a profile before anybody trusts a number, and then admits it is five
hand-written queries per table. This is that in one call: row count, NULLs and distinct values per
column, the smallest and largest value in every column, and orphans across every foreign key **in
both directions**.

The second direction is the one worth having. The skill calls it the trap that catches everybody:

```
"joins": [
  { "direction": "outbound", "column": "customer_id", "references": "customers.id", "orphans": 0 },
  { "direction": "inbound",  "referenced_by": "order_items.order_id", "rows_here_with_none": 1 }
]
```

One order has no line items. An inner join drops it, the total is wrong, and nothing anywhere says
so. Nothing about `orders` read on its own would have told you.

## The answers the fixture publishes

Computed by `fixtures/warehouse/generate.py` from a fixed seed, written into that fixture's README,
and asserted here through the connector so the two cannot drift apart:

| Question | Answer |
| --- | --- |
| Paid orders | 518 |
| Gross revenue on paid orders | 13,775,026 cents |
| Refunded against paid orders | 595,204 cents |
| Net revenue | 13,179,822 cents |

An agent that answers a revenue question with 13,775,026 has ignored the refunds. Anything that
counts the 120 cancelled orders has ignored `status`. Both are a confident number nobody checked,
which is the failure the fixture was built to catch and the reason the connector serves it.

## Notes for anyone extending it

- **Read the two-layer note at the top of `server.mjs` before touching the statement check.** It is
  the residue, not the boundary. Every temptation to make it thorough is a temptation to make layer
  1 look optional.
- **Do not call `db.exec`.** It runs every statement in the string. A test asserts the source never
  does.
- **If you add a tool, give it annotations.** An unannotated tool matches no selector and runs
  ungated, and here it would also want adding to `enable_tools` by hand, which is the point.
- **There is no query timeout.** node:sqlite exposes no way to interrupt a running statement, so a
  cartesian join would block the event loop until it finished. `iterate` stops pulling as soon as
  the page is full, which bounds anything that streams rows; an aggregate over a huge cross join is
  not bounded by anything. The fixture is 1,273 line items and this server listens on loopback, so
  that is a stated limitation rather than a fixed one.
- **The database is opened once and never reopened.** Nothing here mutates, so there is no state to
  keep between requests - unlike the other two servers, restarting this one changes nothing.
- **`/health` deliberately does not publish the database path.** It is unauthenticated, and an
  absolute filesystem path is the one thing on it that is useful to somebody who should not have it.
