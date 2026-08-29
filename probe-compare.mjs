import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function mk(port) {
  const c = new Client({ name: "probe", version: "0" }, { capabilities: {} });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return c;
}
async function call(c, name, args = {}) {
  const res = await c.callTool({ name, arguments: args });
  const txt = (res.content ?? []).map((x) => (x.type === "text" ? x.text : "")).join("\n");
  try { return JSON.parse(txt); } catch { return txt; }
}
const ops = await mk(8795);
const obs = await mk(8798);

const metrics = await call(obs, "list_metrics");
console.log("METRIC NAMES:", (metrics.metrics ?? []).map((m) => m.name).join(", "));

for (const service of ["checkout-api", "search-api"]) {
  const health = await call(ops, "get_service_health", { service });
  console.log(`\n################ ${service} ################`);
  for (const metric of ["latency_p99_ms", "error_rate"]) {
    const r = await call(obs, "query_range", {
      metric, service,
      from: "2026-08-26T13:40:00Z", to: "2026-08-26T14:20:00Z",
    });
    const pts = r.points ?? r.series?.[0]?.points ?? r.samples ?? [];
    const byT = new Map(pts.map((p) => [p.at ?? p.t ?? p.timestamp, p.value ?? p.v]));
    console.log(`\n-- ${metric}: obs returned ${pts.length} point(s); ${r.error ? "ERROR " + JSON.stringify(r) : ""}`);
    for (const s of health.series ?? []) {
      const opsVal = metric === "error_rate" ? s.error_rate : s.p99_ms;
      const obsVal = byT.get(s.at);
      const agree = obsVal === undefined ? "obs has no point at this time"
        : Math.abs(Number(obsVal) - Number(opsVal)) < 1e-9 ? "MATCH" : `MISMATCH (ops=${opsVal} obs=${obsVal})`;
      console.log(`   ${s.at}  ops=${String(opsVal).padEnd(8)} obs=${String(obsVal).padEnd(8)} ${agree}`);
    }
  }
}
await ops.close(); await obs.close();
process.exit(0);
