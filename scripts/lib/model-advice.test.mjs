import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adviseOnFailure, explainFailure } from './model-advice.mjs';

/** The message a real run actually ended at, kept verbatim. */
const PER_MINUTE =
  "Request failed (429): Quota exceeded for quota metric 'Generate Content API requests per minute' " +
  "and limit 'GenerateContent request limit per minute for a region' of service " +
  "'generativelanguage.googleapis.com' for consumer 'project_number:592743037837'.";

test('a per-minute rate limit is told apart from a daily quota', () => {
  // Same status code, same shape of sentence, opposite answers. This is the whole point of the file.
  const burst = adviseOnFailure(PER_MINUTE);
  assert.equal(burst.cause, 'rate-limit');
  assert.match(burst.reason, /by the minute/);
  assert.match(burst.advice, /wait a minute/);

  const daily = adviseOnFailure("Request failed (429): Quota exceeded for quota metric 'requests per day'.");
  assert.equal(daily.cause, 'rate-limit');
  assert.match(daily.reason, /daily quota/);
  assert.match(daily.advice, /will not clear/);

  // And when the provider does not say which, it says it does not know rather than guessing the
  // comfortable answer.
  const vague = adviseOnFailure('Request failed (429): Too Many Requests');
  assert.match(vague.advice, /does not say over what period/);
});

test('every case offers the configuration that has no provider at all', () => {
  for (const message of [PER_MINUTE, "429 quota exceeded per day", '429 Too Many Requests']) {
    assert.match(adviseOnFailure(message).advice, /quartermaster-local/);
  }
});

test('the causes that can be told apart, are', () => {
  const cases = [
    ['Request failed (401): API key not valid. Please pass a valid API key.', 'credentials'],
    ['Request failed (404): model not found: gemini-3.6-flash', 'unknown-model'],
    ["This model's maximum context length is 200000 tokens", 'too-long'],
    ['Request failed (503): The model is overloaded. Please try again later.', 'provider-down'],
    ['Request failed: deadline exceeded', 'timeout'],
  ];
  for (const [message, cause] of cases) {
    assert.equal(adviseOnFailure(message)?.cause, cause, message);
  }
});

test('a failure that is not the provider gets no invented advice', () => {
  /**
   * The connector version of this file was wrong in exactly this direction first: it had a
   * confident answer for everything, and sent people to fix things that were not broken. Most turn
   * failures are the agent, a tool, or a bug here - none of which has generic advice worth giving.
   */
  for (const message of [
    'iteration limit reached',
    'the agent stopped without answering',
    'TypeError: cannot read property of undefined',
    '',
    null,
    undefined,
  ]) {
    assert.equal(adviseOnFailure(message), null, JSON.stringify(message));
  }
});

test('a message that is not classified is printed unchanged', () => {
  assert.equal(explainFailure('iteration limit reached'), 'iteration limit reached');
  assert.equal(explainFailure('   '), null);

  // And a classified one keeps its own text, with the advice added rather than substituted. The
  // provider's exact words are what somebody searches for when the advice turns out to be wrong.
  const explained = explainFailure(PER_MINUTE);
  assert.ok(explained.startsWith(PER_MINUTE));
  assert.match(explained, /wait a minute/);
});

test('a rate limit is read as a rate limit even though it is also a quota', () => {
  // Google's message contains "Quota exceeded" and "per minute" together. Ordering decides which
  // reading wins, so it is pinned rather than left to whichever pattern happens to come first.
  assert.match(adviseOnFailure(PER_MINUTE).advice, /clears on its own/);
});
