import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { digest } from './ledger.mjs';

/**
 * Whether this exact call has already been made, and a record of the ones that have.
 *
 * `retry.mjs` states the problem and then refuses to solve it: a turn that failed after somebody
 * approved a write may or may not have executed it - the call went out, the failure came back, and
 * nothing on this side can tell those two apart. So an approved turn is never retried. That is the
 * honest answer and it is also a cost: a rate limit that clears in thirty seconds ends the run,
 * because the one fact that would make the retry safe is not written down anywhere.
 *
 * This is the thing that would be written down. A key derived from the session, the tool and the
 * arguments identifies a call across attempts, and a record of what happened to each key answers
 * the question the retry cannot ask - has this already taken effect?
 *
 * What it buys and what it does not, because that difference matters more than the mechanism.
 *
 *   It makes a *repeat* safe to refuse. Given a key already recorded as landed, a second attempt is
 *   stopped here rather than sent, and stopped for a stated reason rather than out of caution.
 *
 *   It does NOT make the underlying tool idempotent. Nothing here reaches the far side. If the
 *   remote `rollback_deploy` rolls back twice when called twice, it still does - this only stops
 *   *this* runner from being the thing that calls it twice. A tool that is genuinely safe to repeat
 *   needs the key sent across and honoured there, which is the far side's job and not a claim this
 *   file is entitled to make on its behalf.
 *
 * The three states are the point. "We have no record" is not "it did not happen": a run killed
 * between dispatch and outcome leaves exactly that gap, and it is the gap the dangerous guess lives
 * in. Conflating the two is how a system decides, on no evidence, that it is safe to file the
 * ticket again.
 */

/** Where the record lives. Append-only JSON lines, for the same reasons as the approvals ledger. */
export const KEYS = 'evidence/idempotency.jsonl';

/** It already landed. A second attempt is a second execution. */
export const EXECUTED = 'executed';
/** It positively did not go out - refused at the gate, or never dispatched. Repeating is safe. */
export const NOT_EXECUTED = 'not-executed';
/** Cannot say. Either nothing was written down, or it was sent and no outcome ever came back. */
export const UNKNOWN = 'unknown';

/** The states a recorded line may carry. `sent` is an intent, not an outcome. */
const STATES = new Set(['sent', EXECUTED, NOT_EXECUTED]);

/**
 * The same call written twice, reduced to one form.
 *
 * `{"a":1,"b":2}` and `{"b":2,"a":1}` are the same call. They are not the same string, and the
 * arguments arrive at the gate *as a string* - the runner holds `call.function.arguments`, which is
 * whatever text the model happened to emit. Comparing that text is the bug: a model that reorders
 * its own JSON between attempts defeats the check entirely, and nothing anywhere asks it not to.
 *
 * Arrays keep their order, because order is meaning in an array. Objects do not, because it is not.
 */
export function canonicalise(value) {
  if (value === null || typeof value !== 'object') {
    /**
     * A number JSON cannot carry serialises as `null`, which would make NaN, Infinity and an absent
     * value the same argument. Naming it keeps three different calls three different keys.
     */
    if (typeof value === 'number' && !Number.isFinite(value)) return `#${String(value)}`;
    return value;
  }

  // A Date has no own enumerable keys, so the loop below would flatten every date to `{}` and make
  // two different deadlines the same call. Anything that knows how to serialise itself is asked.
  if (typeof value.toJSON === 'function') return canonicalise(value.toJSON());

  if (Array.isArray(value)) return value.map(canonicalise);

  const out = {};
  for (const key of Object.keys(value).sort()) {
    // `undefined` never survives the wire, so a key holding it is not part of the call that will be
    // sent. Keeping it would make two identical requests two different keys.
    if (value[key] === undefined) continue;
    out[key] = canonicalise(value[key]);
  }
  return out;
}

/** Canonical text for anything, including the argument strings the runner actually holds. */
export function canonicalText(args) {
  if (typeof args === 'string') {
    try {
      return JSON.stringify(canonicalise(JSON.parse(args)));
    } catch {
      // Arguments that will not parse are still the identity of the call. Refusing to key them
      // would leave exactly the unreadable calls - the ones nobody can review either - unprotected.
      return JSON.stringify(['unparsed', args]);
    }
  }
  return JSON.stringify(canonicalise(args ?? null)) ?? 'null';
}

