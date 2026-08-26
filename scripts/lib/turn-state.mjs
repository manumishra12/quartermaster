/**
 * Why a turn ended, when it did not end well.
 *
 * The harness explains itself in two different fields depending on how the turn died: an error
 * puts its explanation in `message`, and a cancellation puts its explanation in `reason`. Reading
 * only the first is how a run killed by the server's execution timeout printed a bare
 * "[cancelled]" and recorded nothing - indistinguishable, to anyone reading the report later, from
 * an agent that simply gave up.
 *
 * It lives here rather than inline in the runner so it can be tested, which is the whole reason it
 * was wrong twice: a field name buried in an event handler is not something a suite can hold to
 * account.
 */
export function endedBecause(state) {
  if (!state || typeof state !== 'object') return null;

  for (const field of ['message', 'reason']) {
    const value = state[field];
    // Only a non-empty string is an explanation. An empty one is the absence of one, and passing
    // it through would put a blank section into the report claiming the turn had failed.
    if (typeof value === 'string' && value.trim()) return value.trim();
  }

  return null;
}

/** Whether a turn ended in a way worth explaining at all. */
export function endedBadly(status) {
  return status === 'error' || status === 'cancelled' || status === 'failed';
}
