/**
 * The SDK takes its theme as JS values, so these mirror the CSS custom properties in
 * styles/tokens.css. Both come from the same design system; tokens.css is the source of truth for
 * anything we render ourselves, this is the bridge for what the SDK renders.
 *
 * The one deliberate deviation from the generated palette: it uses green as the CTA accent, and
 * here green means exactly one thing - a real test run passed. Brass takes every action instead.
 * A Send button the same colour as a verified result would drain the colour of its meaning.
 */
export const theme = {
  preset: 'trueforge',
  mode: 'dark',
  brand: {
    name: 'Quartermaster',
    logo: { src: '/mark.svg' },
  },
  tokens: {
    primaryBg: '#0f172a',
    secondaryBg: '#1b2336',
    sidebarBg: '#0f172a',
    topbarBg: '#0f172a',
    cardBg: '#1b2336',
    border: '#2a3348',

    textPrimary: '#f8fafc',
    textSecondary: '#94a3b8',
    fontFamily: "'IBM Plex Sans', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",

    inputBoxBg: '#1b2336',
    inputBorder: '#64748b',
    composerRadius: '12px',
    radius: '8px',

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
  },
} as const;
