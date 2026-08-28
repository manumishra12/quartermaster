import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorityOf, covers, isGated, widening } from './authority.mjs';

const spec = (mcp_servers, config = {}) => ({ manifest: { mcp_servers, config: { sandbox: { enabled: false }, dynamic_sub_agents: { enabled: false }, ...config } } });

test('the harness defaults are compared as what they do, not as silence', () => {
  /**
   * A server entry with no `enable_tools` reaches everything, and one with no
   * `require_approval_for_tools` gates writes and destructives. Reading an omission as "nothing"
   * would make the widest possible spec compare as the narrowest, which is the wrong direction for
   * every question this file is asked.
   */
  const bare = authorityOf(spec([{ name: 'github' }]));
  assert.ok(bare.servers.get('github').enabled.has('@all'));
  assert.deepEqual([...bare.servers.get('github').gated].sort(), ['@destructive', '@write']);
});

test('a receiver that can reach a connector the sender cannot is a widening', () => {
  const from = authorityOf(spec([{ name: 'front-desk', enable_tools: ['list_issues'] }]));
  const to = authorityOf(spec([{ name: 'front-desk', enable_tools: ['list_issues'] }, { name: 'github', enable_tools: ['@all'] }]));

  const found = widening(from, to);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'connector');
  assert.equal(found[0].server, 'github');
});

test('the laundering case: both reach the tool, only the sender must ask', () => {
  /**
   * This is the finding the whole file exists for, and the one that looks fine in either spec read
   * on its own. Neither agent is misconfigured. The hole is the pair.
   */
  const from = authorityOf(spec([{ name: 'ops-desk', enable_tools: ['rollback_deploy'], require_approval_for_tools: ['rollback_deploy'] }]));
  const to = authorityOf(spec([{ name: 'ops-desk', enable_tools: ['rollback_deploy'], require_approval_for_tools: [] }]));

  const found = widening(from, to);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'approval');
  assert.equal(found[0].capability, 'rollback_deploy');
});

test('a gate the receiver keeps is not a widening', () => {
  const gated = spec([{ name: 'ops-desk', enable_tools: ['rollback_deploy'], require_approval_for_tools: ['rollback_deploy'] }]);
  assert.deepEqual(widening(authorityOf(gated), authorityOf(gated)), []);
});

test('a shell the sender does not have is the largest widening available', () => {
  /**
   * Nothing gates a shell. An agent with no sandbox that can hand its work to one with a sandbox
   * has a sandbox, and looking only at `mcp_servers` would never see it.
   */
  const from = authorityOf(spec([]));
  const to = authorityOf(spec([], { sandbox: { enabled: true } }));
  assert.deepEqual(widening(from, to).map((w) => w.kind), ['sandbox']);
});

test('subagents count, and an omitted setting counts as enabled', () => {
  /**
   * The SDK's own default is true, so a spec that says nothing permits them. Comparing the
   * omission as `false` would report the permissive spec as the restrictive one.
   */
  const silent = authorityOf({ manifest: { config: {} } });
  assert.equal(silent.subAgents, true);
  assert.deepEqual(widening(authorityOf(spec([])), silent).map((w) => w.kind), ['sub-agents']);
});

test('coverage is only ever concluded from what the spec literally says', () => {
  /**
   * `@read-only` very likely does cover `get_file_contents`, but deciding that needs the
   * annotations a server publishes at runtime, and this has to answer in CI with nothing
   * connected. So it reports a widening it cannot rule out. Over-reporting names a safe handoff;
   * the error in the other direction blesses an unsafe one.
   */
  assert.equal(covers(new Set(['@read-only']), 'get_file_contents'), false);
  assert.equal(covers(new Set(['@all']), 'anything_at_all'), true);
  assert.equal(covers(new Set(['get_file_contents']), 'get_file_contents'), true);
  assert.equal(isGated(new Set(['@all']), 'whatever'), true);
});

test('a connector named twice is the union of both entries', () => {
  /**
   * Taking the last would drop a policy somebody wrote, and report an agent as narrower than the
   * harness will actually run it.
   */
  const both = authorityOf(spec([
    { name: 'github', enable_tools: ['get_file_contents'], require_approval_for_tools: [] },
    { name: 'github', enable_tools: ['create_branch'], require_approval_for_tools: ['create_branch'] },
  ]));
  assert.deepEqual([...both.servers.get('github').enabled].sort(), ['create_branch', 'get_file_contents']);
  assert.ok(both.servers.get('github').gated.has('create_branch'));
});

test('the handoff count in the documents is the count the specs produce', () => {
  /**
   * It said 15 in four documents and the answer was 10. Nothing was wrong when it was written -
   * giving `analytics` the warehouse connector removed five safe pairs, and no document knows when
   * a spec changes. A number stated in prose and computed nowhere is a number that drifts, and this
   * project's whole argument is against exactly that, so the prose is now checked against the code.
   *
   * Deliberately not asserting 10. The count is whatever the specs say today; what must hold is
   * that every document agrees with them.
   */
  const dir = fileURLToPath(new URL('../../agents/', import.meta.url));
  const names = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  const authority = (n) => authorityOf(JSON.parse(readFileSync(join(dir, `${n}.json`), 'utf8')));

  let clean = 0;
  let pairs = 0;
  for (const from of names) {
    for (const to of names) {
      if (from === to) continue;
      pairs += 1;
      if (widening(authority(from), authority(to)).length === 0) clean += 1;
    }
  }

  const root = fileURLToPath(new URL('../../', import.meta.url));
  const stated = [];
  for (const file of readdirSync(root).filter((f) => f.endsWith('.md'))) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const match of text.matchAll(/(\d+)\s+(?:are handoffs that )?widen nothing/g)) {
      stated.push({ file, count: Number(match[1]) });
    }
    for (const match of text.matchAll(/(\d+) directed pairs/g)) {
      // The denominator drifts too - adding an agent changes it and nothing would have said so.
      assert.equal(Number(match[1]), pairs, `${file} says ${match[1]} directed pairs; there are ${pairs}`);
    }
  }

  assert.ok(stated.length > 0, 'no document states the count any more, so this check is watching nothing');
  for (const { file, count } of stated) {
    assert.equal(count, clean, `${file} says ${count} handoffs widen nothing; the specs give ${clean}`);
  }
});
