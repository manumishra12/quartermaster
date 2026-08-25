/**
 * Validation for the agent specs.
 *
 * The repository calls these files the safety policy, and until now nothing checked them: not tsc,
 * which does not read JSON, and not CI. A spec with a typo in `require_approval_for_tools` would
 * apply cleanly and gate nothing, and the first sign of it would be an agent doing something
 * irreversible without asking.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const APPROVAL_TAGS = ['@all', '@write', '@destructive'];
export const ENABLE_TAGS = ['@all', '@read-only'];

export function specFiles(dir = fileURLToPath(new URL('../../agents/', import.meta.url))) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ name: f, path: join(dir, f) }));
}

/** Returns a list of problems. Empty means the spec is sound. */
export function validateSpec(spec, filename = 'spec') {
  const problems = [];
  const say = (m) => problems.push(`${filename}: ${m}`);

  if (!spec || typeof spec !== 'object') return [`${filename}: not an object`];
  if (!spec.name) say('missing name');
  const m = spec.manifest;
  if (!m || typeof m !== 'object') return [`${filename}: missing manifest`];

  if (!m.model?.name) say('missing model.name');
  if (!m.instructions?.trim()) say('missing instructions');

  if (m.skills && (!Array.isArray(m.skills) || m.skills.some((s) => !s?.name))) {
    say('skills must be a list of { name }');
  }

  /**
   * The promise-versus-policy check.
   *
   * This is here because the validator passed a spec whose instructions said writes "stop and ask
   * first" while the spec declared no connector at all, so there was nothing anywhere that could
   * pause. A validator that misses the worst defect in the repository is worse than none, because
   * a green check is itself a claim.
   */
  const promisesApproval = /\b(stops? and asks?|pauses? for approval|requires? approval|asks? (?:you )?first|approval (?:is )?required)\b/i.test(
    m.instructions ?? '',
  );
  const declaresApproval = (m.mcp_servers ?? []).some(
    (srv) => (srv?.require_approval_for_tools?.length ?? 0) > 0,
  );
  /**
   * An agent may legitimately pause without a tool gate - `ask_user_question` is a real pause, and
   * for an agent whose work runs entirely in the sandbox shell there is no MCP tool to gate. What
   * it may not do is let a reader believe the harness is enforcing something it is not.
   *
   * So the rule is: gate it, or say plainly that nothing outside the agent enforces it. Either is
   * honest. Only the silent version is not.
   */
  const admitsUnenforced =
    /\b(nothing (outside|else|other than) (you|this agent) enforces|not enforced by the harness|the harness does not gate|instruction-only)\b/i.test(
      m.instructions ?? '',
    );
  if (promisesApproval && !declaresApproval && !admitsUnenforced) {
    say(
      'the instructions promise an approval pause, but no connector declares require_approval_for_tools ' +
        'and the instructions do not say so. Gate the tool, or state plainly that nothing outside the agent enforces it.',
    );
  }

  const seenServers = new Set();

  for (const server of m.mcp_servers ?? []) {
    const where = `mcp_servers[${server?.name ?? '?'}]`;
    if (!server?.name) say(`${where}: missing name`);
    if (server?.name && seenServers.has(server.name)) say(`${where}: declared twice`);
    if (server?.name) seenServers.add(server.name);

    // An omitted policy is not the same as an empty one to a reader, and identical to it in
    // effect: audit-tools defaults the missing key to the library default and then reports a
    // policy the spec never made.
    if (server && !('require_approval_for_tools' in server)) {
      say(`${where}: no approval policy declared - say ["@write", "@destructive"] explicitly if that is what you mean`);
    }

    const enable = server?.enable_tools ?? ['@all'];
    const approval = server?.require_approval_for_tools ?? [];

    // The fail-open shape SECURITY.md tells you not to use: everything enabled, gated only by
    // tags, so a tool the server adds later is both reachable and - if unannotated - ungated.
    if (enable.includes('@all') && approval.length > 0 && approval.every((sel) => sel.startsWith('@'))) {
      say(`${where}: enable_tools ["@all"] with tag-only approvals is the fail-open shape SECURITY.md prescribes against`);
    }

    // A literal name that is not also enabled gates nothing, and reads as though it does.
    for (const sel of approval.filter((x) => !x.startsWith('@'))) {
      const reachable = enable.includes('@all') || enable.includes(sel) || enable.some((e) => e.startsWith('@'));
      if (!reachable) {
        say(`${where}: ${sel} is gated but not enabled - the gate is on a tool this agent cannot call`);
      }
    }

    if (Array.isArray(server?.enable_tools) && server.enable_tools.length === 0) {
      say(`${where}: empty enable_tools - this agent can reach nothing on this server`);
    }

    // The selectors are the gate. A typo here is silent: an unrecognised tag matches nothing, so
    // the policy that reads as protective gates nothing at all.
    for (const sel of server.require_approval_for_tools ?? []) {
      if (sel.startsWith('@') && !APPROVAL_TAGS.includes(sel)) {
        say(`${where}: unknown approval tag ${sel} - it will match no tools and gate nothing`);
      }
    }
    for (const sel of server.enable_tools ?? []) {
      if (sel.startsWith('@') && !ENABLE_TAGS.includes(sel)) {
        say(`${where}: unknown enable tag ${sel}`);
      }
    }
    if (Array.isArray(server.require_approval_for_tools) && server.require_approval_for_tools.length === 0) {
      say(`${where}: empty approval policy - every tool on this server runs ungated`);
    }
  }

  // Skills are materialised in the sandbox; attaching them without one cannot work.
  if ((m.skills?.length ?? 0) > 0 && m.config?.sandbox?.enabled !== true) {
    say('skills are attached but the sandbox is not enabled - the harness rejects this');
  }

  // Invariants the documentation states as guarantees. SECURITY.md says code-runner runs with
  // subagents disabled and asks that the property be kept; nothing was keeping it.
  if (spec.name === 'code-runner' && m.config?.dynamic_sub_agents?.enabled !== false) {
    say('code-runner must keep dynamic_sub_agents disabled - it executes untrusted code, and handing that code to more agents widens the blast radius');
  }

  return problems;
}
