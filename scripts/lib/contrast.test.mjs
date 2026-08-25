import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, luminance, readTokens, PAIRS } from './contrast.mjs';

const TOKENS = readTokens(new URL('../../ui/src/styles/tokens.css', import.meta.url).pathname);

test('the stylesheet actually declares the tokens the UI references', () => {
  for (const { fg, bg } of PAIRS) {
    assert.ok(TOKENS[fg], `missing token ${fg}`);
    assert.ok(TOKENS[bg], `missing token ${bg}`);
  }
});

test('luminance is right at the ends of the range', () => {
  assert.equal(luminance('#000000'), 0);
  assert.ok(Math.abs(luminance('#ffffff') - 1) < 1e-9);
});

test('contrast is symmetric and peaks at 21:1', () => {
  assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 1e-6);
  assert.equal(contrast('#0f172a', '#f8fafc'), contrast('#f8fafc', '#0f172a'));
});

for (const { name, fg, bg, min } of PAIRS) {
  test(`${name} meets ${min}:1`, () => {
    const ratio = contrast(TOKENS[fg], TOKENS[bg]);
    assert.ok(
      ratio >= min,
      `${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${min}:1. Adjust the token, not the threshold.`,
    );
  });
}
