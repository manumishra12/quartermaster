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

/**
 * The keys TrueForge actually reads, taken from the SDK's own serialisers rather than from memory
 * (`RuntimeConfig`, `AgentManifest`). Anything else in these objects is dropped in transit.
 *
 * That silence is the reason this list exists. `dynamic_subagents` - one underscore short - applies
 * without complaint and reads, to anybody auditing the file, exactly like the setting that turns
 * subagents off. It is not that setting. The harness never saw it, and the default it fell back to
 * is `true`.
 */
const CONFIG_KEYS = new Set([
  'ask_user_questions',
  'context_management',
  'dynamic_sub_agents',
  'generative_ui',
  'iteration_limit',
  'sandbox',
]);
const MANIFEST_KEYS = new Set(['model', 'instructions', 'config', 'skills', 'mcp_servers']);

/** `iteration_limit` is documented as 1-1024; outside that the apply is rejected. */
const ITERATION_RANGE = [1, 1024];

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

    // `@all` already admits everything; the names beside it read as a restriction and are not one.
    if (enable.includes('@all') && enable.some((sel) => !sel.startsWith('@'))) {
      const named = enable.filter((sel) => !sel.startsWith('@')).join(', ');
      say(`${where}: enable_tools has @all alongside ${named} - the names restrict nothing and read as though they do`);
    }

    // A name repeated in a policy list looks like emphasis and does nothing. Usually it is the
    // wrong name typed twice, with the one that was meant missing.
    for (const [key, list] of [['enable_tools', server?.enable_tools], ['require_approval_for_tools', server?.require_approval_for_tools]]) {
      if (!Array.isArray(list)) continue;
      const twice = list.filter((sel, i) => list.indexOf(sel) !== i);
      for (const sel of new Set(twice)) say(`${where}: ${key} lists ${sel} twice`);
    }

    /**
     * Deferred loading does not work on this harness: a tool reached with `preload: false` resolves
     * to `{"error":"MCP server 'deferred-tools' not found"}`, and the agent then reports the tool as
     * broken rather than the loading of it. TOOLS.md records the whole investigation.
     */
    if (server?.preload === false) {
      say(`${where}: preload: false resolves to a missing-server error on this harness - see TOOLS.md`);
    }
  }

  // Skills are materialised in the sandbox; attaching them without one cannot work.
  if ((m.skills?.length ?? 0) > 0 && m.config?.sandbox?.enabled !== true) {
    say('skills are attached but the sandbox is not enabled - the harness rejects this');
  }

  /**
   * Every spec states its sandbox setting, rather than inheriting one by omission.
   *
   * There is no shared safety block to derive from - specs are plain JSON with no include
   * mechanism, and inventing one would put a build step between a reviewer and the policy they
   * are reading. The alternative to a shared block is not silent divergence, though: it is that
   * divergence fails a check. So the choice has to be written down in every spec, where a reviewer
   * reading one file can see it, and an agent without a sandbox has to have nothing that needs one.
   */
  if (typeof m.config?.sandbox?.enabled !== 'boolean') {
    say('config.sandbox.enabled must be stated explicitly, so no agent gets its sandbox policy by omission');
  }
  if (m.config?.sandbox?.enabled === false) {
    if (m.config?.sandbox?.file_downloads) {
      say('sandbox is disabled but file_downloads is set - one of the two is wrong');
    }
    if (m.config?.dynamic_sub_agents?.enabled === true) {
      say('sandbox is disabled but subagents are enabled - a spec with nowhere safe to run should not be spawning more agents');
    }
  }

  /**
   * Subagents are stated, never inherited - and unlike the sandbox, the default here is `enabled`.
   *
   * `DynamicSubAgentsConfig.enabled` is documented in the SDK as "Default: true". So a spec that
   * says nothing is not a spec that declined to spawn subagents; it is one that opted in silently.
   * `gate-demo` was exactly that: an agent whose entire purpose is a single gated tool call, with
   * subagent spawning switched on by an omission nobody had read as a choice.
   *
   * The sandbox rule below asks for the same explicitness for the same reason. This one matters
   * more, because the direction of the default is the unsafe one.
   */
  if (typeof m.config?.dynamic_sub_agents?.enabled !== 'boolean') {
    say(
      'config.dynamic_sub_agents.enabled must be stated explicitly - it defaults to true, so leaving it out ' +
        'turns subagent spawning on by omission rather than by decision',
    );
  }

  /**
   * A key the harness does not read is a policy that was never applied.
   *
   * Nothing anywhere else catches this. The JSON parses, the apply succeeds, and the spec keeps
   * reading as though the setting is in force - which is the worst possible failure for a file this
   * repository calls its safety policy.
   */
  for (const key of Object.keys(m.config ?? {})) {
    if (!CONFIG_KEYS.has(key)) {
      say(`config.${key} is not a key TrueForge reads - it is dropped on apply, and a dropped setting is not a setting`);
    }
  }
  for (const key of Object.keys(m)) {
    if (!MANIFEST_KEYS.has(key)) say(`manifest.${key} is not a key TrueForge reads - it is dropped on apply`);
  }

  /**
   * An absent iteration limit is 100, and a limit outside 1-1024 is refused at apply time - which
   * is a failure discovered when someone runs the agent, not when they read the spec.
   */
  const iterations = m.config?.iteration_limit;
  if (iterations === undefined) {
    say('config.iteration_limit is not set - it defaults to 100, which is a choice worth making on purpose');
  } else if (!Number.isInteger(iterations) || iterations < ITERATION_RANGE[0] || iterations > ITERATION_RANGE[1]) {
    say(`config.iteration_limit must be a whole number from ${ITERATION_RANGE[0]} to ${ITERATION_RANGE[1]}, not ${JSON.stringify(iterations)}`);
  }

  // Invariants the documentation states as guarantees. SECURITY.md says code-runner runs with
  // subagents disabled and asks that the property be kept; nothing was keeping it.
  if (spec.name === 'code-runner' && m.config?.dynamic_sub_agents?.enabled !== false) {
    say('code-runner must keep dynamic_sub_agents disabled - it executes untrusted code, and handing that code to more agents widens the blast radius');
  }

  return problems;
}
