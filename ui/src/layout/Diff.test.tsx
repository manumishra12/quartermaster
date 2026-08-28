import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Diff, looksLikeDiff, parseDiff } from './Diff';

const PATCH = `--- a/ledger/rounding.py
+++ b/ledger/rounding.py
@@ -1,4 +1,6 @@
 def split_evenly(total, ways):
-    return [total // ways] * ways
+    base = total // ways
+    rest = total - base * ways
+    return [base + (1 if i < rest else 0) for i in range(ways)]`;

describe('recognising a patch', () => {
  test('a hunk header is the marker, not a leading dash', () => {
    expect(looksLikeDiff(PATCH)).toBe(true);
    expect(looksLikeDiff('anything', 'diff')).toBe(true);
    expect(looksLikeDiff('anything', 'patch')).toBe(true);
  });

  test('code that merely opens lines with + or - is not a patch', () => {
    /**
     * The detection has to be narrow. A CSS file of vendor prefixes and a shell script of flags
     * both start lines with these characters, and colouring half of either red because of that
     * would be worse than never rendering patches at all.
     */
    const css = '.a {\n  -webkit-box-shadow: none;\n  -moz-appearance: none;\n}';
    const shell = 'pytest -q\n--maxfail=1\n-x';
    for (const code of [css, shell, '', 'plain text']) {
      expect(looksLikeDiff(code)).toBe(false);
    }
  });
});

describe('reading a patch', () => {
  test('file headers are not counted as changed lines', () => {
    // `+++` and `---` open a diff and are not an addition and a deletion.
    const rows = parseDiff(PATCH);
    expect(rows.filter((r) => r.kind === 'add')).toHaveLength(3);
    expect(rows.filter((r) => r.kind === 'remove')).toHaveLength(1);
    expect(rows.filter((r) => r.kind === 'meta')).toHaveLength(2);
    expect(rows.filter((r) => r.kind === 'hunk')).toHaveLength(1);
  });

  test('the counts are shown with a sign, not only a colour', () => {
    render(<Diff code={PATCH} />);
    expect(screen.getByText('+3')).toBeInTheDocument();
    expect(screen.getByText('−1')).toBeInTheDocument();
  });

  test('the marker lives in the gutter and is not repeated in the line', () => {
    render(<Diff code={PATCH} />);
    /**
     * Matched without whitespace normalisation, because the indentation is the point: a patch
     * that loses its leading spaces is not a patch anybody can apply or read.
     */
    const cells = [...document.querySelectorAll('td')].map((td) => td.textContent);

    // The line keeps its indentation and loses its marker.
    expect(cells).toContain('    base = total // ways');
    // And no cell carries the marker inline - it is in the gutter cell, on its own.
    expect(cells.some((text) => text?.startsWith('+ ') || text?.startsWith('+   '))).toBe(false);
    expect(cells).toContain('+');
  });

  test('the patch scrolls inside itself and can be reached by keyboard', () => {
    // A wide patch must not push the page sideways, and a scrollable region a keyboard cannot
    // enter is content it cannot reach.
    render(<Diff code={PATCH} />);
    const region = screen.getByRole('region', { name: /3 lines added and 1 removed/i });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region.className).toMatch(/overflow-auto/);
  });
});
