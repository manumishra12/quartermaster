import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { policiesFor, splitPolicies, DEFAULT_APPROVAL } from './policies.mjs';
import { ungatedRisks } from './annotations.mjs';

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

test('an unreadable spec is separated from the policies rather than counted as one', () => {
  // An entry with no selectors is a hole, not a policy. Callers that could not tell the two apart
  // handed the hole to `ungatedRisks`, which fills an omitted selector with the harness default.
  const dir = mkdtempSync(join(tmpdir(), 'policies-'));
  writeFileSync(join(dir, 'broken.json'), '{ not json');
  writeFileSync(
    join(dir, 'sound.json'),
    JSON.stringify({ name: 'sound', manifest: { mcp_servers: [{ name: 'ops', require_approval_for_tools: ['@write'], enable_tools: ['@all'] }] } }),
  );

  const { policies, unreadable } = splitPolicies(policiesFor('ops', dir));
  assert.deepEqual(unreadable, ['broken'], 'the file somebody has to open is the one that is named');
  assert.equal(policies.length, 1, 'and the spec that did parse is still a policy');
  assert.deepEqual(policies[0].approval, ['@write']);
});

test('the hole an unreadable spec leaves is what made a malformed repository audit clean', () => {
  /**
   * The failure this exists to prevent, asserted through the loop both scripts actually run.
   *
   * Every tool on every server in this repository is annotated, so the harness defaults gate all of
   * them and the risk list from an unreadable entry comes back empty. `audit-tools` then printed
   * "Every reachable tool is annotated. The default policy gates what it claims to gate." and
   * exited 0 for a repository whose only spec could not be read.
   */
  const dir = mkdtempSync(join(tmpdir(), 'policies-'));
  writeFileSync(join(dir, 'broken.json'), '{ not json');
  const tools = [
    { name: 'restart_service', annotations: { destructiveHint: true } },
    { name: 'ack_alert', annotations: { readOnlyHint: false } },
    { name: 'get_alert', annotations: { readOnlyHint: true } },
  ];

  const entries = policiesFor('ops', dir);
  const asIfPolicies = entries.flatMap((entry) => ungatedRisks(tools, entry.approval, entry.enabled));
  assert.deepEqual(asIfPolicies, [], 'read as a policy, an unreadable spec clears a connector it never described');

  // Split apart, there is nothing left to audit against and a name to report instead.
  const { policies, unreadable } = splitPolicies(entries);
  assert.deepEqual(policies, []);
  assert.deepEqual(unreadable, ['broken']);
});

test('a server no spec declares has no policies, and no invented one', () => {
  const dir = specs({ a: { name: 'a', manifest: { mcp_servers: [{ name: 'other' }] } } });
  assert.deepEqual(policiesFor('ops', dir), []);
});
