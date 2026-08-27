import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A sidebar you can drag wider, and that stays where you put it.
 *
 * Conversation titles are the one thing in this product that are arbitrarily long - they come from
 * the first message somebody typed - and a fixed 16rem column truncated most of them with no way
 * to read the rest. Widening the column is the fix people actually reach for, so it is worth
 * having rather than a hover tooltip alone.
 *
 * The width is per-browser, like the renamed titles beside it: nothing here is a write to the
 * harness, and pretending otherwise would be the kind of quiet overclaim this project exists to
 * refuse.
 */
const KEY = 'quartermaster.sidebar-width';

/** Narrow enough to still be a sidebar, wide enough to read a sentence. */
export const MIN_WIDTH = 208;
export const MAX_WIDTH = 560;
export const DEFAULT_WIDTH = 256;

/** Storage throws in private windows and where site data is blocked, so every access is guarded. */
function load(): number {
  try {
    const stored = Number(window.localStorage.getItem(KEY));
    if (!Number.isFinite(stored) || stored <= 0) return DEFAULT_WIDTH;
    return clamp(stored);
  } catch {
    return DEFAULT_WIDTH;
  }
}

export function clamp(width: number): number {
  // NaN survives every comparison, so without this it flows into the style attribute and the
  // column collapses to nothing with no way to drag it back.
  if (!Number.isFinite(width)) return MIN_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
}

export function useSidebarWidth() {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [dragging, setDragging] = useState(false);
  const frame = useRef<number | null>(null);

  // Read after mount rather than during render: the first paint is then identical on the server
  // and the client, and a blocked storage read cannot take the first render down with it.
  useEffect(() => setWidth(load()), []);

  const persist = useCallback((next: number) => {
    try {
      window.localStorage.setItem(KEY, String(next));
    } catch {
      // A width that cannot be stored still applies to this session.
    }
  }, []);

  const set = useCallback(
    (next: number) => {
      const bounded = clamp(next);
      setWidth(bounded);
      persist(bounded);
      return bounded;
    },
    [persist],
  );

  /**
   * Pointer events rather than mouse events, so a trackpad, a touch screen and a stylus all work,
   * and `setPointerCapture` keeps the drag alive when the cursor outruns the 4px handle.
   */
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      setDragging(true);

      const move = (moveEvent: PointerEvent) => {
        // One update per frame. Without this a fast drag queues a render per pointer event and the
        // column visibly lags the cursor.
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => setWidth(clamp(moveEvent.clientX)));
      };

      const up = (upEvent: PointerEvent) => {
        handle.releasePointerCapture?.(upEvent.pointerId);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = null;
        setDragging(false);
        setWidth((current) => {
          persist(current);
          return current;
        });
      };

      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      // A cancelled pointer - a system gesture, a dropped stylus - must end the drag too, or the
      // column follows the cursor forever with no button held.
      handle.addEventListener('pointercancel', up);
    },
    [persist],
  );

  /** The same control from the keyboard, because a drag handle nobody can reach is not a control. */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      const step = event.shiftKey ? 48 : 16;
      if (event.key === 'ArrowLeft') set(width - step);
      else if (event.key === 'ArrowRight') set(width + step);
      else if (event.key === 'Home') set(MIN_WIDTH);
      else if (event.key === 'End') set(MAX_WIDTH);
      else return;
      event.preventDefault();
    },
    [set, width],
  );

  useEffect(() => {
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  return { width, dragging, set, onPointerDown, onKeyDown };
}
