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

const map = await call(obs, "get_service_map");
const services = (map.services ?? map.nodes ?? []).map((s) => s.name ?? s.service ?? s);
console.log("services from observability service map:", JSON.stringify(services));

for (const svc of services) {
  const h = await call(ops, "get_service_health", { service: svc });
  console.log(`\n===== ops-desk get_service_health(${svc}) =====`);
  console.log(JSON.stringify(h, null, 1));
}
await ops.close(); await obs.close();
process.exit(0);
