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
      // A spec that will not parse cannot be audited. Skipping it silently would report the
      // remaining ones as the whole picture, so it is surfaced as its own entry.
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
