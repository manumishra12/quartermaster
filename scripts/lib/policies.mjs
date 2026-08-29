import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What each agent's spec actually declares for a connector.
 *
 * Both the preflight check and the tool audit need this, and both had their own copy that merged
 * every spec into one set. That audits a policy no single agent has: `github` is declared by two
 * agents today, so one agent's narrow gate was covered by another's wide one and the connector was
 * reported safe. Reading them separately is the whole point - what matters is whether *some* agent
 * can reach a tool ungated, and which one.
 *
 * It lives here rather than in either script because two copies of a safety rule drift, and this
 * project has already paid for that once with an envelope parser in the interface disagreeing with
 * the one in the verifier.
 */
const DEFAULT_AGENTS = fileURLToPath(new URL('../../agents/', import.meta.url));

/** The harness defaults, applied when a spec omits a field, so a silence is audited as what it does. */
export const DEFAULT_APPROVAL = ['@write', '@destructive'];
export const DEFAULT_ENABLED = ['@all'];

export function policiesFor(serverName, dir = DEFAULT_AGENTS) {
  const policies = [];

  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    // No specs to read is not a policy of none; the caller decides what to do with an empty list.
    return policies;
  }

  for (const file of files.sort()) {
    let spec;
    try {
      spec = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch {
      /**
       * A spec that will not parse cannot be audited. Skipping it silently would report the
       * remaining ones as the whole picture, so it is surfaced as its own entry.
       *
       * It is surfaced for *every* server name asked about, because which servers an unreadable
       * file declares is exactly what could not be established. Callers must split it out with
       * `splitPolicies` rather than pass it on as a policy - it carries no selectors, and a
       * selector that is absent is read as the harness default by everything downstream.
       */
      policies.push({ agent: file.replace(/\.json$/, ''), unreadable: true });
      continue;
    }

    for (const server of spec?.manifest?.mcp_servers ?? []) {
      if (server?.name !== serverName) continue;
      policies.push({
        agent: spec?.name ?? file.replace(/\.json$/, ''),
        approval: server.require_approval_for_tools ?? DEFAULT_APPROVAL,
        enabled: server.enable_tools ?? DEFAULT_ENABLED,
      });
    }
  }

  return policies;
}

/**
 * The entries that are policies, separated from the specs that could not be read.
 *
 * `policiesFor` surfaces an unparseable spec rather than dropping it, and then both callers looped
 * over the whole list as though every entry were a policy. An `unreadable` entry has no `approval`
 * and no `enabled`, and `ungatedRisks` fills a missing selector with the harness default - so a hole
 * was audited as an agent that had declared the safe default.
 *
 * This was measured rather than assumed. Against a connector whose every tool is annotated, which is
 * what all five servers in this repository publish, one malformed spec produced an empty risk list
 * and `audit-tools` printed "Every reachable tool is annotated. The default policy gates what it
 * claims to gate." and exited 0. The check that could not run is not the check that passed.
 *
 * Splitting here rather than in each caller for the reason this file exists at all: two copies of a
 * safety rule drift, and these two have already drifted once.
 */
export function splitPolicies(entries) {
  return {
    policies: entries.filter((entry) => !entry.unreadable),
    /**
     * Named, because "one spec could not be read" is not something anybody can act on. For an
     * unparseable file the agent's own `name` field is unreachable too, so this is the filename
     * without its suffix - which is what somebody has to open.
     */
    unreadable: entries.filter((entry) => entry.unreadable).map((entry) => entry.agent),
  };
}
