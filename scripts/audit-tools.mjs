/**
 * Audits the approval policy against reality.
 *
 * TrueForge resolves `require_approval_for_tools` selectors from the annotations an MCP server
 * publishes. From the harness source (core/mcp/toolSelectors.ts):
 *
 *   @read-only   readOnlyHint === true
 *   @write       readOnlyHint === false and destructiveHint !== true
 *   @destructive destructiveHint === true
 *
 * A tool that publishes no annotations matches none of them. With the default policy of
 * ["@write", "@destructive"], such a tool executes with no human gate. That is fail-open, and it
 * is invisible unless you go looking - so this script goes looking.
 *
 *   node scripts/audit-tools.mjs
 *
 * Exits non-zero if any reachable tool would run ungated under the default policy.
 */
import { classify, UNANNOTATED } from './lib/annotations.mjs';
import { loadEnv } from './lib/env.mjs';

loadEnv();

const BASE = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';

const get = async (path) => {
  const res = await fetch(`${BASE}${path}`);
  const body = await res.json();
  if (body.error) throw new Error(`${path}: ${body.error.message}`);
  return body.data ?? body;
};


const servers = await get('/api/v1/settings/mcp-servers');
const list = Array.isArray(servers) ? servers : (servers.items ?? []);
if (!list.length) {
  console.log('No MCP servers configured.');
  process.exit(0);
}

let ungated = 0;

for (const server of list) {
  const name = server.name ?? server.manifest?.name;
  let tools;
  try {
    const res = await get(`/api/v1/mcp-servers/${encodeURIComponent(name)}/tools`);
    tools = Array.isArray(res) ? res : (res.items ?? res.tools ?? []);
  } catch (err) {
    console.log(`\n${name}: could not list tools - ${err.message}`);
    console.log('  (a server needing credentials must be authenticated before it can be audited)');
    continue;
  }

  console.log(`\n${name} - ${tools.length} tools`);
  for (const tool of tools) {
    const kind = classify(tool.annotations);
    const gated = kind === 'write' || kind === 'destructive';
    if (kind === UNANNOTATED) ungated++;
    console.log(`  ${gated ? 'GATED  ' : kind === UNANNOTATED ? 'UNGATED' : '  free '}  ${String(tool.name).padEnd(30)} ${kind}`);
  }
}

if (ungated > 0) {
  console.log(
    `\n${ungated} unannotated tool(s) would execute with no approval under the default policy.\n` +
      'Fix by making the spec fail closed: restrict `enable_tools` to ["@read-only", ...literal write tools you\n' +
      'actually want], and name those same tools in `require_approval_for_tools` so the gate does not depend\n' +
      'on the server annotating them correctly.',
  );
  process.exit(1);
}

console.log('\nEvery reachable tool is annotated. The default policy gates what it claims to gate.');
