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
