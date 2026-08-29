import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/**
 * The warehouse, tested through the wire rather than by importing it.
 *
 * Most of this file is refusals, and that is the point. The server exists because the analytics
 * agent's only protection against a DELETE was its own resolve, so what has to be proved is not
 * that a SELECT works - it is that the things which are not SELECTs cannot happen, including the
 * ones a read-only connection lets through.
 *
 * The order the checks are proved in matters as much as the checks. The read-only connection is
 * the guarantee and the statement check is the residue, so there is a test below that submits a
 * write the statement check deliberately admits, purely to show SQLite refusing it underneath.
 * If that test ever passes for the other reason, the two layers have collapsed into one.
 */

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));
const SEED = fileURLToPath(new URL('../../fixtures/warehouse/seed.sql', import.meta.url));

/**
 * The database is built here, from the seed that is checked in, into a directory of this run's own.
 *
 * `fixtures/warehouse/*.db` is gitignored, so a test that needed the developer's copy would pass
 * on this machine and fail on a fresh clone. Building it from `seed.sql` also pins the connector to
 * the fixture: the published answers below are computed by `generate.py` and written into the
 * fixture's README, and if the seed and the server ever stop agreeing about them this file goes
 * red rather than the demo going wrong on camera.
 */
const workspace = mkdtempSync(join(tmpdir(), 'warehouse-test-'));
const DB = join(workspace, 'warehouse.db');
{
  const build = new DatabaseSync(DB);
  build.exec(readFileSync(SEED, 'utf8'));
  build.close();
}
after(() => rmSync(workspace, { recursive: true, force: true }));

/**
 * A server per test, and the OS picks the port.
 *
 * Nothing here mutates, so the servers could in principle be shared - but a fixed port collides
 * with a copy left over from a manual run, and one process per test costs a second and removes
 * every question about what the previous test left behind.
 */
async function startServer(env = {}) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: { ...process.env, WAREHOUSE_PORT: '0', WAREHOUSE_HOST: '127.0.0.1', WAREHOUSE_DB: DB, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const port = await new Promise((resolve, reject) => {
    // Accumulate rather than matching per chunk: stdout arrives in whatever pieces the OS feels
    // like, and an announcement split across two of them times out against a healthy server.
    let seen = '';
    const done = (error, value) => {
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(() => done(new Error('warehouse did not report a port within 10s')), 10_000);

    child.stdout.on('data', (chunk) => {
      seen += String(chunk);
      const match = /listening on http:\/\/localhost:(\d+)\//.exec(seen);
      if (match) done(null, Number(match[1]));
    });
    child.on('error', (error) => done(error));
    child.on('exit', (code) => done(new Error(`warehouse exited with code ${code} before reporting a port`)));
  });

  /**
   * Connect to the address the server bound, not to a name that may resolve elsewhere.
   *
   * The banner prints "localhost" because that is the URL the README and the connector
   * registration use, but on a host where localhost is ::1 first - most Linux CI - that is a
   * different address with nothing listening. The Host header stays "localhost", so the server's
   * own rebinding check is still exercised.
   */
  const endpoint = `http://127.0.0.1:${port}/mcp`;

  /** One JSON-RPC call. The transport answers as an SSE frame, so the payload needs unwrapping. */
  async function call(method, params) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    const body = await res.text();
    const line = body.split('\n').find((l) => l.startsWith('data: '));
    return JSON.parse(line ? line.slice(6) : body);
  }

  /** Tool results arrive as text content; every one of these returns JSON inside it. */
  async function callTool(name, args = {}) {
    const response = await call('tools/call', { name, arguments: args });
    return JSON.parse(response.result.content[0].text);
  }

  const health = async () =>
    (await fetch(`http://127.0.0.1:${port}/health`, { headers: { host: 'localhost' } })).json();

  return { call, callTool, health, stop: () => child.kill() };
}

/** Run one test against its own server, and take it down afterwards whatever happens. */
async function withServer(body, env) {
  const server = await startServer(env);
  try {
    await body(server);
  } finally {
    server.stop();
  }
}

