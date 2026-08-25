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

  for (const server of m.mcp_servers ?? []) {
    const where = `mcp_servers[${server?.name ?? '?'}]`;
    if (!server?.name) say(`${where}: missing name`);

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

  return problems;
}
