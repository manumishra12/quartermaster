import { digest } from './ledger.mjs';
import { canonicalise } from './idempotency.mjs';

/**
 * How long an approval is good for, and what would make it no longer be about the same thing.
 *
 * A person approves a rollback because of what was true when they were asked: this deploy is the
 * one that broke checkout, the error rate is still climbing, nothing else has changed. None of that
 * is in the call. The call is `rollback_deploy({id: "4c21"})`, and it means something different at
 * 03:14 than it does at 03:31 if a new deploy landed in between, or the metric recovered on its
 * own, or a second alert fired naming a different service.
 *
 * So an approval carries two things it did not carry before: a deadline, and the digest of the
 * evidence that justified it. Executing re-checks both. A changed digest voids the approval and the
 * person is asked again - the system does not get to decide that the change was immaterial, because
 * deciding that is exactly the judgement they were asked for.
 *
 * Expired and stale read the same to a naive implementation and mean opposite things to the person
 * being re-asked. Expired says "you approved this and we were slow" - the same question, again.
 * Stale says "you approved this and it is no longer that" - a different question wearing the same
 * words. Collapsing them into one message trains the operator to wave both through, and the one
 * they should have read was the second.
 */

/**
 * Five minutes.
 *
 * Long enough that reading a real call display - forty lines of file contents, a diff, a query -
 * and thinking about it does not expire the approval while the operator is typing. Short enough
 * that it cannot outlive the situation it was granted in: a deploy pipeline, an alert evaluation
 * window and a pager escalation all turn over in less than that, so an approval older than five
 * minutes has plausibly outlived at least one of them.
 *
 * It is a parameter because the right number belongs to the incident, not to this file. A change
 * window measured in seconds should pass something smaller and say so.
 */
export const DEFAULT_WINDOW_MS = 5 * 60_000;

/** Still good. */
export const VALID = 'valid';
/** The deadline passed. Same question, asked again. */
export const EXPIRED = 'expired';
/** The evidence moved. A different question, wearing the same words. */
export const STALE = 'stale';
/** Nothing bound this approval to anything, so nothing can be re-checked. */
export const UNSTAMPED = 'unstamped';
/** Evidence was bound and none was offered back, so staleness could not be tested. */
export const UNCHECKED = 'unchecked';

/**
 * The digest of what somebody was looking at.
 *
 * Canonicalised first, using the same function that keys a call. Spurious staleness is as damaging
 * as missed staleness: an approval voided because a metrics payload serialised its keys in a
 * different order teaches the operator that re-asks are noise, and the next one they wave through
 * is the real one.
 */
export function evidenceDigest(evidence) {
  return digest(JSON.stringify(canonicalise(evidence ?? null)) ?? 'null');
}

/** The digest of nothing, which is what an approval bound to no evidence carries. */
const NO_EVIDENCE = evidenceDigest(null);

/**
 * Bind an approval to the evidence that justified it and to a deadline.
 *
 * `at` and the window are given rather than read from the clock here, so a test can pin both. An
 * approval whose validity cannot be reproduced in a test is one nobody checks the bounds of, which
 * is how a window ends up being an hour by accident.
 */
export function stamp({ evidence = null, at = Date.now(), windowMs = DEFAULT_WINDOW_MS, tool = null, key = null } = {}) {
  const approvedAt = Number.isFinite(Number(at)) ? Number(at) : Date.now();
  /**
   * A window that is not a positive number is not a window. Treating a missing or nonsensical one
   * as "no deadline" would silently remove the check - a typo in a config key is not consent to an
   * approval that never expires.
   */
  const window = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0 ? Number(windowMs) : DEFAULT_WINDOW_MS;

  return {
    approvedAt,
    windowMs: window,
    expiresAt: approvedAt + window,
    evidence: evidenceDigest(evidence),
    tool,
    key,
  };
}

/**
 * Whether the approval still means what it meant, and if not, which of the two ways it stopped.
 *
 * `evidence` left out is not the same as `evidence: null`. Omitting it says the caller had nothing
 * to compare, which is a state of its own - if the stamp bound evidence, an unchecked approval is
 * not a valid one, because reporting it valid would claim a comparison that never happened.
 */
export function stillValid(mark, { now = Date.now(), evidence } = {}) {
  const no = (state, why, extra = {}) => ({ valid: false, state, why, ...extra });

  if (!mark || typeof mark !== 'object' || !Number.isFinite(Number(mark.expiresAt))) {
    // Defaulting to valid here would make an unstamped approval the most durable kind there is.
    return no(UNSTAMPED, 'this approval was never bound to evidence or to a deadline, so there is nothing to re-check', {
      expired: false,
      stale: false,
    });
  }

  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const expired = at > Number(mark.expiresAt);
  const boundEvidence = mark.evidence !== NO_EVIDENCE && mark.evidence != null;
  const offered = evidence !== undefined;
  const stale = boundEvidence && offered && evidenceDigest(evidence) !== mark.evidence;

  const age = Math.max(0, Math.round((at - Number(mark.approvedAt ?? mark.expiresAt)) / 1000));
  const overdue = Math.max(0, Math.round((at - Number(mark.expiresAt)) / 1000));

  /**
   * Staleness is reported first when both are true. The deadline is the less informative of the
   * two facts - it says the approval is old, and re-asking an old approval is routine. That the
   * world moved is the thing the person needs to see, and burying it under "it expired" is how
   * they end up re-approving a rollback of a deploy that is no longer the one that broke anything.
   */
  if (stale) {
    return no(
      STALE,
      `the evidence this was approved against has changed since it was approved ${age}s ago, so this is no longer the decision that was made`,
      { expired, stale: true, expiresAt: mark.expiresAt },
    );
  }

  if (expired) {
    return no(EXPIRED, `the approval passed its deadline ${overdue}s ago and has to be asked again`, {
      expired: true,
      stale: false,
      expiresAt: mark.expiresAt,
    });
  }

  if (boundEvidence && !offered) {
    return no(
      UNCHECKED,
      'this approval was bound to evidence and none was offered back, so whether it is still about the same situation was not tested',
      { expired: false, stale: false, expiresAt: mark.expiresAt },
    );
  }

  return {
    valid: true,
    state: VALID,
    why: `approved ${age}s ago, still inside its window, against the same evidence`,
    expired: false,
    stale: false,
    expiresAt: mark.expiresAt,
    msLeft: Number(mark.expiresAt) - at,
  };
}
