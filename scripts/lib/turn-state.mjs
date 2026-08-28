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

/**
 * What the process tells CI.
 *
 * The exit code used to be the verdict and nothing else, so every way a run can fail without the
 * agent claiming anything came out as success. A turn killed on a provider quota produces no
 * answer and therefore no claim, which is NO CLAIM, which was zero. A run that crashed halfway
 * never reached the line at all. A run still waiting on twenty-five rounds of approvals stopped
 * where it was and reported the same zero. In a pipeline, all three read as "the work is done".
 *
 * So the verdict is the last question asked, not the first. Whether the run finished comes before
 * whether its answer was any good - and none of these are judgements about the agent, which is why
 * a substantiated claim does not rescue them.
 */
export function runExitCode({
  proved = false,
  crashed = false,
  unfinished = false,
  blockedOnAuth = false,
  status = null,
  failure = null,
} = {}) {
  if (crashed || unfinished || blockedOnAuth) return 1;
  // The report says "the turn failed" whenever there is a reason to give. The exit code has to
  // agree with the artifact; they were saying opposite things about the same run.
  if (failure || endedBadly(status)) return 1;
  return proved ? 0 : 1;
}
