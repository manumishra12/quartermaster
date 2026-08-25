/**
 * Inline SVG, not emoji. An emoji renders differently on every platform, cannot inherit colour,
 * and reads as a picture of a thing rather than a control.
 *
 * All icons are decorative here - every one sits beside a text label - so they are aria-hidden and
 * the label does the work for a screen reader.
 */
const base = {
  width: 14,
  height: 14,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
};

export const CheckIcon = () => (
  <svg {...base}>
    <path d="M2.5 8.5 6 12l7.5-8" />
  </svg>
);

export const CrossIcon = () => (
  <svg {...base}>
    <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
  </svg>
);

export const ClockIcon = () => (
  <svg {...base}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.75V8l2.25 1.5" />
  </svg>
);

export const SpinnerIcon = () => (
  <svg {...base} className="qm-spin">
    <path d="M8 2a6 6 0 1 1-4.24 1.76" />
  </svg>
);

export const DotIcon = () => (
  <svg {...base}>
    <circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" />
  </svg>
);

export const BugIcon = () => (
  <svg {...base} width={16} height={16}>
    <path d="M5 6a3 3 0 0 1 6 0v4a3 3 0 0 1-6 0V6Z" />
    <path d="M2.5 7.5h2.5M11 7.5h2.5M3 4l1.5 1.5M13 4l-1.5 1.5M3 11l1.5-1.5M13 11l-1.5-1.5" />
  </svg>
);

export const TerminalIcon = () => (
  <svg {...base} width={16} height={16}>
    <path d="M3 4.5 6 8l-3 3.5M8 12h5" />
  </svg>
);

export const DatabaseIcon = () => (
  <svg {...base} width={16} height={16}>
    <ellipse cx="8" cy="4" rx="5" ry="2" />
    <path d="M3 4v8c0 1.1 2.24 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.24 2 5 2s5-.9 5-2" />
  </svg>
);

export const GlobeIcon = () => (
  <svg {...base} width={16} height={16}>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12M8 2c1.5 1.6 2.3 3.8 2.3 6S9.5 12.4 8 14c-1.5-1.6-2.3-3.8-2.3-6S6.5 3.6 8 2Z" />
  </svg>
);

export const SunIcon = () => (
  <svg {...base} width={16} height={16}>
    <circle cx="8" cy="8" r="3.25" />
    <path d="M8 1.5v1.5M8 13v1.5M2.4 2.4l1 1M12.6 12.6l-1-1M1.5 8h1.5M13 8h1.5M2.4 13.6l1-1M12.6 3.4l-1 1" />
  </svg>
);

export const MoonIcon = () => (
  <svg {...base} width={16} height={16}>
    <path d="M13.5 9.4A5.8 5.8 0 0 1 6.6 2.5a5.8 5.8 0 1 0 6.9 6.9Z" />
  </svg>
);