/**
 * The key for one call.
 *
 * The session is part of it deliberately. The same rollback next week, during a different incident,
 * is a different decision and must not be refused as a repeat of this one. What this protects is a
 * call being made twice inside one piece of work, which is the failure retry.mjs will not risk.
 *
 * `digest` is the ledger's rather than a second hash that can drift from it. It identifies, it does
 * not protect, and a collision would make two different calls look like one - so the second would
 * be refused as a repeat. That is the safe direction to be wrong in.
 */
export function keyFor({ session = null, tool = null, args = null } = {}) {
  return digest(JSON.stringify([session ?? null, tool ?? null, canonicalText(args)]));
}

/**
 * Write one line. Never throws, for the ledger's reason: by the time this is reached the call has
 * already been dispatched, and failing here would lose the record without unmaking the call.
 */
export function noteCall({ key, state, tool = null, session = null, at = null }, path = KEYS) {
  if (!key || !STATES.has(state)) return false;
  const line = { at: at ?? new Date().toISOString(), key, state, tool, session };
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fold the file into what is known per key.
 *
 * Last line wins, including a `sent` after an `executed`: a call that landed and was then dispatched
 * a second time has an unobserved second outcome, and that is genuinely unknown again.
 *
 * `unreadable` is counted rather than skipped. A torn last line - the normal cost of appending -
 * could be the outcome for any key in here, so its existence is a fact the check below has to see.
 */
export function load(path = KEYS) {
  const store = { entries: new Map(), unreadable: 0 };

  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return store;
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      store.unreadable += 1;
      continue;
    }
    if (!entry?.key || !STATES.has(entry.state)) {
      store.unreadable += 1;
      continue;
    }
    store.entries.set(entry.key, entry);
  }

  return store;
}

/**
 * Executed, not executed, or cannot say.
 *
 * The `sent` case is the whole reason this file exists. The line was written before the call went
 * out, no outcome line ever followed it, and that is precisely what a run killed mid-call leaves
 * behind. It reads as unknown, and unknown is not "no".
 */
export function checkExecution(store, key) {
  const entry = store?.entries?.get(key);

  if (!entry) {
    return {
      state: UNKNOWN,
      because:
        'nothing here has a record of this call, and no record is not a record that it did not happen - the record may never have been written',
    };
  }

  if (entry.state === EXECUTED) {
    return { state: EXECUTED, at: entry.at, because: 'this call is recorded as having completed' };
  }

  if (entry.state === NOT_EXECUTED) {
    if (store.unreadable > 0) {
      /**
       * A line that will not parse could be the outcome that contradicts this one. Answering "did
       * not happen" from a record we know has a hole in it is a confident conclusion drawn from an
       * incomplete file, which is the failure this module exists to refuse.
       */
      return {
        state: UNKNOWN,
        at: entry.at,
        because: `recorded as not executed, but ${store.unreadable} line(s) of the record could not be read and one of them may be a later outcome`,
      };
    }
    return { state: NOT_EXECUTED, at: entry.at, because: 'this call is recorded as never having been dispatched' };
  }

  return {
    state: UNKNOWN,
    at: entry.at,
    because: 'the call was dispatched and no outcome was ever recorded, so it may or may not have taken effect',
  };
}

/**
 * Whether to make the call again, given what the record says.
 *
 * Two of the three answers are "no" and they are not the same "no". An `executed` repeat is refused
 * because the work is already done, which is a finished outcome. An `unknown` repeat is refused
 * because nobody can tell, which is not an outcome at all - it needs a person, and `escalate` is
 * how it says so.
 */
export function repeatDecision(check) {
  if (check?.state === NOT_EXECUTED) {
    return { repeat: true, escalate: false, why: 'the record says it never went out, so making it now is the first time' };
  }
  if (check?.state === EXECUTED) {
    return { repeat: false, escalate: false, why: 'it already ran - calling it again would be the second time, not a retry' };
  }
  return {
    repeat: false,
    escalate: true,
    why: `whether this already took effect cannot be established: ${check?.because ?? 'no check was made'}`,
  };
}
