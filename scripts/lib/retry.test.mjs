import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ATTEMPTS, retryDecision, statedDelay } from './retry.mjs';

const rate = 'Request failed (429): Quota exceeded for quota metric requests per minute';
const none = () => 0;

test('a per-minute rate limit is waited out rather than handed back to a person', () => {
  /**
   * The message itself says it clears on its own. Printing that and stopping left somebody
   * re-running by hand the one failure that did not need them.
   */
  const decision = retryDecision({ failure: rate, random: none });
  assert.equal(decision.retry, true);
  assert.ok(decision.waitMs >= 30_000, `waited ${decision.waitMs}ms against a per-minute limit`);
});

test('a daily quota is not retried, because waiting will not clear it', () => {
  const decision = retryDecision({ failure: '429 quota exceeded, per day limit reached', random: none });
  assert.equal(decision.retry, false);
  assert.match(decision.why, /daily quota/);
});

test('a rejected key is not retried', () => {
  assert.equal(retryDecision({ failure: '401 unauthorized: api key not valid', random: none }).retry, false);
});

test('an approved turn is never retried, whatever the failure was', () => {
  /**
   * The rule this file exists to get right. The call went out, the failure came back, and nothing
   * here can tell whether the write landed. Retrying is a coin-flip on filing the ticket twice.
   */
  const decision = retryDecision({ failure: rate, approvals: 1, random: none });
  assert.equal(decision.retry, false);
  assert.match(decision.why, /risks doing it twice/);
});

test('attempts are bounded, and the last word says how many were spent', () => {
  const decision = retryDecision({ failure: rate, attempt: MAX_ATTEMPTS, random: none });
  assert.equal(decision.retry, false);
  assert.match(decision.why, /already been tried/);
});

test('the wait grows with the attempt', () => {
  const first = retryDecision({ failure: '503 service unavailable', attempt: 1, random: none });
  const second = retryDecision({ failure: '503 service unavailable', attempt: 2, random: none });
  assert.ok(second.waitMs > first.waitMs);
});

test('a delay the provider named beats any guess made here', () => {
  assert.equal(statedDelay('rate limited, retryDelay: 7s'), 7000);
  assert.equal(statedDelay('please try again in 12 seconds'), 12_000);
  const decision = retryDecision({ failure: '503 unavailable, retry-after: 9', random: none });
  assert.equal(decision.waitMs, 9000);
});

test('an hour is a refusal wearing a delay, and is not waited out', () => {
  assert.equal(statedDelay('retry-after: 3600'), null);
  assert.equal(statedDelay('no delay mentioned'), null);
});

test('jitter separates concurrent runs and stays inside a quarter', () => {
  /**
   * Bounded rather than merely present: an unbounded multiplier turns a two-second backoff into
   * something nobody predicted, and the test that never checks the ceiling is how it gets there.
   */
  const low = retryDecision({ failure: '503 unavailable', random: () => 0 });
  const high = retryDecision({ failure: '503 unavailable', random: () => 1 });
  assert.ok(high.waitMs > low.waitMs);
  assert.ok(high.waitMs <= low.waitMs * 1.25);
});

test('a failure with no classification is not retried on principle', () => {
  /**
   * Most turn failures are a tool that threw or a bug in this repository, and running those again
   * produces the same failure more slowly.
   */
  assert.equal(retryDecision({ failure: 'the agent ran out of iterations', random: none }).retry, false);
});
