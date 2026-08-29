import { keyFor } from './idempotency.mjs';

/**
 * The two ways a run stops being work and starts being expenditure: it repeats itself, or it runs
 * past what anybody agreed to spend on it.
 *
 * Both end the same way. Not "proceed", because a run that has exhausted its budget has not
 * finished. Not "stop quietly" either, because a run that stopped without saying so is reported as
 * finished by everything downstream, and that is the same class of lie as reporting a test that
 * never ran. The answer to both is escalate: say what was established, say what was not, and give
 * it to somebody.
 */

/**
 * Three.
 *
 * Two identical calls in a row is a retry, and retrying once is normal and frequently correct -
 * `retry.mjs` is an entire file arguing for it. Three is the first count that cannot be explained
 * as one, and an agent that has issued the same call three times with nothing in between has
 * learned nothing from the second or the third.
 *
 * The rule is a *consecutive* run, with no different call in between, which is what keeps an
 * alternating poll off it: `check, deploy, check, deploy` never reaches a run of two. What it does
 * still catch is a tight poll - `check, check, check` against an endpoint that has not changed. On
 * reflection that is not a false positive. An agent that has read the same value three times and
 * done nothing else between the reads is stuck in the way this rule is looking for; the polling it
 * should be doing waits between the reads or does something with them. A caller who genuinely wants
 * a longer unbroken poll raises the threshold and says why, which is a decision somebody makes
 * rather than a hole left open for everybody.
 */
export const DEFAULT_LOOP_THRESHOLD = 3;

/**
 * The ceilings, and why each number.
 *
 * `toolCalls: 60` - a reproduce, diagnose, fix, verify pass on a real repository runs somewhere
 * between fifteen and thirty tool calls. Sixty leaves room for a bad day and still catches a run
 * that has stopped converging, well before it has spent an afternoon of tokens on it.
 *
 * `approvals: 10` - this is the ceiling that matters most, and it is the smallest for a reason. An
 * approval spends a person's attention, and attention is the resource this whole project is built
 * on. By the tenth prompt an operator is not reading the call, they are clearing the prompt, and a
 * gate in front of somebody who has stopped reading is worse than no gate: it launders the decision
 * without making it. Every other control here is worthless once that has happened.
 *
 * `wallClockMs: 15 minutes` - long enough for a genuine fix-and-verify including a slow test suite,
 * short enough that a hung run is noticed inside the time somebody spends getting coffee rather
 * than at the end of the day.
 *
 * All three are arguments rather than laws. `Infinity` is how a caller says "no ceiling here" - out
 * loud, in the call, where a reviewer can see it.
 */
export const DEFAULT_BUDGET = Object.freeze({ toolCalls: 60, approvals: 10, wallClockMs: 15 * 60_000 });

/** What each ceiling is counting, for the sentence a person reads. */
const UNITS = {
  toolCalls: 'tool calls',
  approvals: 'approvals requested',
  wallClockMs: 'milliseconds of wall clock',
};

/**
 * What makes two calls the same call.
 *
 * The digest of the canonicalised arguments, not string equality of the raw JSON. A model that
 * emits `{"service":"checkout","force":true}` and then `{"force":true,"service":"checkout"}` has
 * repeated itself exactly, and a comparison on the text says it has not - so the loop detector goes
 * quiet at precisely the moment the model starts varying its own formatting, which is a thing
 * models do.
 *
 * No session in the signature, because a loop is about this sequence of calls and not about which
 * run it belongs to.
 */
export function callSignature(call) {
  /**
   * A signature signs to itself.
   *
   * `run.mjs` pushed signatures into its history and `detectLoop` signed each element again, so
   * every entry hashed the *string* - which has no tool and no arguments - and collapsed to one
   * value. Three different calls read as three identical ones, and every run escalated on its third
   * tool response: the gate denied whatever was pending, the turn was cancelled, and the report said
   * an agent that had stopped learning. Nothing caught it, because this module's own tests pass
   * calls exactly as intended and never the thing the caller actually had.
   *
   * The caller was wrong and has been fixed. This makes the mistake impossible rather than merely
   * corrected, because the next caller will have the same two shapes available and no way to know
   * which one this wants.
   */
  if (typeof call === 'string') return call;
  return keyFor({ tool: call?.tool ?? call?.name ?? null, args: call?.args ?? call?.arguments ?? null });
}

