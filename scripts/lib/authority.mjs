import { DEFAULT_APPROVAL, DEFAULT_ENABLED } from './policies.mjs';

/**
 * What an agent is allowed to do, in a form two agents can be compared with.
 *
 * This exists for one question: when one agent hands work to another, does the work end up
 * somewhere it could not have gone? Every other part of this project defends the gate against a
 * model that argues with it. Delegation walks around it instead - agent A stops at an approval it
 * cannot pass, hands the task to agent B, and B does it ungated. Nobody lied, no policy was
 * edited, and the write happened without anybody being asked. That is approval laundering, and it
 * is the failure mode a system with more than one agent gets for free unless something checks.
 *
 * The comparison is deliberately **conservative**: it reports a widening whenever it cannot prove
 * there is not one. Selectors like `@read-only` expand through tool annotations that are published
 * by the servers at runtime, and a check that needs a live connector is a check that does not run
 * in CI. So coverage is only ever concluded from what the two specs literally say. The cost is
 * naming a handoff that is in fact safe; the cost the other way is blessing one that is not.
 */

const ALL = '@all';

/** One server's reach, as the spec declares it, with the harness defaults filled in. */
function reachOf(server) {
  return {
    name: server?.name,
    enabled: new Set(server?.enable_tools ?? DEFAULT_ENABLED),
    gated: new Set(server?.require_approval_for_tools ?? DEFAULT_APPROVAL),
  };
}

/**
 * Everything a spec can reach, keyed by connector.
 *
 * `sandbox` and `dynamic_sub_agents` are folded in as capabilities rather than kept separate,
 * because they widen authority in exactly the same way a connector does and would otherwise be
 * compared by nobody. A shell is not gated by anything - handing a task from an agent with no
 * sandbox to one with a sandbox is the largest widening available here, and it is invisible if you
 * only look at `mcp_servers`.
 */
export function authorityOf(spec) {
  const manifest = spec?.manifest ?? spec ?? {};
  const servers = new Map();
  for (const server of manifest.mcp_servers ?? []) {
    if (!server?.name) continue;
    // A spec naming the same connector twice is a union of both entries, which is how the harness
    // would read it. Taking the last would silently drop a policy somebody wrote.
    const existing = servers.get(server.name);
    const next = reachOf(server);
    if (!existing) servers.set(server.name, next);
    else {
      for (const e of next.enabled) existing.enabled.add(e);
      for (const g of next.gated) existing.gated.add(g);
    }
  }

  return {
    servers,
    sandbox: Boolean(manifest.config?.sandbox?.enabled),
    /** Absent means enabled: the SDK's own default, so a silence is compared as what it does. */
    subAgents: manifest.config?.dynamic_sub_agents?.enabled !== false,
  };
}

/**
 * Does `enabled` demonstrably cover `capability`?
 *
 * Only what the spec says, never what a selector might expand to. `@all` covers everything by
 * definition, a literal name covers itself, and a selector covers itself. Nothing else is
 * concluded - notably `@read-only` is *not* taken to cover a named read tool, because deciding
 * that needs the annotations the server publishes, and this has to be answerable offline.
 */
export function covers(enabled, capability) {
  return enabled.has(ALL) || enabled.has(capability);
}

/** Is `capability` behind an approval in this policy, as far as the spec alone can say? */
export function isGated(gated, capability) {
  return gated.has(ALL) || gated.has(capability);
}

/**
 * What handing from `from` to `to` would widen.
 *
 * Returns one finding per capability the receiver has and the sender does not, or that the sender
 * gates and the receiver does not. An empty array means the handoff cannot reach anywhere the
 * sender could not already have reached itself, which is the only condition under which delegation
 * is not a way around the gate.
 */
export function widening(from, to) {
  const findings = [];

  if (to.sandbox && !from.sandbox) {
    findings.push({
      kind: 'sandbox',
      server: null,
      capability: 'sandbox',
      detail: 'the receiver has a shell and the sender does not; nothing gates a shell',
    });
  }

  if (to.subAgents && !from.subAgents) {
    findings.push({
      kind: 'sub-agents',
      server: null,
      capability: 'dynamic_sub_agents',
      detail: 'the receiver may spawn subagents and the sender may not',
    });
  }

  for (const [name, receiver] of to.servers) {
    const sender = from.servers.get(name);

    if (!sender) {
      findings.push({
        kind: 'connector',
        server: name,
        capability: name,
        detail: 'the sender does not have this connector at all',
      });
      continue;
    }

    for (const capability of receiver.enabled) {
      if (!covers(sender.enabled, capability)) {
        findings.push({
          kind: 'tool',
          server: name,
          capability,
          detail: 'the sender cannot reach it',
        });
        continue;
      }

      /**
       * Both can reach it, so the question becomes the gate. A capability the sender could only
       * use by asking somebody, which the receiver may use without asking, is the laundering case
       * proper - and the one that looks completely fine in both specs read separately.
       */
      if (isGated(sender.gated, capability) && !isGated(receiver.gated, capability)) {
        findings.push({
          kind: 'approval',
          server: name,
          capability,
          detail: 'the sender must ask before using it; the receiver may use it without asking',
        });
      }
    }
  }

  return findings;
}
