import { useCallback, useSyncExternalStore } from 'react';

/**
 * Conversation titles you have renamed yourself.
 *
 * TrueForge derives a session's title from its first message and offers no way to change it: the
 * session update API takes an agent and nothing else. So this is a label kept in the browser, not
 * a write to the harness - it belongs to this machine, and clearing site data clears it. That is
 * worth saying plainly rather than letting a rename look like it went somewhere it did not.
 *
 * Keyed on the session id rather than the title, because two conversations that opened with the
 * same sentence are still two conversations.
 */
const KEY = 'quartermaster.thread-titles';

type Titles = Record<string, string>;

/** Storage throws in private windows and when a browser blocks site data, so every access is guarded. */
function read(): Titles {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // A stored value that is not a string would render as [object Object] in the sidebar.
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
    ) as Titles;
  } catch {
    return {};
  }
}

function write(titles: Titles) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(titles));
  } catch {
    // A rename that cannot be stored still applies to this render; it just will not outlive it.
  }
}

/**
 * One snapshot shared by every row.
 *
 * `useSyncExternalStore` compares snapshots by identity, so this has to be a cached object rather
 * than a fresh parse per read - returning a new one each time is an infinite render, which is a
 * mistake this codebase has already made once and paid for with a blank page.
 */
let snapshot: Titles = read();
const listeners = new Set<() => void>();

function emit() {
  snapshot = read();
  for (const listener of listeners) listener();
}

/**
 * The listener belongs to the module, not to whoever happens to be mounted.
 *
 * Registered per-subscriber, it existed only while a row was on screen - so a change made while
 * the list was closed was never noticed, and the cache stayed stale until something else wrote.
 * Another tab renaming a conversation is the same event as this one doing it, and it has to land
 * whether or not anybody is currently listening.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === null || event.key === KEY) emit();
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useThreadTitle(id: string | null | undefined, fallback: string) {
  const titles = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);

  const rename = useCallback(
    (next: string) => {
      if (!id) return;
      const trimmed = next.trim();
      const updated = { ...read() };
      // An empty name is not a name: it hands the conversation back to the title TrueForge gave it.
      if (trimmed) updated[id] = trimmed;
      else delete updated[id];
      write(updated);
      emit();
    },
    [id],
  );

  const custom = id ? titles[id] : undefined;
  return { title: custom ?? fallback, renamed: custom != null, rename };
}
