import { useEffect, useRef } from 'react';

/**
 * Keyboard shortcuts, and one that is deliberately absent.
 *
 * A developer tool without them feels unfinished, and this one is driven by people who live on a
 * keyboard. But the action this product exists to guard is approval, and **allow is not bound to
 * anything**. A single keystroke that authorises an irreversible write is the exact failure the
 * gate was built to prevent: an approval given before the person has read what they are approving.
 * The prompt already takes focus when it appears, so Tab and Enter reach it in two deliberate
 * presses - which is the right number for that decision and one more than for any other.
 *
 * Deny is unbound too, for a smaller reason: a reflex that denies is still a reflex, and the
 * asymmetry would train the hand.
 */

export type Shortcut = {
  /** As written for a reader, not as matched. */
  keys: string;
  label: string;
  /** Held back from the list when it does not apply here. */
  when?: () => boolean;
};

export const SHORTCUTS: Shortcut[] = [
  { keys: '/', label: 'Focus the composer' },
  { keys: '⌘K', label: 'Search conversations' },
  { keys: '⌘\\', label: 'Show or hide the sidebar' },
  { keys: '?', label: 'This list' },
  { keys: 'Esc', label: 'Close a dialog, sheet or panel' },
];

/** Where a keystroke belongs to what the person is typing, not to the page. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function useShortcuts(handlers: {
  focusComposer?: () => void;
  toggleSidebar?: () => void;
  openSearch?: () => void;
  showHelp?: () => void;
}) {
  /**
   * Held in a ref so the listener is attached once.
   *
   * A caller passes an object literal, which is a new identity on every render - and with that in
   * the dependency array the listener is removed and re-added on every keystroke the page causes.
   * This repository has the same lesson written down about a prop handed to a store: an inline
   * literal never has a stable identity, and the fix is not to ask callers to memoise.
   */
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;

      /**
       * A shortcut must never eat a character somebody is typing. `/` and `?` are ordinary
       * characters in a prompt, and a composer that swallowed them would be worse than having no
       * shortcuts at all. Meta combinations are safe in a field because they are not text.
       */
      if (isTyping(event.target) && !meta) return;

      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        latest.current.openSearch?.();
        return;
      }
      if (meta && event.key === '\\') {
        event.preventDefault();
        latest.current.toggleSidebar?.();
        return;
      }
      // Bare keys, only outside a field.
      if (event.key === '/' && !meta) {
        event.preventDefault();
        latest.current.focusComposer?.();
        return;
      }
      if (event.key === '?' && !meta) {
        event.preventDefault();
        latest.current.showHelp?.();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}