/**
 * The first unbroken run of identical calls that reaches the threshold.
 *
 * Scanning the whole list rather than only its tail, so this gives the same answer whether it is
 * asked after every call or once at the end. `trailing` says whether the run is still going, which
 * is the difference between "it is stuck now" and "it was stuck earlier and got out".
 */
export function detectLoop(calls = [], { threshold = DEFAULT_LOOP_THRESHOLD } = {}) {
  const limit = Number.isFinite(Number(threshold)) && Number(threshold) >= 2 ? Math.floor(Number(threshold)) : DEFAULT_LOOP_THRESHOLD;
  const list = Array.isArray(calls) ? calls : [];

  let runStart = 0;
  let runSignature = null;

  for (let i = 0; i <= list.length; i += 1) {
    const signature = i < list.length ? callSignature(list[i]) : null;
    if (i > 0 && signature === runSignature) continue;

    const length = i - runStart;
    if (runSignature !== null && length >= limit) {
      const call = list[runStart];
      const tool = call?.tool ?? call?.name ?? '(unnamed tool)';
      return {
        looping: true,
        tool,
        count: length,
        threshold: limit,
        signature: runSignature,
        from: runStart,
        trailing: i === list.length,
        why: `${tool} was called ${length} times in a row with identical arguments and nothing in between, which is an agent that has stopped learning from its own results`,
      };
    }

    runStart = i;
    runSignature = signature;
  }

  return { looping: false, threshold: limit, why: `no call was repeated ${limit} times in a row` };
}

/**
 * Fill in the ceilings a caller did not name.
 *
 * A key that is absent, or present and not a usable number, falls back to the default rather than
 * to no limit. A typo in a config key silently removing a ceiling is the quiet failure this whole
 * file exists to prevent, and it would remove exactly the ceiling nobody noticed was missing.
 */
export function budgetFrom(overrides = {}) {
  const merged = { ...DEFAULT_BUDGET };
  for (const key of Object.keys(DEFAULT_BUDGET)) {
    const raw = overrides?.[key];
    // `null` is an absent ceiling, not a ceiling of zero. `Number(null)` is 0, which would turn a
    // half-filled config into a budget that escalates on the first tool call.
    if (raw == null) continue;
    const given = Number(raw);
    // Infinity is a deliberate "no ceiling" and survives; NaN, negatives and nonsense do not.
    if (Number.isFinite(given) ? given >= 0 : given === Infinity) merged[key] = given;
  }
  return merged;
}

/**
 * Whether the run is still inside what was agreed, and what to do when it is not.
 *
 * Every exceeded ceiling is reported, not just the first. A run that blew through its tool calls
 * and its clock has two things wrong with it, and naming one of them invites somebody to raise that
 * ceiling and run into the other.
 */
export function checkBudget(spent = {}, budget = DEFAULT_BUDGET) {
  const ceilings = budgetFrom(budget);
  const exceeded = [];
  const remaining = {};

  for (const key of Object.keys(DEFAULT_BUDGET)) {
    const used = Number(spent?.[key] ?? 0);
    const ceiling = ceilings[key];
    const count = Number.isFinite(used) ? used : 0;
    remaining[key] = ceiling - count;
    if (count > ceiling) exceeded.push({ limit: key, spent: count, ceiling, unit: UNITS[key] });
  }

  if (exceeded.length === 0) return { within: true, escalate: false, exceeded: [], remaining, why: 'inside every ceiling' };

  const said = exceeded.map((e) => `${e.spent} ${e.unit} against a ceiling of ${e.ceiling}`).join('; ');
  return {
    within: false,
    /**
     * Not `proceed`, and not a silent stop. A run that ran out of budget has not finished, and the
     * only honest report of it is one that says so to a person.
     */
    escalate: true,
    exceeded,
    remaining,
    why: `the run went past what was budgeted for it - ${said} - so it has not finished and cannot be reported as though it had`,
  };
}
