import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Every decision made at the approval gate, in one append-only file.
 *
 * The reports recorded what was **refused** and not what was **permitted**, which is backwards for
 * a system whose whole argument is this gate. A refusal is the case where nothing happened; the
 * interesting audit question is the other one - what did somebody let through, when, and against
 * what were they looking at when they said yes.
 *
 * Per-session reports cannot answer it either, because the question spans sessions: "everything
 * approved this week", "every rollback anybody allowed", "did we ever approve a call whose
 * arguments we could not display". One file, one line per decision, appended and never rewritten.
 *
 * Deliberately not a database. It is read by `grep` at three in the morning by somebody who has
 * never seen this repository, and JSON lines is the format that survives that.
 */

export const LEDGER = 'evidence/approvals.jsonl';

/**
 * A digest of the arguments rather than the arguments.
 *
 * The full text is already in the session's own report, and duplicating it here would put issue
 * bodies, commit contents and email drafts into a file whose purpose is to be widely readable.
 * The digest answers the question this file is for - was the same call approved twice, does this
 * entry match the report - without carrying the payload.
 */
export function digest(text) {
  const source = String(text ?? '');
  // FNV-1a, because this identifies rather than protects and a dependency would be silly here.
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, '0')}:${source.length}`;
}

/**
 * Record one decision.
 *
 * Never throws. A ledger that takes a run down with it is worse than no ledger, and the decision
 * has already been made by the time this is called - failing here would lose the record *and* the
 * turn. It returns whether it wrote, so a caller that wants to say so can.
 */
export function record(entry, path = LEDGER) {
  const line = {
    at: entry.at ?? new Date().toISOString(),
    session: entry.session ?? null,
    agent: entry.agent ?? null,
    tool: entry.tool ?? null,
    decision: entry.refused ? 'denied' : 'allowed',
    /**
     * What kind of decision this was. Everything here was an approval until handoffs began writing
     * to the same file, and they are not approvals: a handoff is allowed by a check rather than by
     * a person, so filing one as an approval either breaks the terminal invariant or forces the
     * invariant to be softened. Naming the kind keeps both honest.
     */
    kind: entry.kind ?? 'approval',
    /**
     * How the decision arrived, which is the field an auditor reads first. A pipe can deny and can
     * never approve, so `allowed` beside anything other than `terminal` would be the finding.
     */
    by: entry.by ?? 'terminal',
    reason: entry.reason ?? null,
    args: digest(entry.args),
  };

  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Read it back, skipping anything that is not a line of JSON. */
export function read(path = LEDGER) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }

  return raw
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        /**
         * A truncated last line is the normal cost of appending, and one unreadable entry must not
         * hide the hundred good ones above it. It is kept as a marker rather than dropped, because
         * a gap in an audit file is itself worth seeing.
         */
        return { at: null, decision: 'unreadable', raw: line.slice(0, 120) };
      }
    });
}

/** What the ledger says, in the shape somebody asks for it. */
export function summarise(entries) {
  const allowed = entries.filter((e) => e.decision === 'allowed');
  const denied = entries.filter((e) => e.decision === 'denied');
  const unreadable = entries.filter((e) => e.decision === 'unreadable');

  const byTool = new Map();
  for (const entry of [...allowed, ...denied]) {
    const key = entry.tool ?? '(unnamed)';
    const seen = byTool.get(key) ?? { tool: key, allowed: 0, denied: 0 };
    seen[entry.decision === 'allowed' ? 'allowed' : 'denied'] += 1;
    byTool.set(key, seen);
  }

  /**
   * The one line an auditor is actually looking for. A pipe may refuse and may never approve, so
   * an approval that did not come from a terminal is a broken invariant rather than a statistic.
   */
  const approvedWithoutATerminal = allowed
    .filter((e) => (e.kind ?? 'approval') === 'approval')
    .filter((e) => e.by !== 'terminal');

  return {
    total: entries.length,
    handoffs: [...allowed, ...denied].filter((e) => e.kind === 'handoff'),
    allowed: allowed.length,
    denied: denied.length,
    unreadable: unreadable.length,
    tools: [...byTool.values()].sort((a, b) => b.allowed + b.denied - (a.allowed + a.denied)),
    approvedWithoutATerminal,
  };
}
