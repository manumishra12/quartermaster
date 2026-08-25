/**
 * The palette the SDK renders with.
 *
 * `styles/tokens.css` is the source of truth for everything we draw ourselves; the SDK takes JS
 * values, so this mirrors the same two themes. Both are checked by `scripts/lib/contrast.test.mjs`,
 * which reads the stylesheet - so if these drift, the stylesheet is the one that is right.
 *
 * The one deliberate deviation from the generated design system, carried through both themes: it
 * uses green as the CTA accent, and here green means exactly one thing - a real run passed. Brass
 * takes every action instead.
 */
const LIGHT = {
  primaryBg: '#fbfbfa',
  secondaryBg: '#ffffff',
  sidebarBg: '#fbfbfa',
  topbarBg: '#fbfbfa',
  cardBg: '#ffffff',
  border: '#eae8e4',

  textPrimary: '#1b1a18',
  textSecondary: '#6e6b65',

  inputBoxBg: '#ffffff',
  inputBorder: '#8a8279',

  userMessageBg: '#f1f0ed',
  userMessageText: '#1b1a18',
  assistantMessageBg: 'transparent',
  assistantMessageText: '#1b1a18',

  primaryButtonBg: '#5b4bd6',
  primaryButtonHover: '#4a3bc4',
  primaryButtonText: '#ffffff',
  secondaryButtonBg: '#f1f0ed',
  secondaryButtonHover: '#eae8e4',
  secondaryButtonText: '#1b1a18',
  ghostButtonBg: 'transparent',
  ghostButtonHover: '#f1f0ed',
  ghostButtonText: '#6e6b65',

  successBg: '#eaf2ec',
  successText: '#4a7c59',
  failureBg: '#fbeceb',
  failureText: '#a8342c',
  warningBg: '#faf1e0',
  warningText: '#8a6410',

  focusRing: '#5b4bd6',
  overlay: 'rgba(27, 26, 24, 0.4)',
  shadowColor: 'rgba(27, 26, 24, 0.14)',
  scrollbarThumb: '#eae8e4',

  dropdownSelectedItemBg: '#eeecfb',
  dropdownSelectedItemText: '#1b1a18',
} as const;

const DARK = {
  primaryBg: '#171512',
  secondaryBg: '#201d19',
  sidebarBg: '#171512',
  topbarBg: '#171512',
  cardBg: '#201d19',
  border: '#302c26',

  textPrimary: '#f5f3f0',
  textSecondary: '#a8a29a',

  inputBoxBg: '#201d19',
  inputBorder: '#7a736a',

  userMessageBg: '#2a2620',
  userMessageText: '#f5f3f0',
  assistantMessageBg: 'transparent',
  assistantMessageText: '#f5f3f0',

  primaryButtonBg: '#a78bfa',
  primaryButtonHover: '#b4a0fb',
  primaryButtonText: '#171512',
  secondaryButtonBg: '#2a2620',
  secondaryButtonHover: '#353029',
  secondaryButtonText: '#f5f3f0',
  ghostButtonBg: 'transparent',
  ghostButtonHover: '#201d19',
  ghostButtonText: '#a8a29a',

  successBg: '#1a2a1e',
  successText: '#7fb88c',
  failureBg: '#2c1a19',
  failureText: '#f0918c',
  warningBg: '#2c2415',
  warningText: '#e0b15c',

  focusRing: '#a78bfa',
  overlay: 'rgba(10, 9, 8, 0.72)',
  shadowColor: 'rgba(0, 0, 0, 0.5)',
  scrollbarThumb: '#302c26',

  dropdownSelectedItemBg: '#262040',
  dropdownSelectedItemText: '#f5f3f0',
} as const;

const SHARED = {
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
  composerRadius: '12px',
  radius: '9px',
} as const;

export function tokensFor(mode: 'light' | 'dark') {
  return { ...SHARED, ...(mode === 'dark' ? DARK : LIGHT) };
}
