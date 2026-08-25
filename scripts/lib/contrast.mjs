/**
 * WCAG contrast maths, and the token pairs this interface actually renders.
 *
 * Colour choices drift. Somebody nudges a token to make a screenshot look better and a label
 * quietly drops below 4.5:1, which nobody notices because it still looks fine to whoever changed
 * it. Encoding the pairs as a test makes that a build failure instead of a regression.
 */
import { readFileSync } from 'node:fs';

const channel = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export function luminance(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Read the declared tokens straight from the stylesheet, so the test cannot drift from the source. */
export function readTokens(path) {
  const css = readFileSync(path, 'utf8');
  const tokens = {};
  for (const [, name, value] of css.matchAll(/(--qm-[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    tokens[name] = value.toLowerCase();
  }
  return tokens;
}

/**
 * Every foreground/background pair the rail puts on screen.
 * 4.5:1 for text (WCAG 1.4.3); 3:1 for control boundaries (WCAG 1.4.11).
 */
export const PAIRS = [
  { name: 'body text on background', fg: '--qm-text', bg: '--qm-bg', min: 4.5 },
  { name: 'muted text on background', fg: '--qm-text-muted', bg: '--qm-bg', min: 4.5 },
  { name: 'muted text on surface', fg: '--qm-text-muted', bg: '--qm-surface', min: 4.5 },
  { name: 'accent on background', fg: '--qm-accent', bg: '--qm-bg', min: 4.5 },
  { name: 'verified on surface', fg: '--qm-verified', bg: '--qm-surface', min: 4.5 },
  { name: 'failed on surface', fg: '--qm-failed', bg: '--qm-surface', min: 4.5 },
  { name: 'waiting on background', fg: '--qm-waiting', bg: '--qm-bg', min: 4.5 },
  { name: 'label on accent button', fg: '--qm-on-accent', bg: '--qm-accent', min: 4.5 },
  { name: 'control border on background', fg: '--qm-border', bg: '--qm-bg', min: 3 },
];
