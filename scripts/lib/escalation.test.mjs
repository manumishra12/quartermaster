import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESCALATED, REASONS, escalate, isEscalation, renderEscalation, runOutcome } from './escalation.mjs';
import { runExitCode } from './turn-state.mjs';

test('an escalation is not a success, whatever the verdict said about the answer', () => {
  /**
   * An escalated run can still hold a perfectly well-substantiated partial answer, and exiting 0 on
   * the strength of it tells CI the work is done. Whether the run finished comes before whether its
   * answer was any good, which is a question `runExitCode` already asks in the right order - so this
   * feeds `unfinished` rather than inventing a second opinion about the same run.
   */
  const raised = escalate({ because: REASONS.CONFLICTING_EVIDENCE, detail: 'the suite passed locally and failed in CI' });
  assert.equal(runExitCode({ proved: true, ...runOutcome(raised) }), 1);
  assert.equal(runExitCode({ proved: true }), 0, 'the same run without the escalation would have exited 0');
});

test('runOutcome speaks the vocabulary the exit code already has', () => {
  // A parallel set of outcome fields is how two systems end up disagreeing about one run.
  assert.deepEqual(runOutcome(escalate({ because: REASONS.LOOP_DETECTED })), { unfinished: true });
  // Anything that is not an escalation contributes nothing, so spreading it is always safe.
  assert.deepEqual(runOutcome(null), {});
  assert.deepEqual(runOutcome({ outcome: 'finished' }), {});
  assert.equal(runExitCode({ proved: true, ...runOutcome('not an escalation') }), 0);
});

test('it carries what was established as well as what was not', () => {
  /**
   * "I do not know" on its own throws away the part worth having. Everything the run did establish
   * on the way is the reason the person picking this up does not start from nothing.
   */
  const raised = escalate({
    because: REASONS.OUTCOME_UNKNOWN,
    detail: 'the turn failed after the rollback was approved',
    established: ['the approval was granted at 03:14', 'the call was dispatched'],
    notEstablished: ['whether the rollback took effect'],
    next: ['read the running version of checkout'],
  });

  assert.equal(raised.outcome, ESCALATED);
  assert.equal(raised.established.length, 2);
  assert.deepEqual(raised.notEstablished, ['whether the rollback took effect']);
  assert.deepEqual(raised.next, ['read the running version of checkout']);
});

test('an escalation with no reason is still an escalation', () => {
  /**
   * Throwing here would lose it, and a lost escalation is reported by everything downstream as a
   * run that finished - the single outcome this file exists to prevent. A missing reason is a bug
   * in the caller, and it belongs in the artifact where somebody will see it rather than in a stack
   * trace that takes the report with it.
   */
  const raised = escalate({});
  assert.equal(isEscalation(raised), true);
  assert.equal(raised.because, REASONS.UNSTATED);
  assert.match(raised.detail, /no reason was given/);
  assert.equal(runExitCode({ proved: true, ...runOutcome(raised) }), 1);

  // A reason this file does not know is not silently accepted as one either.
  assert.equal(escalate({ because: 'because I said so' }).because, REASONS.UNSTATED);
});

test('nothing put in the lists is quietly dropped', () => {
  // A dropped item is a fact the person reading this does not get to see, and handing over
  // everything it has is the entire value of an escalation.
  const raised = escalate({ because: REASONS.LOOP_DETECTED, established: ['a', { count: 3 }, 0, ''], notEstablished: 'one thing' });
  assert.deepEqual(raised.established, ['a', '{"count":3}', '0']);
  assert.deepEqual(raised.notEstablished, ['one thing'], 'a bare string is one item, not a list of characters');
});

test('isEscalation does not settle for a truthy field', () => {
  assert.equal(isEscalation({ escalated: true }), false);
  assert.equal(isEscalation('escalated'), false);
  assert.equal(isEscalation(null), false);
  assert.equal(isEscalation({ outcome: ESCALATED }), true);
});

test('the render escapes what it prints, because none of it was written here', () => {
  /**
   * Every line in an escalation came from somewhere - a tool result, the model's own words, an
   * argument value. A "what was established" line carrying an escape sequence would rewrite the
   * report a person is reading in order to decide what to do next, which is the worst possible
   * moment to be lied to. The approval display already learned this; the same function enforces it
   * here rather than a second copy that can drift.
   */
  const raised = escalate({ because: REASONS.APPROVAL_STALE, established: [`a${String.fromCharCode(27)}[2Jforged line`] });
  const text = renderEscalation(raised).join('\n');
  assert.ok(!text.includes(String.fromCharCode(27)), 'an escape sequence reached the terminal');
  assert.match(text, /\\x1b/);
  assert.match(text, /ESCALATED/);
  assert.match(text, /This did not finish/);
});

test('an empty section says it is empty rather than printing nothing', () => {
  // A heading with nothing under it reads as an oversight in the renderer. Saying "nothing was
  // named, which is worth asking about" is the difference between a gap and a bug.
  const text = renderEscalation(escalate({ because: REASONS.BUDGET_EXHAUSTED })).join('\n');
  assert.match(text, /nothing was established/);
  assert.match(text, /worth asking about/);
  assert.deepEqual(renderEscalation({ outcome: 'finished' }), []);
});
