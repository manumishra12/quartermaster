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
import { classify, ungatedRisks, UNANNOTATED } from './lib/annotations.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from './lib/env.mjs';

loadEnv();

const BASE = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';
const AGENTS_DIR = new URL('../agents/', import.meta.url).pathname;

/** What the specs actually declare for a connector, rather than the library default. */
/**
 * Every agent's policy for this server, separately.
 *
 * These used to be merged into one set, which audits a policy no single agent has. Two agents
 * declaring the same server - `github` is declared by both quartermaster and gate-demo today - had
 * their gates unioned, so one agent's narrow policy was covered by another's wide one and the
 * result was reported safe. That is the exact failure the per-spec read was introduced to prevent:
 * checking against something other than what an agent actually runs with.
 */
function policiesFor(serverName) {
  const policies = [];

  for (const file of readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.json'))) {
    let spec;
    try {
      spec = JSON.parse(readFileSync(join(AGENTS_DIR, file), 'utf8'));
    } catch {
      continue;
    }
    for (const server of spec?.manifest?.mcp_servers ?? []) {
      if (server?.name !== serverName) continue;
      policies.push({
        agent: spec?.name ?? file.replace(/\.json$/, ''),
        approval: server.require_approval_for_tools ?? ['@write', '@destructive'],
        enabled: server.enable_tools ?? ['@all'],
      });
    }
  }

  return policies;
}

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
let seenUnannotated = 0;
let unauditable = 0;

for (const server of list) {
  const name = server.name ?? server.manifest?.name;
  let tools;
  try {
    const res = await get(`/api/v1/mcp-servers/${encodeURIComponent(name)}/tools`);
    tools = Array.isArray(res) ? res : (res.items ?? res.tools ?? []);
  } catch (err) {
    unauditable += 1;
    console.log(`\n${name}: could not list tools - ${err.message}`);
    console.log('  (a server needing credentials must be authenticated before it can be audited)');
    continue;
  }

  /**
   * Judged against the weakest policy any agent uses, and the agent named.
   *
   * Reporting the union hid a narrow gate behind a wide one. What matters is whether *some* agent
   * can reach this tool ungated, and which - that is the sentence somebody has to act on.
   */
  const policies = policiesFor(name);
  const risks = new Map();
  for (const policy of policies.length ? policies : [{ agent: null, approval: undefined, enabled: undefined }]) {
    for (const tool of ungatedRisks(tools, policy.approval, policy.enabled)) {
      if (!risks.has(tool.name)) risks.set(tool.name, policy.agent);
    }
  }

  console.log(`\n${name} - ${tools.length} tools`);
  for (const tool of tools) {
    const kind = classify(tool.annotations);
    const risky = risks.has(tool.name);
    if (risky) ungated++;
    if (kind === UNANNOTATED) seenUnannotated++;
    const label = risky
      ? 'UNGATED'
      : kind === 'write' || kind === 'destructive'
        ? 'GATED  '
        : kind === UNANNOTATED
          ? 'allowed'
          : '  free ';
    const via = risky && risks.get(tool.name) ? ` - via ${risks.get(tool.name)}` : '';
    console.log(`  ${label}  ${String(tool.name).padEnd(30)} ${kind}${via}`);
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

// A connector we could not read is not a connector we cleared. Printing "nothing runs ungated"
// while a server sat unaudited is the reassuring falsehood this whole project argues against.
if (unauditable > 0) {
  console.log(
    `\n${unauditable} connector(s) could not be audited. No claim is made about them - authenticate them and run this again.`,
  );
  process.exit(1);
}

const unannotated = seenUnannotated;
console.log(
  unannotated > 0
    ? `\nNothing runs ungated. ${unannotated} tool(s) publish no annotations, but the specs reach them by name, so a tool the server adds later would not be enabled.`
    : '\nEvery reachable tool is annotated. The default policy gates what it claims to gate.',
);
