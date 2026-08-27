import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { policiesFor, DEFAULT_APPROVAL } from './policies.mjs';

/**
 * Both the preflight check and the tool audit had their own copy of this, and both merged every
 * spec into one set - auditing a policy no single agent has.
 */
function specs(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'policies-'));
  for (const [name, spec] of Object.entries(entries)) {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(spec));
  }
  return dir;
}

test('two agents on one server are two policies, not one merged set', () => {
  /**
   * The failure this exists to prevent: agent A gates a single tool, agent B gates everything, and
   * the union contains @write - so a write-annotated tool reads as gated while agent A runs it
   * with no gate at all.
   */
  const dir = specs({
    narrow: { name: 'narrow', manifest: { mcp_servers: [{ name: 'ops', require_approval_for_tools: ['restart_service'], enable_tools: ['@all'] }] } },
    wide: { name: 'wide', manifest: { mcp_servers: [{ name: 'ops', require_approval_for_tools: ['@write', '@destructive'], enable_tools: ['@all'] }] } },
  });

  const found = policiesFor('ops', dir);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((p) => p.agent).sort(), ['narrow', 'wide']);
  assert.deepEqual(found.find((p) => p.agent === 'narrow').approval, ['restart_service']);
});

test('a spec that omits a field is audited as what the harness will do', () => {
  // An omitted policy is not an absent one - the harness applies its default, so that is what has
  // to be audited. Reporting "no policy" would describe a state that never exists at runtime.
  const dir = specs({ quiet: { name: 'quiet', manifest: { mcp_servers: [{ name: 'ops' }] } } });
  assert.deepEqual(policiesFor('ops', dir)[0].approval, DEFAULT_APPROVAL);
});

test('a spec that will not parse is reported rather than skipped', () => {
  // Skipping it silently would present the remaining specs as the whole picture.
  const dir = mkdtempSync(join(tmpdir(), 'policies-'));
  writeFileSync(join(dir, 'broken.json'), '{ not json');
  const found = policiesFor('ops', dir);
  assert.equal(found.length, 1);
  assert.equal(found[0].unreadable, true);
});

test('a server no spec declares has no policies, and no invented one', () => {
  const dir = specs({ a: { name: 'a', manifest: { mcp_servers: [{ name: 'other' }] } } });
  assert.deepEqual(policiesFor('ops', dir), []);
});
