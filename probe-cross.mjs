import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function mk(port) {
  const c = new Client({ name: "probe", version: "0" }, { capabilities: {} });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return c;
}
const ops = await mk(8795);
const obs = await mk(8798);

async function call(c, name, args = {}) {
  const res = await c.callTool({ name, arguments: args });
  const txt = (res.content ?? []).map((x) => (x.type === "text" ? x.text : "")).join("\n");
  try { return JSON.parse(txt); } catch { return txt; }
}

const out = {};
out.ops_alerts = await call(ops, "list_alerts");
out.ops_deploys = await call(ops, "list_deploys");
out.obs_metrics = await call(obs, "list_metrics");
out.obs_alert_rules = await call(obs, "list_alert_rules");
out.obs_annotations = await call(obs, "list_annotations");
out.obs_service_map = await call(obs, "get_service_map");
out.ops_actions = await call(ops, "list_actions_taken");

console.log(JSON.stringify(out, null, 2));
await ops.close(); await obs.close();
process.exit(0);
