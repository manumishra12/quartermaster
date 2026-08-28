import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contrast, luminance, readThemes, PAIRS } from './contrast.mjs';

const THEMES = readThemes(new URL('../../ui/src/styles/tokens.css', import.meta.url).pathname);

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

test('no interactive control is drawn with the region-separator border', () => {
  /**
   * The tokens were always right; the usage was not. `--qm-border-soft` is 1.18:1 and exists to
   * separate regions, which WCAG 1.4.11 does not cover. Four things you can click or tab into were
   * drawn with it anyway - the quick-action chips, the sidebar's icon button, the suggestion cards
   * on the welcome screen, and the scrollable output region once it became focusable.
   *
   * Checked by reading the files, because this is a mistake made in a className rather than in a
   * palette, and nothing about the palette can catch it.
   */
  const dir = fileURLToPath(new URL('../../ui/src/layout/', import.meta.url));
  const offenders = [];

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))) {
    const source = readFileSync(join(dir, file), 'utf8');
    for (const line of source.split('\n')) {
      if (!line.includes('border-line-soft')) continue;
      // A control is something you click, tab into, or type in.
      if (/cursor-pointer|<button|<input|<select|<textarea|tabIndex=\{0\}/.test(line)) {
        offenders.push(`${file}: ${line.trim().slice(0, 90)}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `use border-line (3:1) on controls, not border-line-soft (1.18:1):\n${offenders.join('\n')}`);
});
