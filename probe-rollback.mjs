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
const show = (l, v) => console.log(`\n===== ${l} =====\n` + JSON.stringify(v, null, 1));

show("BEFORE ops get_service_health(checkout-api)", await call(ops, "get_service_health", { service: "checkout-api" }));
show("BEFORE ops get_alert(ALRT-4471)", await call(ops, "get_alert", { alert_id: "ALRT-4471" }));

const which = process.argv[2] ?? "4c21";
show(`rollback_deploy(${which})`, await call(ops, "rollback_deploy", { deploy_id: which, service: "checkout-api", reason: "probe: verifying recovery signal" }));

show("AFTER ops get_service_health(checkout-api)", await call(ops, "get_service_health", { service: "checkout-api" }));
show("AFTER ops list_deploys", await call(ops, "list_deploys"));
show("AFTER ops get_alert(ALRT-4471)", await call(ops, "get_alert", { alert_id: "ALRT-4471" }));
show("AFTER ops list_actions_taken", await call(ops, "list_actions_taken"));

const r = await call(obs, "query_range", {
  metric: "error_rate", service: "checkout-api",
  from: "2026-08-26T14:00:00Z", to: "2026-08-26T14:20:00Z",
});
show("AFTER obs query_range error_rate checkout-api", r);
show("AFTER obs list_annotations", await call(obs, "list_annotations", { service: "checkout-api" }));

await ops.close(); await obs.close();
process.exit(0);
