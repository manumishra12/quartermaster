import { useEffect, useState } from 'react';

/**
 * The current time, re-read on an interval, so a relative label does not sit still.
 *
 * `ago()` read `Date.now()` at render, which is correct exactly once. While an agent is working
 * the tree re-renders constantly and nobody notices; on an idle screen nothing re-renders at all,
 * so a conversation stayed labelled "now" for as long as the tab was left open.
 *
 * A minute, because that is the smallest step the label has - anything faster is work nobody can
 * see. The timer is shared by every row through one call in the list, rather than each row keeping
 * its own: sixty rows waking independently is sixty renders a minute to change at most a handful
 * of characters.
 */
export function useNow(everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);

  return now;
}
