import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BUDGET, DEFAULT_LOOP_THRESHOLD, budgetFrom, callSignature, checkBudget, detectLoop } from './limits.mjs';
import { escalate, isEscalation, REASONS, runOutcome } from './escalation.mjs';
import { runExitCode } from './turn-state.mjs';

const call = (tool, args) => ({ tool, args });

test('a poll that alternates is not a loop', () => {
  /**
   * Waiting on something and doing something about it in between is the shape of ordinary work.
   * A rule that fires on "this tool appeared three times" would flag every health check in the
   * project, and a control that fires on normal work is a control somebody turns off.
   */
  const alternating = [call('get_health', { service: 'checkout' }), call('scale_service', { service: 'checkout', to: 4 })];
  const calls = [...alternating, ...alternating, ...alternating, ...alternating];
  assert.equal(detectLoop(calls).looping, false);
});

test('the same call three times in a row is a loop', () => {
  /**
   * Two is a retry, and retrying once is normal - retry.mjs is an entire file arguing for it.
   * Three is the first count that cannot be explained as one: nothing was learned from the second
   * or the third.
   */
  const calls = [call('get_health', { service: 'checkout' }), ...Array(3).fill(call('restart_service', { service: 'checkout' }))];
  const found = detectLoop(calls);
  assert.equal(found.looping, true);
  assert.equal(found.tool, 'restart_service');
  assert.equal(found.count, 3);
  assert.equal(found.trailing, true);
  assert.match(found.why, /stopped learning/);
});

test('two in a row is a retry and is left alone', () => {
  const calls = [call('restart_service', { service: 'checkout' }), call('restart_service', { service: 'checkout' })];
  assert.equal(detectLoop(calls).looping, false);
});

test('a loop is detected on the canonical arguments, not on the text of them', () => {
  /**
   * A model that reorders its own JSON between attempts defeats a string comparison completely, and
   * models do reorder. The detector would go quiet at the exact moment the repetition started
   * looking slightly different each time, which is the worst possible time for it to go quiet.
   */
  const calls = [
    call('rollback_deploy', '{"service":"checkout","force":true}'),
    call('rollback_deploy', '{"force":true,"service":"checkout"}'),
    call('rollback_deploy', { force: true, service: 'checkout' }),
  ];
  assert.equal(detectLoop(calls).looping, true);
  assert.equal(callSignature(calls[0]), callSignature(calls[1]));
});

test('the same tool with different arguments is work, not repetition', () => {
  const calls = [call('read_file', { path: 'a' }), call('read_file', { path: 'b' }), call('read_file', { path: 'c' })];
  assert.equal(detectLoop(calls).looping, false);
});

test('a run that got out of a loop is still reported, and reported as past', () => {
  // Asked once at the end rather than after every call, this has to give the same answer - and
  // `trailing` is the difference between "it is stuck now" and "it was stuck and got out".
  const calls = [...Array(3).fill(call('get_logs', { since: '5m' })), call('rollback_deploy', { id: '4c21' })];
  const found = detectLoop(calls);
  assert.equal(found.looping, true);
  assert.equal(found.trailing, false);
});

test('the threshold is a parameter, and an empty history is not a loop', () => {
  const calls = [call('a', {}), call('a', {})];
  assert.equal(detectLoop(calls, { threshold: 2 }).looping, true);
  assert.equal(detectLoop([]).looping, false);
  assert.equal(detectLoop([call('a', {})]).looping, false);
  // A threshold below two would call every single call a loop.
  assert.equal(detectLoop(calls, { threshold: 1 }).threshold, DEFAULT_LOOP_THRESHOLD);
});

test('a budget overrun escalates rather than returning success', () => {
  /**
   * The rule the whole file exists for. A run that ran out of budget has not finished, and both
   * convenient answers are lies about it: "proceed" spends what nobody agreed to, and a silent stop
   * is reported by everything downstream as work that is done.
   */
  const check = checkBudget({ toolCalls: 61, approvals: 2 }, DEFAULT_BUDGET);
  assert.equal(check.within, false);
  assert.equal(check.escalate, true);
  assert.match(check.why, /has not finished/);
  assert.deepEqual(
    check.exceeded.map((e) => e.limit),
    ['toolCalls'],
  );
});