test('every tool publishes annotations, and every one of them is a read', () =>
  withServer(async ({ call }) => {
    const { result } = await call('tools/list');
    assert.equal(result.tools.length, 5);

    for (const tool of result.tools) {
      /**
       * The selectors are resolved from these hints, so a tool that publishes none matches neither
       * @read-only nor @destructive and runs with no gate at all. That is this project's headline
       * finding about the shipped connectors, and it would be a poor thing to reintroduce in a
       * server written after it.
       */
      assert.ok(tool.annotations, `${tool.name} publishes no annotations`);
      assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} must be readOnlyHint`);
      assert.equal(tool.annotations.destructiveHint, false, `${tool.name} must not be destructive`);
    }

    assert.deepEqual(
      result.tools.map((t) => t.name).sort(),
      ['describe_table', 'explain_query', 'list_tables', 'profile_table', 'run_query'],
    );
  }));

test('the read-only connection is the guarantee, and it is doing the work on its own', () =>
  withServer(async ({ callTool }) => {
    /**
     * The most important test in this file.
     *
     * `WITH x AS (...) DELETE FROM ...` is legal SQLite, and the statement check admits it: the
     * allowlist looks at the first keyword, sees WITH, and lets it through. It is admitted on
     * purpose. Layer 2 is not the security boundary, and it does not need to parse a CTE to know
     * where the statement ends up - because layer 1 refuses every write to this database whatever
     * it is spelled like, and cannot be argued out of it.
     *
     * So this is the write that reaches SQLite, and SQLite is what stops it. If this ever comes
     * back with `not_a_read` instead, the statement check has grown into the boundary and the
     * thing this file is meant to prove is no longer being proved.
     */
    for (const sql of [
      'WITH x AS (SELECT 1) DELETE FROM orders',
      "WITH x AS (SELECT 1) UPDATE orders SET status = 'x'",
      "WITH x AS (SELECT 1001 id) INSERT INTO orders (id, customer_id, placed_at, status, channel) SELECT id, 1, 'x', 'paid', 'web' FROM x",
    ]) {
      const refused = await callTool('run_query', { sql });
      assert.equal(refused.error, 'query_failed', sql);
      assert.match(refused.sqlite_error, /readonly database/, sql);
    }

    // And the rows are all still there afterwards.
    const after = await callTool('run_query', { sql: 'SELECT count(*) AS c FROM orders' });
    assert.equal(after.rows[0].c, 638);
  }));

test('every write form is refused, and the database is untouched', () =>
  withServer(async ({ callTool }) => {
    /**
     * The list `sql-analysis` Step 3 says is a category rather than a list. Each of these is
     * refused before it reaches the database because it is not a read; each would also have been
     * refused by the connection underneath. Both layers holding is the design, and a test that
     * only proved one of them would not notice the other going away.
     */
    for (const sql of [
      'DELETE FROM orders',
      'DROP TABLE orders',
      'CREATE TABLE z (a INTEGER)',
      'CREATE TABLE z AS SELECT * FROM orders',
      "INSERT OR REPLACE INTO orders (id) VALUES (1)",
      "REPLACE INTO orders (id) VALUES (1)",
      "UPDATE orders SET status = 'x' RETURNING id",
      'ALTER TABLE orders ADD COLUMN q INTEGER',
      'CREATE INDEX ix ON orders (status)',
      'PRAGMA journal_mode = WAL',
      'BEGIN',
      'VACUUM',
      'REINDEX',
      'ANALYZE',
    ]) {
      const refused = await callTool('run_query', { sql });
      assert.equal(refused.error, 'not_a_read', sql);
    }

    const rows = await callTool('run_query', { sql: 'SELECT count(*) AS c FROM orders' });
    assert.equal(rows.rows[0].c, 638);
  }));

test('a pragma table-valued function is refused however the name is quoted', () =>
  withServer(async ({ callTool }) => {
    /**
     * The first fix matched `pragma_` against the bare syntax, which blanks every quoted run - so
     * `SELECT * FROM "pragma_database_list"` had the name blanked out of the text being checked,
     * passed as an ordinary SELECT, and the raw statement then ran and returned the absolute path
     * of the database file. SQLite dequotes an identifier before resolving it; the guard did not.
     *
     * Verified against a running server rather than reasoned about, which is how it was found: all
     * four quoting styles walked straight through, and so did a CTE wrapping one.
     */
    for (const sql of [
      'SELECT * FROM pragma_database_list',
      'SELECT * FROM "pragma_database_list"',
      'SELECT * FROM [pragma_database_list]',
      'SELECT * FROM `pragma_database_list`',
      'WITH x AS (SELECT * FROM [pragma_database_list]) SELECT * FROM x',
      // No separator, which is how the second attempt was walked around: the word boundary died.
      'SELECT * FROM"pragma_database_list"',
      'SELECT * FROM[pragma_database_list]',
      // A single-quoted token, which SQLite reads as an identifier where one is required.
      "SELECT * FROM 'pragma_database_list'",
      'SELECT * FROM pragma_function_list',
    ]) {
      const refused = await callTool('run_query', { sql });
      assert.equal(refused.error, 'not_a_read', sql);
    }

    /**
     * Including the single-quoted form, and that is a deliberate cost rather than an oversight.
     *
     * An earlier version exempted single quotes on the belief that such a run is always a string
     * literal. SQLite does not honour that where an identifier is required, so the exemption was a
     * bypass. Every delimiter is stripped before the scan now, which means a query mentioning the
     * name inside a string is refused too.
     *
     * That is the right side to err on. The alternative is deciding, per position, whether SQLite
     * would read a quoted token as a name - and being wrong about that produced two bypasses in one
     * afternoon.
     */
    const mentioned = await callTool('run_query', { sql: "SELECT 'pragma_database_list' AS mentioned" });
    assert.equal(mentioned.error, 'not_a_read');

    // An ordinary string literal is untouched: only the name is what makes the difference.
    const ordinary = await callTool('run_query', { sql: "SELECT count(*) AS n FROM orders WHERE status = 'paid'" });
    assert.equal(ordinary.rows[0].n, 518);
  }));

test('VACUUM INTO is refused, and no copy of the database appears anywhere', () =>
  withServer(async ({ callTool }) => {
    /**
     * The finding this whole check exists for, and the test that would have caught it.
     *
     * `VACUUM INTO '/tmp/z.db'` SUCCEEDS on a read-only connection. It does not modify the source
     * database - it writes a complete copy of it somewhere else - so every reflex about what
     * read-only protects is wrong about this one statement. Verified before the check existed: the
     * file was there afterwards with all 638 orders in it.
     *
     * Read-only means "cannot modify this database". It does not mean "cannot write to disk", and
     * it does not mean the warehouse cannot leave the building.
     */
    const stolen = join(workspace, 'exfiltrated.db');
    assert.equal(existsSync(stolen), false, 'the test starts with no copy');

    const refused = await callTool('run_query', { sql: `VACUUM INTO '${stolen}'` });
    assert.equal(refused.error, 'not_a_read');
    assert.match(refused.message, /complete copy of this database/);
    assert.equal(existsSync(stolen), false, 'a copy of the warehouse was written to a path the caller chose');

    // Including behind an EXPLAIN, which is admitted as a prefix and must not launder the rest.
    assert.equal((await callTool('run_query', { sql: `EXPLAIN VACUUM INTO '${stolen}'` })).error, 'not_a_read');
    assert.equal(existsSync(stolen), false);

    // And through explain_query, which takes SQL of its own and must apply the same check.
    assert.equal((await callTool('explain_query', { sql: `VACUUM INTO '${stolen}'` })).error, 'not_a_read');
    assert.equal(existsSync(stolen), false);
  }));

test('ATTACH is refused, because a read-only connection will happily attach a file that exists', () =>
  withServer(async ({ callTool }) => {
    /**
     * The other thing layer 1 permits. Attaching a path that does not exist fails - a read-only
     * connection cannot create the file - which is exactly why ATTACH looks refused if that is the
     * only way you test it. Attaching a database that is already there works, and its tables are
     * then queryable through this connection, so any readable SQLite file on the host is reachable.
     */
    const refused = await callTool('run_query', { sql: `ATTACH DATABASE '${DB}' AS copy` });
    assert.equal(refused.error, 'not_a_read');
    assert.match(refused.message, /every readable SQLite file/);

    // Nothing was attached, so nothing is queryable under that name.
    const query = await callTool('run_query', { sql: 'SELECT count(*) AS c FROM copy.orders' });
    assert.equal(query.error, 'query_failed');
    assert.match(query.sqlite_error, /no such table/);
  }));

test('a second statement hidden behind a comment is not run', () =>
  withServer(async ({ callTool }) => {
    /**
     * `db.exec` runs every statement in the string, and a `--` comment does not stop it: verified,
     * `SELECT 1 -- x\n; VACUUM INTO '/tmp/z.db'` wrote the file. This server never calls exec, and
     * the statement scanner strips comments before counting semicolons so the dodge is visible
     * rather than swallowed.
     */
    const stolen = join(workspace, 'hidden.db');

    for (const sql of [
      `SELECT 1 -- innocent\n; VACUUM INTO '${stolen}'`,
      `SELECT 1 /* innocent */ ; DELETE FROM orders`,
      `SELECT 1; SELECT 2`,
      `/* a comment first */ SELECT 1; DROP TABLE orders`,
    ]) {
      const refused = await callTool('run_query', { sql });
      assert.equal(refused.error, 'multiple_statements', JSON.stringify(sql));
    }
    assert.equal(existsSync(stolen), false);

    /**
     * And a semicolon inside a string literal is not a second statement, which is the other half
     * of the same problem: a check that reads quoted text as syntax refuses honest queries, and a
     * refusal an analyst has to work around is a check they route around.
     */
    const honest = await callTool('run_query', { sql: "SELECT 'a;b' AS v, '--' AS w" });
    assert.deepEqual(honest.rows, [{ v: 'a;b', w: '--' }]);

    /**
     * A trailing semicolon is how everybody types it, and a leading one is one statement too.
     * SQLite skips leading separators and compiles what follows, so `; SELECT 1` really does run
     * the SELECT rather than an empty statement - which is the case that would have been a silent
     * empty result, and is checked here rather than assumed.
     */
    assert.equal((await callTool('run_query', { sql: 'SELECT 1 AS a;' })).rows_returned, 1);
    assert.deepEqual((await callTool('run_query', { sql: '; SELECT 1 AS a' })).rows, [{ a: 1 }]);

    // A comment cannot hide the keyword either: the scanner strips it before reading the verb.
    assert.equal((await callTool('run_query', { sql: '/* SELECT */ DELETE FROM orders' })).error, 'not_a_read');
  }));

test('a statement whose quoting cannot be resolved is refused rather than guessed at', () =>
  withServer(async ({ callTool }) => {
    // If the scanner cannot see where a string ends it cannot see where the statement ends, and a
    // verdict either way would be a guess presented as a check.
    const unterminated = await callTool('run_query', { sql: "SELECT 'oops" });
    assert.equal(unterminated.error, 'unreadable_sql');

    const comment = await callTool('run_query', { sql: 'SELECT 1 /* never closed' });
    assert.equal(comment.error, 'unreadable_sql');
  }));

test('only the PRAGMAs that report are allowed, because a PRAGMA is a read or a write by argument', () =>
  withServer(async ({ callTool }) => {
    const info = await callTool('run_query', { sql: "PRAGMA table_info('orders')" });
    assert.equal(info.rows_returned, 5);
    assert.ok(info.rows.some((row) => row.name === 'status'));

    /**
     * `temp_store_directory` is the interesting refusal. It is accepted by a read-only connection,
     * and what it does is choose where SQLite writes - which pairs with the temp tables a read-only
     * connection also permits. Refused here as a write, because setting anything is a write however
     * harmless the pragma sounds.
     */
    for (const sql of [
      "PRAGMA temp_store_directory = '/tmp'",
      'PRAGMA writable_schema = ON',
      'PRAGMA database_list',
      'PRAGMA journal_mode',
    ]) {
      const refused = await callTool('run_query', { sql });
      assert.equal(refused.error, 'not_a_read', sql);
      assert.ok(refused.allowed_pragmas.includes('table_info'));
    }
  }));

test('a page that is not the whole result says so where nobody can miss it', () =>
  withServer(async ({ callTool }) => {
    /**
     * A partial result reported as a complete one is a false number arrived at honestly, which is
     * the single failure this project is about. So the boundaries are pinned rather than assumed.
     *
     * The exact-fit case is the one that goes wrong quietly: a result of exactly `limit` rows is
     * complete, and a server that infers truncation from `rows.length === limit` sends an agent to
     * fetch a page that does not exist and then reports an empty page as a finding.
     */
    const first = await callTool('run_query', { sql: 'SELECT id FROM orders ORDER BY id', limit: 3 });
    assert.equal(first.rows_returned, 3);
    assert.equal(first.truncated, true);
    assert.equal(first.next_offset, 3);
    assert.match(first.note, /not the whole answer/);

    const second = await callTool('run_query', { sql: 'SELECT id FROM orders ORDER BY id', limit: 3, offset: 3 });
    assert.equal(second.rows[0].id, first.rows[2].id + 1, 'the next page must start where the last one stopped');

    // Exactly the limit, and complete.
    const exact = await callTool('run_query', { sql: 'SELECT id FROM orders ORDER BY id LIMIT 3', limit: 3 });
    assert.equal(exact.rows_returned, 3);
    assert.equal(exact.truncated, false);
    assert.equal(exact.next_offset, null);

    // One more than the limit, and truncated.
    const over = await callTool('run_query', { sql: 'SELECT id FROM orders ORDER BY id LIMIT 4', limit: 3 });
    assert.equal(over.truncated, true);

    // The last page: fewer rows than the limit, and nothing after them.
    const last = await callTool('run_query', { sql: 'SELECT id FROM orders ORDER BY id LIMIT 4', limit: 3, offset: 3 });
    assert.equal(last.rows_returned, 1);
    assert.equal(last.truncated, false);

    /**
     * And a page past the end is not an empty result. Those are two different findings and they
     * used to look identical everywhere in this repository; ops-desk refuses an empty log search
     * for the same reason.
     */
    const past = await callTool('run_query', { sql: 'SELECT id FROM orders ORDER BY id LIMIT 4', limit: 3, offset: 9 });
    assert.equal(past.rows_returned, 0);
    assert.equal(past.rows_skipped, 4);
    assert.match(past.note, /past the end/);

    // Which reads differently from a query that genuinely matched nothing.
    const empty = await callTool('run_query', { sql: "SELECT id FROM orders WHERE status = 'refunded'" });
    assert.equal(empty.rows_returned, 0);
    assert.equal(empty.truncated, false);
    assert.match(empty.note, /complete result/);

    // A limit past what the schema allows is refused before the handler is reached.
    await assert.rejects(
      () => callTool('run_query', { sql: 'SELECT 1', limit: 100_000 }),
      'a limit of 100k should not be accepted',
    );
  }));

test('values are bound, and a placeholder nobody supplied is refused rather than bound to NULL', () =>
  withServer(async ({ callTool }) => {
    /**
     * `sql-analysis` Step 3b says values are bound and never pasted, so the tool has to make that
     * possible - and then has to make it safe. node:sqlite binds NULL for a placeholder nobody
     * supplied and says nothing about it: `SELECT ?, ?` with one argument comes back with NULL in
     * the second column. A `WHERE status = ?` that quietly became `= NULL` matches no row, and no
     * row reads as a fact about the data rather than as a mistake in the call.
     */
    const bound = await callTool('run_query', {
      sql: 'SELECT count(*) AS c FROM orders WHERE status = ?',
      params: ['paid'],
    });
    assert.equal(bound.rows[0].c, 518);
    // The query worth showing beside the answer is the one with the values in it.
    assert.match(bound.executed_sql, /status = 'paid'/);

    const named = await callTool('run_query', {
      sql: 'SELECT count(*) AS c FROM orders WHERE status = :status',
      params: { status: 'paid' },
    });
    assert.equal(named.rows[0].c, 518);

    for (const [args, error] of [
      [{ sql: 'SELECT ?, ?', params: ['a'] }, 'parameter_mismatch'],
      [{ sql: 'SELECT ?', params: ['a', 'b'] }, 'parameter_mismatch'],
      [{ sql: 'SELECT ? AS a' }, 'parameter_mismatch'],
      [{ sql: 'SELECT :a, :b', params: { a: 1 } }, 'parameter_mismatch'],
      [{ sql: 'SELECT :a', params: { a: 1, b: 2 } }, 'parameter_mismatch'],
      [{ sql: 'SELECT :a', params: [1] }, 'wrong_parameter_shape'],
      [{ sql: 'SELECT ?', params: { a: 1 } }, 'wrong_parameter_shape'],
      [{ sql: 'SELECT ?, :b', params: ['a'] }, 'mixed_parameters'],
      [{ sql: 'SELECT ?1', params: ['a'] }, 'numbered_parameters'],
    ]) {
      assert.equal((await callTool('run_query', args)).error, error, args.sql);
    }

    /**
     * And a question mark inside a string literal is not a placeholder. This is the counterpart of
     * the semicolon case: the same scanner has to be right about both, or an honest query gets a
     * lecture about parameters it does not have.
     */
    const literal = await callTool('run_query', { sql: "SELECT 'why?' AS v" });
    assert.deepEqual(literal.rows, [{ v: 'why?' }]);

    // A value with an apostrophe in it, which is the boring reason binding matters day to day.
    const obrien = await callTool('run_query', { sql: 'SELECT ? AS name', params: ["O'Brien"] });
    assert.deepEqual(obrien.rows, [{ name: "O'Brien" }]);
  }));

test('the published answers still hold, so the fixture and the connector cannot drift apart', () =>
  withServer(async ({ callTool }) => {
    /**
     * The numbers in `fixtures/warehouse/README.md`, recomputed here through the connector. They
     * are printed by `generate.py` from the same deterministic seed this test builds its database
     * from, so a change to either side that moves them fails here rather than in a demo.
     *
     * They are also the fixture's whole point. 13,775,026 is the gross, and an agent that answers a
     * revenue question with it has ignored the refunds; anything that counts the 120 cancelled
     * orders has ignored `status`. Both are a confident number nobody checked.
     */
    const paid = await callTool('run_query', {
      sql: 'SELECT count(*) AS c FROM orders WHERE status = ?',
      params: ['paid'],
    });
    assert.equal(paid.rows[0].c, 518);

    const revenue = await callTool('run_query', {
      sql: `SELECT (SELECT sum(i.quantity * i.unit_price_cents)
                      FROM order_items i JOIN orders o ON o.id = i.order_id
                     WHERE o.status = 'paid') AS gross,
                   (SELECT sum(r.amount_cents)
                      FROM refunds r JOIN orders o ON o.id = r.order_id
                     WHERE o.status = 'paid') AS refunded`,
    });
    assert.equal(revenue.rows[0].gross, 13_775_026);
    assert.equal(revenue.rows[0].refunded, 595_204);
    assert.equal(revenue.rows[0].gross - revenue.rows[0].refunded, 13_179_822);
    assert.equal(revenue.truncated, false, 'an aggregate must never come back as a page of a longer result');
  }));

test('list_tables and describe_table say what is there, exactly', () =>
  withServer(async ({ callTool, health }) => {
    const { tables } = await callTool('list_tables');
    assert.deepEqual(
      tables.map((t) => `${t.name}:${t.rows}`).sort(),
      ['customers:180', 'order_items:1273', 'orders:638', 'products:8', 'refunds:46'],
    );

    const orders = await callTool('describe_table', { table: 'orders' });
    assert.equal(orders.rows, 638);
    assert.deepEqual(
      orders.columns.map((c) => c.name),
      ['id', 'customer_id', 'placed_at', 'status', 'channel'],
    );
    assert.deepEqual(orders.foreign_keys, [{ column: 'customer_id', references: 'customers.id' }]);
    // The DDL carries the fixture's own comments, which say things a schema cannot.
    assert.match(orders.ddl, /Cancelled is not revenue/);

    // The one nullable column in the fixture is nullable on purpose, and reads as such.
    const customers = await callTool('describe_table', { table: 'customers' });
    const country = customers.columns.find((c) => c.name === 'country');
    assert.equal(country.nullable, true);

    // An unknown table is answered, not thrown, and names what does exist.
    const missing = await callTool('describe_table', { table: 'ordrs' });
    assert.equal(missing.error, 'unknown_table');
    assert.ok(missing.known.includes('orders'));

    // Including for a name off the prototype chain, which is truthy on any plain object lookup.
    for (const name of ['toString', 'constructor', '__proto__']) {
      assert.equal((await callTool('describe_table', { table: name })).error, 'unknown_table', name);
    }

    // /health reports the live registry rather than a hand-written number, and no filesystem path.
    const status = await health();
    assert.deepEqual(status, { ok: true, tools: 5, read_only: true, tables: 5 });
  }));

test('profile_table finds the traps the fixture was built around', () =>
  withServer(async ({ callTool }) => {
    /**
     * `sql-analysis` Step 1b asks for a profile before anybody trusts a number, and then admits it
     * is five hand-written queries per table. This is the tool that makes following that advice
     * cost one call, so the test is that the profile actually surfaces the fixture's traps rather
     * than merely running.
     */
    const customers = await callTool('profile_table', { table: 'customers' });
    assert.equal(customers.rows, 180);

    // Two customers have no country, so a GROUP BY country silently loses them.
    const country = customers.columns.find((c) => c.column === 'country');
    assert.equal(country.nulls, 2);

    // The date range, which is what tells you a window returning nothing is outside the data.
    const signup = customers.columns.find((c) => c.column === 'signed_up_at');
    assert.match(signup.smallest, /^2026-/);
    assert.ok(signup.largest > signup.smallest);

    // 43 customers never ordered, which is the inbound orphan count on customers.
    const neverOrdered = customers.joins.find((j) => j.referenced_by === 'orders.customer_id');
    assert.equal(neverOrdered.rows_here_with_none, 43);

    /**
     * And the trap the skill calls the one that catches everybody, in the direction that hurts:
     * one order has no line items at all, so an inner join drops it and the total is wrong with
     * nothing anywhere saying so.
     */
    const orders = await callTool('profile_table', { table: 'orders' });
    const withoutItems = orders.joins.find((j) => j.referenced_by === 'order_items.order_id');
    assert.equal(withoutItems.rows_here_with_none, 1);

    // Nothing in this fixture is an outbound orphan, and the profile has to say that too.
    assert.ok(orders.joins.some((j) => j.direction === 'outbound' && j.orphans === 0));

    assert.equal((await callTool('profile_table', { table: 'nope' })).error, 'unknown_table');
  }));

test('explain_query plans without running, and refuses what run_query refuses', () =>
  withServer(async ({ callTool }) => {
    const plan = await callTool('explain_query', {
      sql: 'SELECT * FROM orders WHERE status = ?',
      params: ['paid'],
    });
    assert.ok(plan.plan.length > 0);
    assert.match(plan.plan[0].detail, /orders/);
    assert.match(plan.note, /not the result/);

    // The same statement check, on a tool that takes SQL of its own.
    assert.equal((await callTool('explain_query', { sql: 'DELETE FROM orders' })).error, 'not_a_read');
    assert.equal((await callTool('explain_query', { sql: 'SELECT 1; SELECT 2' })).error, 'multiple_statements');
    assert.equal((await callTool('explain_query', { sql: 'SELECT ?' })).error, 'parameter_mismatch');
  }));

test('a failed query is not an empty result, and says which it was', () =>
  withServer(async ({ callTool }) => {
    /**
     * `sql-analysis` Step 4: the query ran and found nothing, the query failed, and the command
     * never ran are three different answers that must never be reported as one. A tool that threw
     * would hand the agent a transport failure, which is the third wearing the clothes of the
     * second.
     */
    const broken = await callTool('run_query', { sql: 'SELECT nope FROM orders' });
    assert.equal(broken.error, 'query_failed');
    assert.match(broken.sqlite_error, /no such column: nope/);
    assert.match(broken.message, /not the same as a query that ran and found nothing/);

    const nothing = await callTool('run_query', { sql: "SELECT id FROM orders WHERE channel = 'carrier pigeon'" });
    assert.equal(nothing.rows_returned, 0);
    assert.equal(nothing.error, undefined);

    // And an empty request is neither of those.
    assert.equal((await callTool('run_query', { sql: '   ' })).error, 'empty_query');
    assert.equal((await callTool('run_query', { sql: '-- just a comment' })).error, 'empty_query');
  }));

test('the server refuses to serve a database that is not this fixture', () => {
  /**
   * An empty file opens read-only without complaint and answers every query with nothing. Served
   * that way, `list_tables` comes back empty and an agent reads it as a warehouse with no tables -
   * a confident wrong answer from a server that never failed. The same shape as an empty log
   * search reading as a quiet service, which ops-desk refuses for the same reason.
   */
  const empty = join(workspace, 'empty.db');
  new DatabaseSync(empty).close();

  return assert.rejects(
    () => startServer({ WAREHOUSE_DB: empty }),
    /exited with code 1/,
    'a database with none of the fixture tables must not be served as though it were the warehouse',
  );
});

test('the default port is the one the documentation names', () => {
  // A default that disagrees with the docs sends anyone following them to a health check that
  // fails and a connector registered at an address nothing is listening on.
  assert.match(readFileSync(SERVER, 'utf8'), /WAREHOUSE_PORT \?\? 8797/);
});

test('nothing in this server ever calls exec, which is the door VACUUM INTO went through', () => {
  /**
   * `db.exec` runs every statement it is given, comments and all. `db.prepare` compiles the first
   * and discards the rest. Neither is safe on its own - prepare will execute a VACUUM INTO quite
   * happily - but the blast radius of a bypassed statement check is one statement rather than
   * every statement, and that is worth keeping.
   */
  const source = readFileSync(SERVER, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(source, /\bdb\.exec\(/, 'exec runs every statement in the string, including a hidden second one');
});
