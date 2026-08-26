import { useCallback, useEffect, useSyncExternalStore } from 'react';

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

/**
 * Best effort, and only that.
 *
 * A write that fails must not take the rename with it. Memory is the source of truth here and
 * storage is where it is kept for next time, so a private window that refuses to store still shows
 * you the name you just typed - it simply will not have it tomorrow.
 */
function write(titles: Titles): boolean {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(titles));
    return true;
  } catch {
    // Nothing to do about it, and nothing that should be undone because of it.
    return false;
  }
}

/**
 * Changes storage would not accept, kept so they are not lost twice.
 *
 * Without this, the next successful write would rebuild the map from disk and quietly drop a name
 * that had already failed to save once.
 */
const unsaved = new Map<string, string | null>();

/** Re-apply what storage refused on top of whatever is on disk now. */
function withUnsaved(base: Titles): Titles {
  if (unsaved.size === 0) return base;
  const merged = { ...base };
  for (const [id, name] of unsaved) {
    if (name) merged[id] = name;
    else delete merged[id];
  }
  return merged;
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

function notify() {
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
    if (event.key === null) {
      // A cleared store. Nothing is pending against a store that no longer has anything in it,
      // and holding refused writes across a clear would silently put them back.
      unsaved.clear();
    }
    if (event.key === null || event.key === KEY) {
      // Another tab's map, plus anything of ours it could not have known about.
      snapshot = withUnsaved(read());
      notify();
    }
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function set(id: string, name: string | null) {
  /**
   * Merged onto what is on disk, not onto our copy of it.
   *
   * Two tabs renaming different conversations each held a whole map; writing ours back erased
   * theirs, and their storage event then erased ours - last writer wins, silently, on a change
   * neither person made. Only the one conversation being renamed is ours to decide.
   */
  const updated = withUnsaved(read());
  // An empty name is not a name: it hands the conversation back to the title TrueForge gave it.
  if (name) updated[id] = name;
  else delete updated[id];

  snapshot = updated;
  if (write(updated)) {
    // The map just written already carries every earlier refusal, so none of them are pending.
    unsaved.clear();
  } else {
    unsaved.set(id, name);
  }
  notify();
}

/**
 * @param ids Every id this conversation is known by, most durable first.
 *
 * A conversation has a local id before the harness has persisted it and a remote id afterwards.
 * Keying only on the current one lost a name given early: the row came back under a different id
 * and the rename was still in storage, orphaned, under the old one.
 */
export function useThreadTitle(ids: (string | null | undefined)[], fallback: string) {
  const titles = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  const known = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
  const primary = known[0];
  const holder = known.find((id) => titles[id] != null);

  // Move a name given before the session was persisted onto the id it will keep.
  useEffect(() => {
    if (!primary || !holder || holder === primary) return;
    const name = snapshot[holder];
    if (!name) return;
    set(primary, name);
    set(holder, null);
  }, [primary, holder]);

  const rename = useCallback(
    (next: string) => {
      if (!primary) return;
      set(primary, next.trim() || null);
    },
    [primary],
  );

  const custom = holder ? titles[holder] : undefined;
  return { title: custom ?? fallback, renamed: custom != null, canRename: primary != null, rename };
}
