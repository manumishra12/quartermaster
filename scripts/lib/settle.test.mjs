import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settledWithin } from './settle.mjs';

const after = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const failsAfter = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('stream died')), ms));

test('work that finishes inside the budget reports that it finished', async () => {
  assert.equal(await settledWithin(after(1, 'done'), 500), true);
});

test('work that does not finish reports that, rather than hanging or throwing', async () => {
  assert.equal(await settledWithin(after(500, 'done'), 1), false);
});

test('a failure is settling too - the caller wanted to know it stopped, not that it succeeded', async () => {
  assert.equal(await settledWithin(failsAfter(1), 500), true);
});

test('a rejection arriving after the budget does not escape', async () => {
  /**
   * The whole reason this exists. Promise.race abandons the loser without handling it, so a stream
   * that failed after its case had already timed out took the entire suite down with an unhandled
   * rejection - one slow agent killing the run of every agent after it.
   */
  const late = failsAfter(20);
  assert.equal(await settledWithin(late, 1), false);
  // Give the rejection time to land where an unhandled one would be reported.
  await after(60);
  // And it is still absorbed if the caller waits again, which is what the cancel path does.
  assert.equal(await settledWithin(late, 100), true);
});

test('a value that is not a promise settles immediately', async () => {
  // The smoke runner passes whatever its drain returned; it must not depend on it being a promise.
  assert.equal(await settledWithin('already done', 1), true);
});
