import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retry } from '../src/retry.js';

test('returns the first successful result', async () => {
  assert.equal(await retry(async () => 'ok'), 'ok');
});

test('retries a failing call and succeeds on a later attempt', async () => {
  let calls = 0;
  const result = await retry(async () => {
    calls += 1;
    if (calls < 2) throw new Error('flaky');
    return 'recovered';
  });
  assert.equal(result, 'recovered');
});

test('uses the full attempt budget before giving up', async () => {
  // attempts is the total number of calls allowed. With attempts = 3, fn must be called 3 times.
  let calls = 0;
  await assert.rejects(
    retry(async () => {
      calls += 1;
      throw new Error('always fails');
    }, 3),
  );
  assert.equal(calls, 3);
});

test('rejects a nonsensical attempt budget', async () => {
  await assert.rejects(retry(async () => 'x', 0), RangeError);
});
