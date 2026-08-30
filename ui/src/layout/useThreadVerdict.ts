import { useCallback, useSyncExternalStore } from 'react';

/**
 * The verdict a conversation ended on, remembered per conversation.
 *
 * The sidebar lists conversations and says nothing about how any of them turned out, which is the
 * one thing this product knows that a chat history usually does not. A list where the contradicted
 * runs are visible from across the room is a different tool from a list of first messages.
 *
 * **It only knows about conversations opened in this browser**, and that limit is structural rather
 * than lazy. The thread list gives ids and titles; a verdict needs the conversation's recorded
 * executions, which the SDK loads when a thread is opened. Computing one for every row would mean
 * fetching every thread's event stream on every render of the sidebar - so a row that has never
 * been opened shows nothing at all, rather than a guess or a spinner that never resolves.
 *
 * Stored like the renamed titles beside it: in the browser, not written to the harness. Nothing
 * here is a claim about what the server holds.
 */
const KEY = 'quartermaster.thread-verdicts';

/** The verdicts the evidence module produces, lower-cased as it returns them. */
export type Verdict = 'substantiated' | 'unsubstantiated' | 'contradicted' | 'no_claim' | 'no_answer';

type Stored = Record<string, Verdict>;

const VERDICTS: Verdict[] = ['substantiated', 'unsubstantiated', 'contradicted', 'no_claim', 'no_answer'];

/** Storage throws in private windows and where site data is blocked, so every access is guarded. */
function read(): Stored {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // A stored value that is not one of ours would render as a chip saying something arbitrary.
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(([, v]) => VERDICTS.includes(v as Verdict)),
    ) as Stored;
  } catch {
    return {};
  }
}

/** Subscribers in this tab, plus the storage event for the others. */
const listeners = new Set<() => void>();
let snapshot: Stored | null = null;

function current(): Stored {
  if (snapshot === null) snapshot = read();
  return snapshot;
}

function announce() {
  snapshot = read();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    /**
     * `key === null` is a clear(), which a real browser sends and jsdom does not unless a test
     * dispatches it. Both mean this cache is no longer what is on disk.
     */
    if (event.key === KEY || event.key === null) announce();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * Record how a conversation ended.
 *
 * Merged onto what is on disk rather than written over it, because two tabs may be looking at
 * different conversations and the last writer must not erase the other's.
 */
export function rememberVerdict(ids: string[], verdict: Verdict | null) {
  if (ids.length === 0 || verdict === null) return;
  try {
    const merged = { ...read() };
    for (const id of ids) merged[id] = verdict;
    window.localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    // A verdict that cannot be stored is not worth failing a render over.
  }
  announce();
}

/**
 * One frozen object, not a fresh one per call.
 *
 * `useSyncExternalStore` compares snapshots by identity. A server snapshot written as
 * `() => ({})` returns a new object every read, so React sees the store change on every render,
 * re-renders, reads again, and never settles - "Maximum update depth exceeded. The result of
 * getSnapshot should be cached." It is the same defect this project already fixed in
 * `useThreadTitle`, reintroduced in the one argument nobody looks at because it only runs when
 * there is no browser store to read.
 */
const EMPTY: Stored = Object.freeze({}) as Stored;
const serverSnapshot = (): Stored => EMPTY;

/** The verdict for this conversation, or null where none has been computed in this browser. */
export function useThreadVerdict(ids: string[]): Verdict | null {
  const stored = useSyncExternalStore(subscribe, current, serverSnapshot);
  const find = useCallback(() => {
    for (const id of ids) {
      if (stored[id]) return stored[id];
    }
    return null;
  }, [ids, stored]);
  return find();
}
