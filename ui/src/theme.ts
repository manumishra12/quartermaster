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
  primaryBg: '#faf9f7',
  secondaryBg: '#ffffff',
  sidebarBg: '#faf9f7',
  topbarBg: '#faf9f7',
  cardBg: '#ffffff',
  border: '#e7e3dc',

  textPrimary: '#1c1917',
  textSecondary: '#5c5651',

  inputBoxBg: '#ffffff',
  inputBorder: '#8a8279',

  userMessageBg: '#f4f2ee',
  userMessageText: '#1c1917',
  assistantMessageBg: 'transparent',
  assistantMessageText: '#1c1917',

  primaryButtonBg: '#8a6a22',
  primaryButtonHover: '#6f5419',
  primaryButtonText: '#ffffff',
  secondaryButtonBg: '#f4f2ee',
  secondaryButtonHover: '#e7e3dc',
  secondaryButtonText: '#1c1917',
  ghostButtonBg: 'transparent',
  ghostButtonHover: '#f4f2ee',
  ghostButtonText: '#5c5651',

  successBg: '#e8f5ec',
  successText: '#15803d',
  failureBg: '#fdeaea',
  failureText: '#b91c1c',
  warningBg: '#fdf4e3',
  warningText: '#a16207',

  focusRing: '#8a6a22',
  overlay: 'rgba(28, 25, 23, 0.4)',
  shadowColor: 'rgba(28, 25, 23, 0.12)',
  scrollbarThumb: '#d9d4cc',

  dropdownSelectedItemBg: '#f4f2ee',
  dropdownSelectedItemText: '#1c1917',
} as const;

const DARK = {
  primaryBg: '#0f172a',
  secondaryBg: '#1b2336',
  sidebarBg: '#0f172a',
  topbarBg: '#0f172a',
  cardBg: '#1b2336',
  border: '#2a3348',

  textPrimary: '#f8fafc',
  textSecondary: '#94a3b8',

  inputBoxBg: '#1b2336',
  inputBorder: '#64748b',

  userMessageBg: '#272f42',
  userMessageText: '#f8fafc',
  assistantMessageBg: 'transparent',
  assistantMessageText: '#f8fafc',

  primaryButtonBg: '#c8a35a',
  primaryButtonHover: '#d8b672',
  primaryButtonText: '#0f172a',
  secondaryButtonBg: '#272f42',
  secondaryButtonHover: '#334155',
  secondaryButtonText: '#f8fafc',
  ghostButtonBg: 'transparent',
  ghostButtonHover: '#1b2336',
  ghostButtonText: '#94a3b8',

  successBg: '#0f2a1b',
  successText: '#22c55e',
  failureBg: '#2a1013',
  failureText: '#f87171',
  warningBg: '#2a2210',
  warningText: '#fbbf24',

  focusRing: '#c8a35a',
  overlay: 'rgba(8, 12, 20, 0.72)',
  shadowColor: 'rgba(0, 0, 0, 0.6)',
  scrollbarThumb: '#64748b',

  dropdownSelectedItemBg: '#272f42',
  dropdownSelectedItemText: '#f8fafc',
} as const;

const SHARED = {
  fontFamily: "'IBM Plex Sans', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  composerRadius: '12px',
  radius: '8px',
} as const;

export function tokensFor(mode: 'light' | 'dark') {
  return { ...SHARED, ...(mode === 'dark' ? DARK : LIGHT) };
}
