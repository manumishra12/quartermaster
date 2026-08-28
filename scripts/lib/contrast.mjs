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

/**
 * Read the declared tokens per theme, straight from the stylesheet.
 *
 * A flat map would silently keep only the last declaration of each token, so a two-theme
 * stylesheet would have exactly one theme tested and the other shipped unchecked. Every theme in
 * the file gets its own map.
 */
export function readThemes(path) {
  const css = readFileSync(path, 'utf8');
  const themes = {};

  // Each `selector { ... }` block that declares --qm-* tokens is a theme.
  for (const [, selector, body] of css.matchAll(/(:root[^{]*?)\{([^}]*)\}/g)) {
    const tokens = {};
    for (const [, name, value] of body.matchAll(/(--qm-[\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
      tokens[name] = value.toLowerCase();
    }
    if (Object.keys(tokens).length === 0) continue;
    const name = selector.includes('.dark') ? 'dark' : 'light';
    themes[name] = { ...(themes[name] ?? {}), ...tokens };
  }
  return themes;
}

/** Back-compat for a single flat read. */
export function readTokens(path) {
  const themes = readThemes(path);
  return Object.assign({}, ...Object.values(themes));
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
  { name: 'control border on surface', fg: '--qm-border', bg: '--qm-surface', min: 3 },
  { name: 'control border on a raised surface', fg: '--qm-border', bg: '--qm-surface-raised', min: 3 },
];

/**
 * The soft token is 1.18:1 against the background and is not meant to clear anything - it
 * separates regions, which WCAG 1.4.11 does not cover. It is listed here so nothing quietly
 * promotes it: four interactive controls were drawn with it, and the boundary of something you can
 * click or tab into is the boundary that has to be visible.
 */
export const REGION_ONLY = ['--qm-border-soft'];
