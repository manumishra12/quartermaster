import { useEffect, useRef } from 'react';

/**
 * The four things a dialog owes a keyboard, in one place.
 *
 * There were two dialogs here and between them they had one and a half of these. The enlarged
 * output took focus and closed on Escape; the mobile sheet did neither, so opening it left focus
 * behind on the button that opened it, Tab walked into the conversation underneath, and there was
 * no key that would close it. Neither locked scrolling, and neither gave focus back on close - so
 * dismissing a dialog dropped you at the top of the document.
 *
 * Written as a hook rather than a component because the two dialogs render nothing alike and only
 * the behaviour is shared. Copying the behaviour is how they came to disagree.
 */
export function useDialog<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T | null>(null);
  /** Where focus was before this opened, so it can be given back. */
  const returnTo = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;

    /**
     * Focus is taken once, on open.
     *
     * Not from an inline ref callback, which React re-invokes on every commit - and while an agent
     * streams there is a commit every few hundred milliseconds, so focus was dragged back into the
     * dialog continuously and its own controls could not be reached. That bug was fixed twice
     * before, once in each dialog, which is most of the argument for this file existing.
     */
    returnTo.current = document.activeElement;
    ref.current?.focus();

    // Scroll is locked on the document, not the dialog: without it the page behind scrolls under
    // the overlay, which on a phone reads as the dialog itself losing its place.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      /**
       * The trap. Queried at the moment Tab is pressed rather than on open, because what is
       * focusable changes while the dialog is on screen - a button disables itself once an
       * approval is sent, and a list of runs grows as the agent works.
       */
      const focusable = ref.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) {
        // Nothing to move to, so keep focus on the dialog rather than letting Tab leave it.
        event.preventDefault();
        ref.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === ref.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      /**
       * Focus goes back where it came from, if that element is still there. After closing the
       * sheet from a conversation link, the element that opened it may be gone - and focusing a
       * detached node silently sends focus to the body, which is where it would have gone anyway.
       */
      const target = returnTo.current;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
    };
  }, [open, onClose]);

  return ref;
}
