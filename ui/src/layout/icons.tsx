import type React from 'react';

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

export const ChatIcon = () => (
  <svg {...base} width={13} height={13}>
    <path d="M13.5 8a5.5 5.5 0 0 1-5.5 5.5c-.93 0-1.8-.23-2.57-.63L2.5 13.5l.63-2.93A5.47 5.47 0 0 1 2.5 8a5.5 5.5 0 1 1 11 0Z" />
  </svg>
);

export const ExpandIcon = () => (
  <svg {...base} width={13} height={13}>
    <path d="M6 2.5H2.5V6M10 13.5h3.5V10M13.5 6V2.5H10M2.5 10v3.5H6" />
  </svg>
);

export const CloseIcon = () => (
  <svg {...base} width={14} height={14}>
    <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
  </svg>
);

/** A disclosure arrow. Rotated by CSS rather than swapped, so the turn is the affordance. */
export const ChevronIcon = ({ className }: { className?: string }) => (
  <svg {...base} className={className}>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </svg>
);

/** Reasoning. Two lobes rather than a lightbulb: this is working, not an idea. */
export const BrainIcon = ({ className }: { className?: string }) => (
  <svg {...base} className={className}>
    <path d="M8 3.25v9.5" />
    <path d="M8 4.5A2 2 0 0 0 4.5 5.6 1.9 1.9 0 0 0 3.5 8a1.9 1.9 0 0 0 1.1 2.4A2 2 0 0 0 8 11.5" />
    <path d="M8 4.5a2 2 0 0 1 3.5 1.1A1.9 1.9 0 0 1 12.5 8a1.9 1.9 0 0 1-1.1 2.4A2 2 0 0 1 8 11.5" />
  </svg>
);

/** Rename. A pencil, because the row it sits on is a name and this edits it. */
/** Taking a copy. Two sheets, because one sheet is a document and two is the act. */
export const CopyIcon = ({ className }: { className?: string }) => (
  <svg {...base} className={className}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 3.5h-6a1 1 0 0 0-1 1v6" />
  </svg>
);

/** Starting something. Deliberately a plain cross rather than a document: what begins is a turn. */
export const PlusIcon = ({ className }: { className?: string }) => (
  <svg {...base} className={className}>
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
);

export const PencilIcon = ({ className }: { className?: string }) => (
  <svg {...base} className={className}>
    <path d="M11.4 2.9a1.4 1.4 0 0 1 2 2L6.2 12.1l-2.7.6.6-2.7Z" />
    <path d="M10.2 4.1 11.9 5.8" />
  </svg>
);

/** Something irreversible. A one-way door, not a dustbin: rollback and close are not deletions. */
export const OneWayIcon = ({ className }: { className?: string }) => (
  <svg {...base} className={className}>
    <path d="M2.5 8h9" />
    <path d="M8.5 4.5 12 8l-3.5 3.5" />
    <path d="M13.5 3v10" />
  </svg>
);

/** A branch: anything that writes to a repository. */
export const BranchIcon = ({ className }: { className?: string }) => (
  <svg {...base} className={className}>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="4.5" cy="12.5" r="1.5" />
    <circle cx="11.5" cy="6.5" r="1.5" />
    <path d="M4.5 5v6" />
    <path d="M10 6.5H8.5A4 4 0 0 0 4.5 10.5" />
  </svg>
);

/** A ticket or issue. */
export const TicketIcon = ({ className }: { className?: string }) => (
  <svg {...base} className={className}>
    <path d="M2.5 5.5h11v2a1.5 1.5 0 0 0 0 3v2h-11v-2a1.5 1.5 0 0 0 0-3Z" />
    <path d="M6.5 5.5v7" />
  </svg>
);

/** An alert. */
export const AlertIcon = ({ className }: { className?: string }) => (
  <svg {...base} className={className}>
    <path d="M8 2.5 14 12.5H2Z" />
    <path d="M8 6.5v3" />
    <path d="M8 11.4v.1" />
  </svg>
);

/** Sending something somebody else receives. */
export const SendIcon = ({ className }: { className?: string }) => (
  <svg {...base} className={className}>
    <path d="M13.5 2.5 7 9" />
    <path d="M13.5 2.5 9.5 13.5 7 9l-4.5-2.5Z" />
  </svg>
);

/**
 * The icon for a tool, chosen from what the tool does rather than from which server it came from.
 *
 * Every tool call rendered with the same dot, which is a waste of the one glance a person gives an
 * approval prompt before deciding. What matters at that moment is the *kind* of thing about to
 * happen - a shell command, a write to a repository, a message somebody receives, an irreversible
 * remediation - and that is legible from the name.
 *
 * Ordered most specific first: `close_issue` is a one-way door before it is a ticket, and
 * `rollback_deploy` is a one-way door before it is anything else.
 */
/** Every icon here takes an optional className; the older ones take no props at all. */
type IconComponent = (props: { className?: string }) => React.JSX.Element;

const TOOL_ICONS: Array<[RegExp, IconComponent]> = [
  [/rollback|restart|delete|close_|revert|drop|destroy/i, OneWayIcon],
  [/send|message|email|notify|comment/i, SendIcon],
  [/branch|commit|push|pull_request|repo|file|fork|merge/i, BranchIcon],
  [/issue|ticket|project|task/i, TicketIcon],
  [/alert|incident|deploy|health|service/i, AlertIcon],
  [/search|fetch|web|wiki|browse|crawl|url/i, GlobeIcon],
  [/sql|query|database|warehouse|table/i, DatabaseIcon],
  [/exec|shell|command|run|bash|sandbox/i, TerminalIcon],
];

export function iconForTool(name?: string): IconComponent {
  const found = TOOL_ICONS.find(([pattern]) => pattern.test(String(name ?? '')));
  // A tool this does not recognise gets the neutral mark rather than a guess.
  return found ? found[1] : (DotIcon as IconComponent);
}