test('every ceiling that was passed is named, not just the first', () => {
  // Naming one of two invites somebody to raise that ceiling and run straight into the other.
  const check = checkBudget({ toolCalls: 500, approvals: 40, wallClockMs: 60 * 60_000 });
  assert.deepEqual(
    check.exceeded.map((e) => e.limit),
    ['toolCalls', 'approvals', 'wallClockMs'],
  );
});

test('inside the ceilings is inside them, and says how much is left', () => {
  const check = checkBudget({ toolCalls: 10, approvals: 1, wallClockMs: 1_000 });
  assert.equal(check.within, true);
  assert.equal(check.escalate, false);
  assert.equal(check.remaining.approvals, DEFAULT_BUDGET.approvals - 1);
  // Exactly at the ceiling is still inside it; a ceiling of ten means ten are allowed.
  assert.equal(checkBudget({ approvals: DEFAULT_BUDGET.approvals }).within, true);
});

test('a ceiling nobody set falls back to the default rather than to no limit', () => {
  /**
   * A typo in a config key silently removing a ceiling is the quiet failure this file exists for,
   * and it removes exactly the ceiling nobody noticed was missing. `Number(null)` is 0, which would
   * turn a half-filled budget into one that escalates on the first tool call.
   */
  assert.deepEqual(budgetFrom({}), { ...DEFAULT_BUDGET });
  assert.equal(budgetFrom({ approvals: null }).approvals, DEFAULT_BUDGET.approvals);
  assert.equal(budgetFrom({ approvals: 'lots' }).approvals, DEFAULT_BUDGET.approvals);
  assert.equal(budgetFrom({ approvals: -3 }).approvals, DEFAULT_BUDGET.approvals);
  assert.equal(budgetFrom({ approvals: 0 }).approvals, 0, 'zero is a real ceiling somebody may want');
  // Saying "no ceiling" has to be possible, and has to be said out loud in the call.
  assert.equal(budgetFrom({ approvals: Infinity }).approvals, Infinity);
  assert.equal(checkBudget({ approvals: 9_000 }, { approvals: Infinity }).within, true);
});

test('the approval ceiling is the smallest of the three, deliberately', () => {
  /**
   * It spends a person's attention, which is what every other control here is built on. By the
   * tenth prompt an operator is clearing prompts rather than reading calls, and a gate in front of
   * somebody who has stopped reading launders the decision instead of making it.
   */
  assert.ok(DEFAULT_BUDGET.approvals < DEFAULT_BUDGET.toolCalls);
  assert.ok(DEFAULT_BUDGET.approvals <= 10);
});

test('what a limit produces is an escalation, and an escalation does not exit 0', () => {
  /**
   * The join between the two files. A budget overrun that came out as a zero exit code would tell
   * CI the work was done, which is the same class of lie as reporting a test that never ran.
   */
  const check = checkBudget({ approvals: 99 });
  const raised = escalate({
    because: REASONS.BUDGET_EXHAUSTED,
    detail: check.why,
    established: ['the failing test was reproduced'],
    notEstablished: ['whether the fix works'],
    next: ['re-run with a larger approval ceiling, or answer the pending approvals'],
  });
  assert.equal(isEscalation(raised), true);
  assert.notEqual(runExitCode({ proved: true, ...runOutcome(raised) }), 0);
});

test('signing a signature returns it, so a caller passing either shape gets the same answer', () => {
  /**
   * The failure this prevents: run.mjs pushed signatures and detectLoop signed them again, so every
   * element hashed a string with no tool and no arguments and collapsed to one value. Three
   * different calls read as a loop, and every run escalated on its third tool response.
   */
  const call = { tool: 'bash', args: '{"c":1}' };
  const signed = callSignature(call);
  assert.equal(callSignature(signed), signed);

  const distinct = [
    { tool: 'bash', args: '{"c":1}' },
    { tool: 'read_file', args: '{"p":"a"}' },
    { tool: 'write_file', args: '{"p":"b"}' },
  ];
  assert.equal(detectLoop(distinct).looping, false);
  assert.equal(detectLoop(distinct.map(callSignature)).looping, false);
});
