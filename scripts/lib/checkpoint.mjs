/**
 * The checkpoint file: session id, the turn in flight, how far we read, and what was refused.
 *
 * It is the whole resilience story - everything else lives on the server, and this process is
 * disposable by design. Which is exactly why it cannot be trusted the way the runner used to trust
 * it. It was `JSON.parse` spread straight over the live state, so whatever the file said became
 * what the run believed: a `denied` that is not a list threw on the first `for…of` and lost the
 * report, a `lastSequenceNumber` of `"0"` or `null` went out as `afterSequenceNumber`, and a
 * `sessionId` that is an object was interpolated into a request URL.
 *
 * None of that needs an attacker. A run killed mid-write left half a JSON document behind, because
 * the file was written in place with no temp-and-rename, and `--resume` then read the half.
 */
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** A run that has not started yet. Shape-compatible with what a good checkpoint parses to. */
export function blankCheckpoint(agentName = null) {
  return { sessionId: null, turnId: null, lastSequenceNumber: 0, agentName, denied: [], chain: [] };
}

/**
 * Parse a checkpoint, or say why it cannot be used.
 *
 * It throws rather than repairing what it can, and it throws on a single bad entry in `denied`
 * rather than dropping it. A refusal is a decision a person made, and a checkpoint we can only
 * half read must not be half believed - quietly discarding one id is how a call the operator
 * stopped comes back as a call that ran.
 */
export function parseCheckpoint(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('it is not valid JSON - a run killed mid-write can leave a truncated file');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('it is not an object');

  const optionalString = (value, field) => {
    if (value == null) return null;
    if (typeof value !== 'string') throw new Error(`${field} is not a string`);
    return value;
  };

  const sequence = raw.lastSequenceNumber ?? 0;
  if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 0) {
    throw new Error('lastSequenceNumber is not a whole count of events');
  }

  const denied = raw.denied ?? [];
  if (!Array.isArray(denied)) throw new Error('denied is not a list');
  for (const id of denied) {
    if (typeof id !== 'string' || id === '') throw new Error('denied holds something that is not a tool call id');
  }

  /**
   * The handoff chain, which lived only on argv and therefore only until the process ended.
   *
   * `--resume` does not carry `--chain`, so a resumed delegated run rebuilt the chain as just
   * itself. `MAX_CHAIN` and the no-revisiting rule are both computed from that list, so B could hand
   * straight back to A and the pair would trade the request between them, one process per hop, with
   * nothing counting. The bound that makes delegation terminate was one interrupted run from not
   * existing.
   *
   * Read leniently rather than thrown on, unlike `denied`: a missing chain is a run that never
   * delegated, which is the normal case, and an entry that is not an agent name is dropped rather
   * than taking the resume down. `denied` is strict because losing an id turns a refusal into a
   * call that ran; losing a chain entry only shortens a bound, and the shorter bound is the safe
   * direction.
   */
  const chain = Array.isArray(raw.chain) ? raw.chain.filter((n) => typeof n === 'string' && n !== '') : [];

  return {
    sessionId: optionalString(raw.sessionId, 'sessionId'),
    turnId: optionalString(raw.turnId, 'turnId'),
    lastSequenceNumber: sequence,
    agentName: optionalString(raw.agentName, 'agentName'),
    denied: [...denied],
    chain,
  };
}

/**
 * Write the checkpoint as a whole file or not at all.
 *
 * It is saved every twenty events during a live turn, so the window in which a kill can land
 * mid-write is not theoretical - and the one command that reads it back, `--resume`, is the one
 * used after exactly that kind of interruption. Writing beside it and renaming means a reader
 * sees either the old checkpoint or the new one; rename within a directory is atomic, which is
 * why the temp file is a sibling rather than somewhere in /tmp.
 */
export function writeCheckpoint(path, checkpoint) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(checkpoint, null, 2)}\n`);
    renameSync(temp, path);
  } catch (err) {
    // Leaving the temp file behind would accumulate one per failed save, all of them looking like
    // checkpoints to anyone reading the directory.
    try {
      unlinkSync(temp);
    } catch {
      // It may never have been created; the original failure is the one worth reporting.
    }
    throw err;
  }
}

/**
 * The session id, reduced to something that can only name a directory.
 *
 * The report is written to `evidence/<session>`, and the session id comes from the server on a
 * fresh run and from the checkpoint file on a resume. Interpolated raw, `../../..` in that field
 * chooses where the report lands - and the report is the artifact somebody reads to decide whether
 * to believe the run, so where it is written is not a detail.
 *
 * It sanitises rather than refuses. A report that cannot be filed under its own id is still worth
 * having; one that is not written at all is not.
 */
export function sessionDirName(sessionId) {
  const cleaned = String(sessionId ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 128);
  // `.` and `..` survive the character filter and are directories rather than names.
  if (!cleaned || /^\.+$/.test(cleaned)) return 'unknown-session';
  return cleaned;
}

/**
 * The furthest event we have seen, never a step back.
 *
 * This used to assign whatever the stream handed it. A sequence id arriving out of order - a
 * replayed batch, a reconnect that re-sends, anything the transport does that the runner does not
 * see - moved the mark backwards, and the next `--resume` asked for events after that lower number
 * and replayed everything in between. Every replayed tool response is a second execution in the
 * evidence for a command that ran once, which inflates the record in the agent's favour.
 */
export function advance(current, sequenceId) {
  const next = Number(sequenceId);
  if (sequenceId == null || !Number.isFinite(next)) return current;
  const from = Number.isFinite(current) ? current : 0;
  return next > from ? next : from;
}
