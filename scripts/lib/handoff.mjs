import { authorityOf, widening } from './authority.mjs';

/**
 * One agent handing work to another, without that being a way around the gate.
 *
 * Delegation is the feature everybody wants from a fleet of agents and it is also the quietest
 * hole in one. Three things go wrong, and only the first is obvious:
 *
 *   1. **Authority widens.** The receiver reaches something the sender could not, or could only
 *      reach by asking somebody. `authority.mjs` answers that; this refuses on the answer.
 *   2. **Claims are inherited as facts.** The sender writes "I ran the tests and they pass" into
 *      the handoff, and the receiver - which has no way to check - reports it onward as though it
 *      had seen it. Two hops later the claim is load-bearing and nothing behind it ever ran. So
 *      the note travels as *untrusted text*, framed exactly the way an issue body from a stranger
 *      is framed, because that is what it is: input written by a model.
 *   3. **It never terminates.** A routes to B, B decides it is really A's job, and the pair spend
 *      the budget passing the same request back and forth. Bounded depth, and no revisiting.
 *
 * The approval itself is never carried. A pending approval belongs to the turn it was raised in;
 * a handoff starts a new session and the gate applies again from the beginning. There is no field
 * here for "already approved" and that absence is the design.
 */

/**
 * Three hops is enough for any routing this project has a use for, and a request still moving
 * after that is not being delegated - it is being avoided.
 */
export const MAX_CHAIN = 3;

/** Build the envelope, or say why there is not going to be one. */
export function handoff({ from, to, request, because, chain = [], specs }) {
  if (!from || !to) return { ok: false, refusal: 'a handoff needs both a sender and a receiver' };
  if (from === to) return { ok: false, refusal: `${from} cannot hand off to itself` };
  if (!because?.trim()) {
    // A handoff with no stated reason cannot be reviewed by the person who finds it in the ledger.
    return { ok: false, refusal: 'a handoff must say why, in the sender\'s own words' };
  }

  const walked = chain.length ? chain : [from];

  if (walked.includes(to)) {
    return {
      ok: false,
      refusal: `${to} has already handled this request (${walked.join(' -> ')}); handing back to it is a loop`,
    };
  }

  if (walked.length >= MAX_CHAIN) {
    return {
      ok: false,
      refusal: `this request has already passed through ${walked.length} agents (${walked.join(' -> ')}); ask a person rather than delegating again`,
    };
  }

  /**
   * `Object.hasOwn`, not a truthiness check on `specs[to]`.
   *
   * `run.mjs` builds this map with `Object.fromEntries`, so it carries `Object.prototype`. A bare
   * lookup for `constructor`, `toString`, `valueOf` or `hasOwnProperty` returns an inherited member,
   * which is truthy, so the "no spec" refusal never fired and `authorityOf` was handed a function
   * instead of a manifest. It read no connectors, no sandbox and subagents-enabled, `widening`
   * found nothing to compare, and the handoff was allowed - with the ledger recording it as allowed
   * and the console announcing that nothing the receiver could reach was beyond the sender.
   *
   * `asked.to` comes out of a fenced block in model output, so an issue body or a web page could
   * ask for exactly that name. The one control that makes an ungated handoff safe was skippable by
   * a word.
   *
   * This project had already met this bug and fixed it in the MCP servers, which guard their
   * lookups the same way. The lesson did not travel; it does now.
   */
  const sender = Object.hasOwn(Object(specs), from) ? specs[from] : undefined;
  const receiver = Object.hasOwn(Object(specs), to) ? specs[to] : undefined;
  if (!sender || !receiver) {
    // Refusing on a missing spec rather than proceeding unchecked: the check that cannot run is
    // not the same as the check that passed, and this is the one place that distinction is free.
    return { ok: false, refusal: `cannot compare authority: no spec for ${!sender ? from : to}` };
  }

  const widened = widening(authorityOf(sender), authorityOf(receiver));
  if (widened.length > 0) {
    return {
      ok: false,
      refusal: `handing from ${from} to ${to} would widen what this request can do`,
      widened,
    };
  }

  return {
    ok: true,
    envelope: {
      v: 1,
      from,
      to,
      because: because.trim(),
      chain: [...walked, to],
      request,
    },
  };
}

/**
 * Re-exported so callers that want the whole protocol import one module. The format lives in
 * `handoff-envelope.mjs` because the interface needs it without the filesystem.
 */
export { parseHandoffEnvelope, renderHandoff, requestedHandoff } from './handoff-envelope.mjs';
