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
import { policiesFor } from './lib/policies.mjs';
import { loadEnv } from './lib/env.mjs';
import { httpProblem } from './lib/http.mjs';

loadEnv();

const BASE = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';

/** What the specs actually declare for a connector, rather than the library default. */

const get = async (path) => {
  const res = await fetch(`${BASE}${path}`);
  // The status comes first. An error page is often valid JSON with no `error` field in it, and
  // reading one as a tool list gave the audit an empty list - which is indistinguishable from a
  // connector with nothing risky on it, so it cleared a server it had never read.
  const problem = httpProblem(res, path);
  if (problem) throw new Error(problem);
  const body = await res.json();
  if (body.error) throw new Error(`${path}: ${body.error.message}`);
  return body.data ?? body;
};

let servers;
try {
  servers = await get('/api/v1/settings/mcp-servers');
} catch (err) {
  // Naming the failure, because the alternative here was an unhandled throw: a stack trace about
  // JSON parsing, for a server that was simply not running.
  console.error(`Could not list the MCP servers - ${err.message}`);
  console.error(`Is the harness running at ${BASE}?`);
  process.exit(1);
}
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
  /**
   * Say what was found, not what used to be the only thing findable.
   *
   * This read "unannotated tool(s) ... under the default policy" whatever it had found. Once
   * annotated write and destructive tools could be reported too, that sentence described neither
   * the cause nor the policy actually audited - and the fix it recommends is the wrong one for a
   * tool whose annotations are perfectly good and simply is not gated.
   */
  console.log(
    `\n${ungated} tool(s) would execute with no approval under the policy some agent declares.\n` +
      'For a tool with no annotations, the fix is to restrict `enable_tools` to ["@read-only", ...the literal\n' +
      'write tools you actually want], so a tool the server adds later is not enabled at all.\n' +
      'For an annotated write or destructive tool, the allowlist is not the fix: name it in\n' +
      '`require_approval_for_tools` as well, because admitting a tool is not the same as gating it.',
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
