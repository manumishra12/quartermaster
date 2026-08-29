#!/usr/bin/env node
/**
 * Move every registered skill from a branch ref to another ref, usually `main` after a merge.
 *
 * Skills are fetched from GitHub at sandbox init, so a skill registered against a branch works
 * exactly until that branch is deleted - and then every agent carrying it reports that it could not
 * reach its tools, which sends whoever is reading to the connector and the token, neither of which
 * is the problem. `preflight` names them every run for that reason.
 *
 * The order matters and this refuses to get it wrong: re-pointing at a ref that does not yet hold
 * the skill breaks it immediately. So each skill's path is checked in the target ref before
 * anything is written, and nothing is written at all if any of them is missing.
 *
 *   node scripts/repoint-skills.mjs --to main            # check, then move
 *   node scripts/repoint-skills.mjs --to main --dry-run  # check only
 */

import { spawnSync } from 'node:child_process';
import { readFlag } from './lib/flags.mjs';
import { loadEnv } from './lib/env.mjs';
import { skillPathAtRef } from './lib/skills.mjs';

loadEnv();

const BASE = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const { value: target, problem } = readFlag(argv, 'to', 'main');
if (problem) {
  console.error(problem);
  process.exit(2);
}

const gitLsTree = (args) => {
  const out = spawnSync('git', args, { encoding: 'utf8' });
  return out.status === 0 ? out.stdout : null;
};

const res = await fetch(`${BASE}/api/v1/settings/skills`).catch(() => null);
if (!res?.ok) {
  console.error(`\n  The harness is not answering at ${BASE}. Start it with npm run forge.\n`);
  process.exit(1);
}
const skills = (await res.json()).data ?? [];
const moving = skills.filter((s) => s.manifest?.type === 'git' && s.manifest?.ref !== target);

console.log();
if (moving.length === 0) {
  console.log(`  Every registered skill already points at ${target}.\n`);
  process.exit(0);
}

/**
 * Checked before anything is written, and all of them before any of them. A partial move is the
 * worst outcome: some agents keep working and some do not, which reads as a flaky harness.
 */
const missing = [];
for (const skill of moving) {
  const at = skillPathAtRef({ ...skill.manifest, ref: target }, gitLsTree);
  const state = at.known ? (at.present ? 'ok' : 'MISSING') : 'unknown';
  console.log(`  ${state.padEnd(8)} ${skill.name.padEnd(24)} ${skill.manifest.ref} -> ${target}`);
  if (at.known && !at.present) missing.push(skill.name);
}
console.log();

if (missing.length) {
  console.log(`  ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in ${target} yet.`);
  console.log(`  Merge first. Re-pointing now would break every agent carrying them.\n`);
  process.exit(1);
}

if (dryRun) {
  console.log(`  ${moving.length} skill(s) would move to ${target}. Nothing was written.\n`);
  process.exit(0);
}

let moved = 0;
for (const skill of moving) {
  const body = { manifest: { ...skill.manifest, ref: target } };
  const put = await fetch(`${BASE}/api/v1/settings/skills/${encodeURIComponent(skill.name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch((err) => ({ ok: false, statusText: err.message }));

  if (put.ok) {
    moved += 1;
    console.log(`  moved    ${skill.name}`);
  } else {
    console.log(`  FAILED   ${skill.name}  ${put.status ?? ''} ${put.statusText ?? ''}`);
  }
}
console.log(`\n  ${moved} of ${moving.length} moved to ${target}. Run npm run preflight to confirm.\n`);
process.exit(moved === moving.length ? 0 : 1);
