import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, wouldBeGated, ungatedRisks, UNANNOTATED } from './annotations.mjs';

test('classify matches the harness selectors', () => {
  assert.equal(classify({ readOnlyHint: true }), 'read-only');
  assert.equal(classify({ readOnlyHint: false }), 'write');
  assert.equal(classify({ readOnlyHint: false, destructiveHint: true }), 'destructive');
  assert.equal(classify(undefined), UNANNOTATED);
  assert.equal(classify({}), UNANNOTATED);
});

test('destructive wins over write when both hints are present', () => {
  assert.equal(classify({ readOnlyHint: false, destructiveHint: true }), 'destructive');
});

test('the default policy gates writes and destructive calls', () => {
  assert.equal(wouldBeGated('push', { readOnlyHint: false }), true);
  assert.equal(wouldBeGated('delete_repo', { destructiveHint: true }), true);
  assert.equal(wouldBeGated('get_issue', { readOnlyHint: true }), false);
});

test('the default policy does NOT gate an unannotated tool - the whole point of this file', () => {
  assert.equal(wouldBeGated('create_pull_request', undefined), false);
});

test('@all gates everything, including unannotated tools', () => {
  assert.equal(wouldBeGated('create_pull_request', undefined, ['@all']), true);
  assert.equal(wouldBeGated('get_issue', { readOnlyHint: true }, ['@all']), true);
});

test('a literal name gates a tool the annotations would have missed', () => {
  assert.equal(wouldBeGated('create_pull_request', undefined, ['@write', 'create_pull_request']), true);
});

test('ungatedRisks reports unannotated tools but not read-only ones', () => {
  const tools = [
    { name: 'get_issue', annotations: { readOnlyHint: true } },
    { name: 'create_pull_request', annotations: undefined },
    { name: 'push_files', annotations: { readOnlyHint: false } },
  ];
  assert.deepEqual(ungatedRisks(tools).map((t) => t.name), ['create_pull_request']);
});

test('an empty policy gates nothing', () => {
  assert.equal(wouldBeGated('push', { readOnlyHint: false }, []), false);
});

test('a tool claiming to be both read-only and destructive is treated as destructive', () => {
  // Contradictory, but a real possibility from a sloppy MCP server. Reading it as read-only would
  // drop it from the risk list entirely.
  assert.equal(classify({ readOnlyHint: true, destructiveHint: true }), 'destructive');
  assert.equal(ungatedRisks([{ name: 'wipe', annotations: { readOnlyHint: true, destructiveHint: true } }]).length, 0);
  assert.equal(
    ungatedRisks([{ name: 'wipe', annotations: { readOnlyHint: true, destructiveHint: true } }], ['@write']).length,
    1,
  );
});
