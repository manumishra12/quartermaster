import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [,, port, tool, argsJson] = process.argv;
const client = new Client({ name: "probe", version: "0" }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
await client.connect(transport);
if (tool === "__list__") {
  const { tools } = await client.listTools();
  for (const t of tools) console.log(t.name, "|", JSON.stringify(t.inputSchema?.properties ?? {}).slice(0,300));
} else {
  try {
    const res = await client.callTool({ name: tool, arguments: JSON.parse(argsJson || "{}") });
    console.log("isError:", res.isError === true);
    for (const c of res.content ?? []) console.log(c.type === "text" ? c.text : JSON.stringify(c));
  } catch (e) {
    console.log("THREW:", e?.constructor?.name, e?.message);
  }
}
await client.close();
process.exit(0);
