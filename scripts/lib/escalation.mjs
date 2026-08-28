import { visible } from './describe-call.mjs';

/**
 * The third outcome, beside worked and failed.
 *
 * An agent holding two tool results that contradict each other, or one that has spent its budget,
 * or one that has called the same thing three times in a row, has a correct answer available to it
 * that neither of the existing two describes: "I do not know, and here is what I have." Forcing
 * that into "worked" is a lie about the work. Forcing it into "failed" is a lie about the agent -
 * it did not fail, it arrived somewhere that needs a person - and it throws away the part that is
 * worth having, which is everything that *was* established on the way.
 *
 * So an escalation carries three lists rather than a message: what is established, what is not, and
 * what would settle it. The last one is what makes it actionable rather than a shrug. A person
 * reading "I could not determine whether the rollback landed" needs to be told what to look at.
 *
 * It is deliberately not a fourth exit code. `runExitCode` already has the right question in it -
 * whether the run finished comes before whether its answer was any good - and an escalation is a
 * run that did not finish. `runOutcome` below hands it back in that vocabulary rather than inventing
 * a parallel one, because two systems for saying "this did not go well" is how they end up
 * disagreeing about the same run.
 */

/** The outcome name, so a caller can compare rather than duck-type. */
export const ESCALATED = 'escalated';

/** Why an agent stops and asks. Each of these is produced by one of the controls beside this file. */
export const REASONS = Object.freeze({
  /** Two results that cannot both be true. Picking the convenient one is the failure. */
  CONFLICTING_EVIDENCE: 'conflicting-evidence',
  /** A ceiling in `limits.mjs` was passed. The run has not finished. */
  BUDGET_EXHAUSTED: 'budget-exhausted',
  /** The same call, three times, with nothing in between. */
  LOOP_DETECTED: 'loop-detected',
  /** `expiry.mjs` says the approval no longer describes the situation it was given for. */
  APPROVAL_STALE: 'approval-stale',
  /** `idempotency.mjs` cannot say whether a call already took effect. */
  OUTCOME_UNKNOWN: 'outcome-unknown',
  /** Somebody built an escalation without saying why. Still an escalation. */
  UNSTATED: 'unstated',
});

const KNOWN = new Set(Object.values(REASONS));

/**
 * Lists that survive whatever is put in them.
 *
 * Anything not a usable string is serialised rather than dropped. A dropped item is a fact the
 * person reading this does not get to see, and the whole value of an escalation is that it hands
 * over everything it has.
 */
function lines(value) {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  return list
    .map((item) => (typeof item === 'string' ? item.trim() : JSON.stringify(item) ?? String(item)))
    .filter((item) => item !== '');
}

/**
 * Build one.
 *
 * It never throws, and an escalation missing its reason is still an escalation. Throwing here would
 * lose the escalation, and a lost escalation is reported by everything downstream as a run that
 * finished - which is the single outcome this file exists to prevent. A missing reason is a bug in
 * the caller and it is recorded as one, in the artifact, where somebody will see it.
 */
export function escalate({ because = null, detail = null, established = [], notEstablished = [], next = [], at = null } = {}) {
  const reason = KNOWN.has(because) ? because : REASONS.UNSTATED;

  return {
    outcome: ESCALATED,
    because: reason,
    detail:
      typeof detail === 'string' && detail.trim()
        ? detail.trim()
        : reason === REASONS.UNSTATED
          ? 'no reason was given for this escalation, which is itself worth looking at'
          : null,
    established: lines(established),
    notEstablished: lines(notEstablished),
    next: lines(next),
    at: at ?? new Date().toISOString(),
  };
}

/** Whether something is one, without trusting a truthy field. */
export function isEscalation(value) {
  return Boolean(value) && typeof value === 'object' && value.outcome === ESCALATED;
}

/**
 * The escalation in the vocabulary `runExitCode` already speaks.
 *
 * `unfinished`, because that is exactly what this is: the run stopped somewhere short of an answer.
 * `runExitCode` puts that question ahead of the verdict, which is the behaviour wanted here - an
 * escalated run may still hold a SUBSTANTIATED partial answer, and it must not exit 0 on the
 * strength of it. Spreading this into the existing call is the whole point; a second exit-code
 * function would be a second opinion about the same run.
 */
export function runOutcome(escalation) {
  if (!isEscalation(escalation)) return {};
  return { unfinished: true };
}

/**
 * The escalation as lines for a terminal.
 *
 * Everything printed here came from somewhere - a tool result, a model's own words, an argument
 * value - so it goes through the same escaping the approval display uses. A "what was established"
 * line carrying an escape sequence would rewrite the report a person is reading in order to decide
 * what to do next, which is the worst moment to be lied to.
 */
export function renderEscalation(escalation) {
  if (!isEscalation(escalation)) return [];

  const out = ['  ── ESCALATED ──────────────────────────────────────', `  This did not finish. Reason: ${escalation.because}`];
  if (escalation.detail) out.push(`  ${visible(escalation.detail)}`);

  const section = (heading, items, empty) => {
    if (items.length === 0) {
      out.push(`  ${heading}: ${empty}`);
      return;
    }
    out.push(`  ${heading}:`);
    for (const item of items) out.push(`    - ${visible(item)}`);
  };

  section('Established', escalation.established, 'nothing was established');
  section('Not established', escalation.notEstablished, 'nothing was named, which is worth asking about');
  section('What would settle it', escalation.next, 'nothing was suggested, so somebody has to work it out from here');

  return out;
}
