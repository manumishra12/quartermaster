import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('an unannotated tool reached only by an explicit allowlist is contained, not a risk', () => {
  // Real case: deepwiki ships in the TrueForge catalog with no annotations on any of its tools.
  // Naming them in enable_tools means a tool the server adds later is not enabled at all.
  const tools = [{ name: 'ask_question', annotations: undefined }];
  assert.equal(ungatedRisks(tools).length, 1);
  assert.equal(ungatedRisks(tools, undefined, ['ask_question', 'read_wiki_contents']).length, 0);
});

test('an allowlist that also carries a tag is still a risk - the tag is the wide door', () => {
  const tools = [{ name: 'ask_question', annotations: undefined }];
  assert.equal(ungatedRisks(tools, undefined, ['@all', 'ask_question']).length, 1);
});

test('a tool absent from the allowlist is unreachable, so it is not a risk', () => {
  // This test used to assert the opposite, and it was wrong. If enable_tools names one tool, every
  // other tool on that server is disabled and cannot be called - there is nothing to gate. Qodo
  // caught it on PR #1. The test had agreed with the bug, which is exactly the failure mode the
  // review guidelines in .pr_agent.toml ask reviewers to look for.
  const tools = [{ name: 'delete_everything', annotations: undefined }];
  assert.equal(ungatedRisks(tools, undefined, ['ask_question']).length, 0);
});

test('a tool the allowlist excludes cannot run, so it is not a risk either', () => {
  // Found by Qodo on PR #1. Only forgiving the named tools meant every tool the allowlist
  // *excluded* was reported as ungated - the audit failing loudest for the specs doing it right.
  const tools = [
    { name: 'ask_question', annotations: undefined },
    { name: 'delete_wiki', annotations: undefined },
  ];
  assert.equal(ungatedRisks(tools, undefined, ['ask_question']).length, 0);
});

test('a tag in the allowlist reopens the door, so unannotated tools are risks again', () => {
  const tools = [{ name: 'delete_wiki', annotations: undefined }];
  assert.equal(ungatedRisks(tools, undefined, ['@all', 'ask_question']).length, 1);
});

test('the two quartermaster specs declare the same deepwiki policy', () => {
  // Qodo flagged the duplication on PR #1: the same approval policy is written into both specs and
  // can drift. Agent specs are plain JSON with no include mechanism, and inventing one would put a
  // build step between a reviewer and the safety policy they are trying to read. So the duplication
  // stays and this test catches the drift instead.
  const read = (name) =>
    JSON.parse(readFileSync(new URL(`../../agents/${name}.json`, import.meta.url), 'utf8'))
      .manifest.mcp_servers.find((s) => s.name === 'deepwiki');

  const local = read('quartermaster-local');
  const full = read('quartermaster');
  assert.deepEqual(local.enable_tools, full.enable_tools);
  assert.deepEqual(local.require_approval_for_tools, full.require_approval_for_tools);
});

test('an allowlist contains what a server might add, not what it admits', () => {
  /**
   * The check stopped at "no tags, so nothing unexpected can appear" and cleared every tool -
   * including one the allowlist deliberately enables. A spec enabling `delete_repo` by name and
   * gating only `@write`, which does not match a destructive tool, was reported clean, and
   * `audit-tools` printed GATED beside it and exited 0 saying the policy gates what it claims to.
   */
  const destructive = [{ name: 'delete_repo', annotations: { destructiveHint: true } }];
  assert.equal(ungatedRisks(destructive, ['@write'], ['delete_repo']).length, 1);

  // Naming it in the gate as well is what makes it safe.
  assert.equal(ungatedRisks(destructive, ['delete_repo'], ['delete_repo']).length, 0);

  // A tool the allowlist excludes still cannot run, so it is still not a risk.
  const other = [{ name: 'fork_repository', annotations: { destructiveHint: true } }];
  assert.equal(ungatedRisks(other, ['@write'], ['delete_repo']).length, 0);
});

test('an unannotated tool named in the allowlist is contained, and that is deliberate', () => {
  /**
   * The distinction that keeps the fix above from being over-eager. For a tool whose annotations
   * say nothing, naming it is the strongest statement available - we cannot tell what it does, so
   * the allowlist is the containment. deepwiki ships exactly this way and TOOLS.md records it.
   */
  const unannotated = [{ name: 'ask_question', annotations: undefined }];
  assert.equal(ungatedRisks(unannotated, undefined, ['ask_question']).length, 0);

  // But a tag alongside the names re-opens the door, so it is a risk again.
  assert.equal(ungatedRisks(unannotated, undefined, ['@all', 'ask_question']).length, 1);
});
