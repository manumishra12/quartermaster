import { Children, isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAuiState } from '@truefoundry/trueforge-ui/assistant-ui';
import { ChatIcon, PencilIcon } from './icons';
import { useCloseSheet } from './SheetContext';
import { useThreadTitle } from './useThreadTitle';

type AuiSnapshot = { threadListItem?: { remoteId?: string | null; id?: string | null } };

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
  const closeSheet = useCloseSheet();

  /**
   * The row renders inside the SDK's thread-list item, so the session it belongs to is readable
   * from state even though the slot is not handed an id. The remote id is the durable one; the
   * local id is the fallback for a conversation that has not been persisted yet.
   */
  /**
   * One string, not an array.
   *
   * The store compares snapshots by identity, so a selector returning a fresh array every render
   * never settles - "the result of getSnapshot should be cached", which this project has already
   * paid for once with a blank page. A joined key is stable by value.
   */
  const idKey = useAuiState((s: AuiSnapshot) => {
    try {
      // Most durable first: the remote id survives a reload, the local one only this session.
      return `${s.threadListItem?.remoteId ?? ''}\u0000${s.threadListItem?.id ?? ''}`;
    } catch {
      // Outside an AuiProvider the default client throws on scope access. A row rendered there
      // has no session to name, but it still has a conversation to show - and one row taking the
      // sidebar down with it would be a worse bug than the missing button.
      return '';
    }
  });
  const ids = useMemo(() => idKey.split('\u0000').filter(Boolean), [idKey]);
  const { title: shown, canRename, rename } = useThreadTitle(ids, title);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(shown);
  const input = useRef<HTMLInputElement>(null);
  /**
   * Escape has to beat the blur that follows it.
   *
   * Closing the field unmounts the input, which fires blur, which was saving - so the one key
   * whose whole job is to abandon the edit was committing it. This flag is what makes cancelling
   * mean cancelling.
   */
  const cancelling = useRef(false);

  // Focus once, when the field opens. An inline ref callback re-runs on every commit and drags
  // focus back mid-typing - the same defect this project has now fixed twice elsewhere.
  useEffect(() => {
    if (!editing) return;
    // Focus, then select. Opening a field the keyboard has not moved to is a field you cannot type
    // in without reaching for the mouse first.
    input.current?.focus();
    input.current?.select();
  }, [editing]);

  const startEditing = () => {
    setDraft(shown);
    // Cleared on the way in, not only on the way out. If a previous edit closed without its blur
    // ever firing - the field lost focus some other way - the flag stayed set and silently threw
    // away the next rename instead of that one.
    cancelling.current = false;
    setEditing(true);
  };

  const commit = () => {
    rename(draft);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2 rounded-lg px-2.5 py-2">
        <span className="shrink-0 text-muted">
          <ChatIcon />
        </span>
        <input
          ref={input}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            // Clicking away saves: losing a name you have just typed to a stray click is worse
            // than keeping one you were unsure about, which you can always edit again.
            if (cancelling.current) {
              cancelling.current = false;
              return;
            }
            commit();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
            // Escape abandons the edit - it is the undo for having started one.
            if (event.key === 'Escape') {
              cancelling.current = true;
              setEditing(false);
            }
          }}
          aria-label={`Rename ${shown}`}
          placeholder={title}
          className="min-w-0 flex-1 rounded border border-line bg-surface px-1.5 py-0.5 text-xs text-ink outline-none focus:border-accent"
        />
      </div>
    );
  }

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
        onClick={() => {
          onSelect();
          closeSheet();
        }}
        aria-current={active ? 'true' : undefined}
        className="min-w-0 flex-1 cursor-pointer text-left"
      >
        <span
          className={[
            'block truncate text-xs leading-snug',
            active ? 'font-medium text-ink' : 'text-ink',
          ].join(' ')}
        >
          {shown}
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

      {/*
        * Hidden until hover or focus, like the overflow actions beside it: a rename button on every
        * row, always visible, would compete with the titles it is there to serve. focus-within
        * keeps it reachable by keyboard, where hover never happens.
        */}
      <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        {canRename && (
          <button
            type="button"
            onClick={startEditing}
            aria-label={`Rename ${shown}`}
            title="Rename"
            className="cursor-pointer rounded p-1 text-muted hover:bg-surface hover:text-ink"
          >
            <PencilIcon />
          </button>
        )}
        {actions}
      </span>
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
        <h2 className="text-2xs font-[550] uppercase tracking-[0.07em] text-muted">Conversations</h2>
        {count > 0 && <span className="qm-nums text-2xs text-muted">{count}</span>}
      </div>
      {header}
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">{children}</div>
    </div>
  );
}
