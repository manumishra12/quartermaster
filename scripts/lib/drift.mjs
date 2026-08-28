/**
 * What is running in the harness, against what this repository says should be.
 *
 * These are two different things and nothing was comparing them. Applying the specs once with a
 * different `TRUEFORGE_MODEL` left all nine agents pointing at a provider whose quota was exhausted,
 * while `.env`, every spec file and every document went on describing the local model. Nothing was
 * broken in the repository. Nothing was wrong in the harness. The pair disagreed, and the only way
 * anybody found out was by looking.
 *
 * That is the ordinary shape of a deployment bug: the artefact is fine, the deployed thing is fine,
 * and what is deployed is not the artefact. A demo rehearsed against one and given against the
 * other is the version of this that costs something.
 *
 * Compared field by field rather than by deep-equality on the whole manifest, because the harness
 * adds fields of its own and a diff that reports every one of those is a diff nobody reads twice.
 */

const names = (list, key = 'name') => (Array.isArray(list) ? list.map((x) => x?.[key]).filter(Boolean).sort() : []);
const sortedOr = (list, fallback) => [...(Array.isArray(list) ? list : fallback)].sort();

/** Set difference, phrased the way somebody reading a preflight line needs it. */
function differ(label, mine, theirs) {
  const missing = mine.filter((x) => !theirs.includes(x));
  const extra = theirs.filter((x) => !mine.includes(x));
  if (!missing.length && !extra.length) return null;
  const parts = [];
  if (missing.length) parts.push(`the repository has ${missing.join(', ')} and the harness does not`);
  if (extra.length) parts.push(`the harness has ${extra.join(', ')} and the repository does not`);
  return `${label}: ${parts.join('; ')}`;
}

/**
 * Every way the applied agent differs from the spec, or an empty array.
 *
 * `applied` is the manifest read back from the harness; `spec` is this repository's, with
 * `${TRUEFORGE_MODEL}` already resolved - comparing an unresolved placeholder against a real model
 * name would report drift on every agent every time, which is the fastest way to teach somebody to
 * ignore a check.
 */
export function driftBetween(applied, spec) {
  const found = [];
  const mine = spec?.manifest ?? spec ?? {};
  const theirs = applied?.manifest ?? applied ?? {};

  if (mine.model?.name && theirs.model?.name && mine.model.name !== theirs.model.name) {
    found.push(`model: the repository says ${mine.model.name}, the harness is running ${theirs.model.name}`);
  }

  const connectors = differ('connectors', names(mine.mcp_servers), names(theirs.mcp_servers));
  if (connectors) found.push(connectors);

  /**
   * Per connector, because a connector present on both sides with a wider enable list on the
   * harness is the drift that matters most and the one a name-only comparison cannot see.
   */
  for (const server of mine.mcp_servers ?? []) {
    const applied_ = (theirs.mcp_servers ?? []).find((s) => s?.name === server?.name);
    if (!applied_) continue;
    const enabled = differ(`${server.name} enable_tools`, sortedOr(server.enable_tools, ['@all']), sortedOr(applied_.enable_tools, ['@all']));
    if (enabled) found.push(enabled);
    const gated = differ(
      `${server.name} require_approval_for_tools`,
      sortedOr(server.require_approval_for_tools, ['@write', '@destructive']),
      sortedOr(applied_.require_approval_for_tools, ['@write', '@destructive']),
    );
    if (gated) found.push(gated);
  }

  const skills = differ('skills', names(mine.skills), names(theirs.skills));
  if (skills) found.push(skills);

  const sandbox = (m) => Boolean(m.config?.sandbox?.enabled);
  if (sandbox(mine) !== sandbox(theirs)) {
    found.push(`sandbox: the repository says ${sandbox(mine)}, the harness has ${sandbox(theirs)}`);
  }

  // Absent means enabled, which is the SDK's own default, so a silence is compared as what it does.
  const subs = (m) => m.config?.dynamic_sub_agents?.enabled !== false;
  if (subs(mine) !== subs(theirs)) {
    found.push(`dynamic_sub_agents: the repository says ${subs(mine)}, the harness has ${subs(theirs)}`);
  }

  return found;
}
