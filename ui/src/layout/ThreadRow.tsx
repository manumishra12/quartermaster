import { Children, isValidElement, type ReactNode } from 'react';
import { ChatIcon } from './icons';

/**
 * A conversation in the list.
 *
 * Three pieces of information compete here: what the conversation was about, which agent ran it,
 * and when. The default row gives them equal weight, which is why the sidebar read as clutter.
 * The title carries it, the agent is secondary, and the time is the quietest thing on the row -
 * it is the one you scan by position rather than read.
 */
export function ThreadRow({
  title,
  active,
  onSelect,
  agentName,
  lastMessageAt,
  actions,
}: {
  title: string;
  active: boolean;
  onSelect: () => void;
  agentName?: string;
  lastMessageAt?: Date;
  actions?: ReactNode;
}) {
  return (
    <div
      className={[
        'group relative flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors duration-200',
        active ? 'bg-accent-wash' : 'hover:bg-raised',
      ].join(' ')}
    >
      {active && (
        <span aria-hidden className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-accent" />
      )}

      <span className={['mt-0.5 shrink-0', active ? 'text-accent' : 'text-muted'].join(' ')}>
        <ChatIcon />
      </span>

      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        className="min-w-0 flex-1 cursor-pointer text-left"
      >
        <span
          className={[
            'block truncate text-xs leading-snug',
            active ? 'font-medium text-ink' : 'text-ink',
          ].join(' ')}
        >
          {title}
        </span>
        {agentName && <span className="mt-0.5 block truncate text-2xs text-muted">{agentName}</span>}
      </button>

      {lastMessageAt && (
        <time
          dateTime={lastMessageAt.toISOString()}
          title={lastMessageAt.toLocaleString()}
          className="qm-nums mt-0.5 shrink-0 text-2xs text-muted"
        >
          {ago(lastMessageAt)}
        </time>
      )}

      {actions && <span className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100">{actions}</span>}
    </div>
  );
}

/** Compact relative time: the list is scanned, not read. */
function ago(date: Date): string {
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = hours / 24;
  if (days < 7) return `${Math.floor(days)}d`;
  return `${Math.floor(days / 7)}w`;
}

/**
 * The list shell, with a count.
 *
 * The count is here because a list you can only see eight of tells you nothing about its size, and
 * the number is the cheapest possible answer.
 */
export function ThreadList({ header, children }: { header: ReactNode; children: ReactNode }) {
  const count = Children.toArray(children).filter(isValidElement).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-baseline justify-between gap-2 px-5 pb-2 pt-4">
        <h2 className="text-2xs font-semibold uppercase tracking-[0.09em] text-muted">Conversations</h2>
        {count > 0 && <span className="qm-nums text-2xs text-muted">{count}</span>}
      </div>
      {header}
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">{children}</div>
    </div>
  );
}
