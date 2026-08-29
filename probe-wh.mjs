import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "probe", version: "0" }, { capabilities: {} });
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8797/mcp")));

const cases = [
  ["WRITE: insert", "INSERT INTO orders (id) VALUES (999999)"],
  ["WRITE: update", "UPDATE orders SET total_cents = 0"],
  ["WRITE: delete", "DELETE FROM orders"],
  ["WRITE: drop table", "DROP TABLE orders"],
  ["WRITE: create table", "CREATE TABLE probe_x (a int)"],
  ["WRITE: attach db", "ATTACH DATABASE '/tmp/probe.db' AS p"],
  ["WRITE: pragma", "PRAGMA writable_schema = 1"],
  ["MULTI: select; drop", "SELECT 1; DROP TABLE orders;"],
  ["MULTI: two selects", "SELECT 1; SELECT 2;"],
  ["MULTI: trailing semicolon only", "SELECT 1;"],
  ["SYNTAX: garbage", "SELEKT * FROM orders"],
  ["SYNTAX: unbalanced paren", "SELECT * FROM orders WHERE (id = 1"],
  ["SYNTAX: unknown table", "SELECT * FROM no_such_table"],
  ["SYNTAX: unknown column", "SELECT no_such_col FROM orders"],
  ["empty sql", ""],
  ["comment-hidden write", "SELECT 1 -- \nUNION SELECT 2"],
  ["CTE write", "WITH x AS (SELECT 1) DELETE FROM orders"],
];

for (const [label, sql] of cases) {
  console.log(`##### ${label}\n      sql: ${JSON.stringify(sql)}`);
  try {
    const res = await client.callTool({ name: "run_query", arguments: { sql } });
    console.log("  isError:", res.isError === true);
    for (const c of res.content ?? []) {
      const t = c.type === "text" ? c.text : JSON.stringify(c);
      console.log("  " + t.split("\n").slice(0, 8).join("\n  "));
    }
  } catch (e) {
    console.log("  THREW:", e?.constructor?.name, "|", e?.message);
  }
  console.log();
}
await client.close();
process.exit(0);
