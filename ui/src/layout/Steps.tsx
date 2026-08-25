import { useState, type ReactNode } from 'react';
import { BrainIcon, ChevronIcon } from './icons';

/**
 * The agent's own working, kept out of the way of the conversation.
 *
 * The SDK renders reasoning as a bordered card holding the whole of the model's thinking, expanded.
 * For a real job that is useful; for "how are you" it produced eight lines of deliberation above a
 * one-line answer, and the answer - the thing a person came for - was the smallest item on screen.
 * A transcript where the working is larger than the result is a transcript nobody reads.
 *
 * So the working collapses to one line by default and says how much there is behind it. Nothing is
 * removed: it is all one click away, and while a turn is running the latest line stays visible so
 * the agent never looks stuck. What changes is only which of the two is given the room.
 */

/** The first sentence, or the first clause long enough to mean something on its own. */
function firstLine(content: string) {
  const text = content.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const stop = text.search(/[.!?](\s|$)/);
  const line = stop > 20 ? text.slice(0, stop + 1) : text;
  return line.length > 96 ? `${line.slice(0, 95).trimEnd()}…` : line;
}

/** The last thing it said, for the line that shows while a turn is still running. */
function lastLine(content: string) {
  const text = content.replace(/\s+/g, ' ').trim();
  return text.length > 96 ? `…${text.slice(-95).trimStart()}` : text;
}

export function ReasoningCard({
  content = '',
  isStreaming,
  expanded,
  onToggle,
  reasoningTimeText,
  headingText,
  contentRef,
  className,
}: {
  content?: string;
  isStreaming?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  reasoningTimeText?: string | null;
  headingText?: string;
  contentRef?: (node: HTMLDivElement | null) => void;
  className?: string;
}) {
  /**
   * The parent controls `expanded` when it wants to, but it opens reasoning by default and this
   * component's whole purpose is that it should not be. Local state takes over when the parent
   * offers no handler, so the default is closed and a click still works.
   */
  const [openLocally, setOpenLocally] = useState(false);
  const controlled = typeof onToggle === 'function' && typeof expanded === 'boolean';
  const open = controlled ? expanded : openLocally;
  const toggle = controlled ? onToggle : () => setOpenLocally((v) => !v);

  const summary = isStreaming ? lastLine(content) : firstLine(content);
  const words = content.trim() ? content.trim().split(/\s+/).length : 0;

  return (
    <div className={`qm-reasoning ${open ? 'is-open' : ''} ${className ?? ''}`}>
      <button
        type="button"
        onClick={toggle}
        className="qm-reasoning-head"
        aria-expanded={open}
        // Read as one control: the label says what it is, the summary is the preview of it.
        aria-label={`${headingText ?? 'Reasoning'}, ${words} words. ${open ? 'Collapse' : 'Expand'}.`}
      >
        <ChevronIcon className={`qm-reasoning-chevron ${open ? 'is-open' : ''}`} />
        <BrainIcon className="qm-reasoning-icon" />
        <span className="qm-reasoning-label">{headingText ?? 'Reasoning'}</span>
        {!open && summary ? <span className="qm-reasoning-summary">{summary}</span> : null}
        <span className="qm-reasoning-meta">
          {isStreaming ? 'thinking' : reasoningTimeText || (words ? `${words} words` : '')}
        </span>
      </button>

      {open ? (
        // Capped rather than unbounded: reasoning can run to thousands of words, and a block that
        // pushes the answer off the screen is the problem this component exists to solve.
        <div className="qm-reasoning-body" ref={contentRef}>
          {content}
        </div>
      ) : null}
    </div>
  );
}

export function AgentStepsCard({
  toolCount,
  thinkingCount,
  expanded,
  active,
  onToggle,
  children,
  className,
}: {
  toolCount: number;
  thinkingCount: number;
  expanded: boolean;
  active?: boolean;
  onToggle: () => void;
  children: ReactNode;
  className?: string;
}) {
  const parts = [
    toolCount ? `${toolCount} tool call${toolCount === 1 ? '' : 's'}` : null,
    thinkingCount ? `${thinkingCount} thought${thinkingCount === 1 ? '' : 's'}` : null,
  ].filter(Boolean);

  /**
   * A turn that called no tools did not take any steps worth a card. It gets a line instead, so a
   * greeting reads as a greeting - which is most of what made the transcript feel padded.
   */
  const quiet = toolCount === 0 && !active;

  return (
    <div className={`qm-steps ${quiet ? 'is-quiet' : ''} ${className ?? ''}`}>
      <button type="button" onClick={onToggle} className="qm-steps-head" aria-expanded={expanded}>
        <ChevronIcon className={`qm-steps-chevron ${expanded ? 'is-open' : ''}`} />
        <span className="qm-steps-label">{active ? 'Working' : 'Agent steps'}</span>
        <span className="qm-steps-meta">{parts.join(' · ') || 'no steps'}</span>
        {active ? <span className="qm-steps-pulse" aria-hidden="true" /> : null}
      </button>
      {expanded ? <div className="qm-steps-body">{children}</div> : null}
    </div>
  );
}
