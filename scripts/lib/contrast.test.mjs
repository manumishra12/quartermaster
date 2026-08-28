import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, luminance, readThemes, PAIRS } from './contrast.mjs';
import { fromModule } from './paths.mjs';

const THEMES = readThemes(fromModule(import.meta.url, '../../ui/src/styles/tokens.css'));

test('the stylesheet declares both themes', () => {
  assert.deepEqual(Object.keys(THEMES).sort(), ['dark', 'light']);
});

test('luminance is right at the ends of the range', () => {
  assert.equal(luminance('#000000'), 0);
  assert.ok(Math.abs(luminance('#ffffff') - 1) < 1e-9);
});

test('contrast is symmetric and peaks at 21:1', () => {
  assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 1e-6);
  assert.equal(contrast('#0f172a', '#f8fafc'), contrast('#f8fafc', '#0f172a'));
});

// Every pair, in every theme. Shipping a second theme without testing it is shipping it untested.
for (const [themeName, tokens] of Object.entries(THEMES)) {
  test(`${themeName}: every token the UI references is declared`, () => {
    for (const { fg, bg } of PAIRS) {
      assert.ok(tokens[fg], `${themeName} is missing ${fg}`);
      assert.ok(tokens[bg], `${themeName} is missing ${bg}`);
    }
  });

  for (const { name, fg, bg, min } of PAIRS) {
    test(`${themeName}: ${name} meets ${min}:1`, () => {
      const ratio = contrast(tokens[fg], tokens[bg]);
      assert.ok(
        ratio >= min,
        `${themeName}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${min}:1. Adjust the token, not the threshold.`,
      );
    });
  }
}
