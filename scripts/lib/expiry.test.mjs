import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WINDOW_MS, EXPIRED, STALE, UNCHECKED, UNSTAMPED, VALID, evidenceDigest, stamp, stillValid } from './expiry.mjs';

/** What the operator was looking at when they said yes. */
const seen = { deploy: '4c21', errorRate: 0.42, alerts: ['checkout-5xx'] };

test('nothing changed and the deadline has not passed, so the approval still stands', () => {
  /**
   * The case that has to keep working. A control that voids approvals on the ordinary path is one
   * somebody turns off, and then none of the interesting cases are checked either.
   */
  const mark = stamp({ evidence: seen, at: 1_000, windowMs: 60_000 });
  const still = stillValid(mark, { now: 31_000, evidence: seen });
  assert.equal(still.valid, true);
  assert.equal(still.state, VALID);
  assert.equal(still.msLeft, 30_000);
});

test('the same evidence written in a different order is not a change', () => {
  /**
   * Spurious staleness is as damaging as missed staleness. An approval voided because a metrics
   * payload serialised its keys differently teaches the operator that re-asks are noise, and the
   * next one they wave through is the one that mattered.
   */
  const mark = stamp({ evidence: { deploy: '4c21', errorRate: 0.42 }, at: 0, windowMs: 60_000 });
  assert.equal(stillValid(mark, { now: 1, evidence: { errorRate: 0.42, deploy: '4c21' } }).valid, true);
  assert.equal(evidenceDigest({ a: 1, b: 2 }), evidenceDigest({ b: 2, a: 1 }));
});

test('expired and stale are different answers to the person being re-asked', () => {
  /**
   * They read the same to a naive implementation and mean opposite things. Expired says "you
   * approved this and we were slow" - the same question again. Stale says "you approved this and it
   * is no longer that" - a different question wearing the same words. Collapsing them trains
   * somebody to wave both through, and the one they should have read was the second.
   */
  const mark = stamp({ evidence: seen, at: 1_000, windowMs: 60_000 });

  const late = stillValid(mark, { now: 200_000, evidence: seen });
  assert.equal(late.state, EXPIRED);
  assert.equal(late.stale, false);
  assert.match(late.why, /deadline/);

  const moved = stillValid(mark, { now: 2_000, evidence: { ...seen, errorRate: 0.01 } });
  assert.equal(moved.state, STALE);
  assert.equal(moved.expired, false);
  assert.match(moved.why, /changed/);

  assert.notEqual(late.state, moved.state);
});

test('when both are true, the change is the thing reported', () => {
  /**
   * The deadline is the less informative fact - an old approval being re-asked is routine. That the
   * world moved is what the person needs to see, and burying it under "it expired" is how somebody
   * re-approves the rollback of a deploy that is no longer the one that broke anything.
   */
  const mark = stamp({ evidence: seen, at: 1_000, windowMs: 60_000 });
  const both = stillValid(mark, { now: 500_000, evidence: { ...seen, deploy: '9f03' } });
  assert.equal(both.state, STALE);
  assert.equal(both.expired, true, 'the deadline is still reported, it is just not the headline');
});

test('a bound approval with nothing offered back is not valid, it is unchecked', () => {
  /**
   * Returning valid here would claim a comparison that never happened - the whole point of binding
   * the evidence is that executing re-checks it, and an approval nobody re-checked has not been
   * re-checked whatever the clock says.
   */
  const mark = stamp({ evidence: seen, at: 1_000, windowMs: 60_000 });
  const check = stillValid(mark, { now: 2_000 });
  assert.equal(check.valid, false);
  assert.equal(check.state, UNCHECKED);

  // Explicitly passing null is a comparison, and it is a failing one - null is not this evidence.
  assert.equal(stillValid(mark, { now: 2_000, evidence: null }).state, STALE);
});

test('an approval bound to no evidence is judged on time alone', () => {
  // There is nothing to compare, and saying "unchecked" would demand evidence the caller never had.
  const mark = stamp({ at: 1_000, windowMs: 60_000 });
  assert.equal(stillValid(mark, { now: 2_000 }).valid, true);
  assert.equal(stillValid(mark, { now: 500_000 }).state, EXPIRED);
});

test('an approval that was never stamped cannot be shown to be valid', () => {
  /**
   * Defaulting to valid would make an unstamped approval the most durable kind there is - every
   * approval that skipped this control would outlive every approval that used it.
   */
  for (const bad of [null, undefined, {}, 'yes', { expiresAt: 'soon' }]) {
    const check = stillValid(bad, { now: 1 });
    assert.equal(check.valid, false);
    assert.equal(check.state, UNSTAMPED);
  }
});

test('a window that is not a window falls back to the default rather than to forever', () => {
  /**
   * `windowMs: 0` or a typo would otherwise silently remove the deadline, and the approval nobody
   * noticed had no expiry is the one that gets executed an hour late.
   */
  for (const bad of [0, -1, 'soon', null, NaN]) {
    assert.equal(stamp({ at: 0, windowMs: bad }).windowMs, DEFAULT_WINDOW_MS);
  }
  assert.equal(stamp({ at: 0, windowMs: 1_000 }).expiresAt, 1_000);
});

test('the default window is minutes, not hours', () => {
  // Long enough to read a forty-line call display and think about it; short enough that it cannot
  // outlive a deploy pipeline, an alert window or a pager escalation.
  assert.ok(DEFAULT_WINDOW_MS >= 60_000, 'shorter than a minute expires while somebody is reading');
  assert.ok(DEFAULT_WINDOW_MS <= 10 * 60_000, 'longer than ten minutes outlives the situation it was granted in');
});
