import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const c = new Client({ name: "probe", version: "0" }, { capabilities: {} });
await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8795/mcp")));
async function call(name, args = {}) {
  const res = await c.callTool({ name, arguments: args });
  const txt = (res.content ?? []).map((x) => (x.type === "text" ? x.text : "")).join("\n");
  try { return JSON.parse(txt); } catch { return txt; }
}
const show = (l, v) => console.log(`\n===== ${l} =====\n` + JSON.stringify(v, null, 1));

show("current deploys", await call("list_deploys"));
show("rollback a deploy id that no longer exists (4c21)", await call("rollback_deploy", { deploy_id: "4c21", service: "checkout-api", reason: "probe" }));
show("rollback a deploy id that never existed", await call("rollback_deploy", { deploy_id: "zzzz", service: "checkout-api", reason: "probe" }));
show("rollback wrong service for deploy", await call("rollback_deploy", { deploy_id: "1de9", service: "checkout-api", reason: "probe" }));

show("A) resolve_alert while still unhealthy", await call("resolve_alert", { alert_id: "ALRT-4471", resolution: "probe: rolled back" }));
show("resolve an already-resolved alert", await call("resolve_alert", { alert_id: "ALRT-4455", resolution: "probe" }));
show("resolve an alert that does not exist", await call("resolve_alert", { alert_id: "ALRT-9999", resolution: "probe" }));

show("B) restart_service(checkout-api)", await call("restart_service", { service: "checkout-api", reason: "probe: clearing readings" }));
show("health after restart", await call("get_service_health", { service: "checkout-api" }));
show("C) resolve_alert after restart wiped the series", await call("resolve_alert", { alert_id: "ALRT-4471", resolution: "probe: restarted" }));
show("journal", await call("list_actions_taken"));

await c.close();
process.exit(0);
