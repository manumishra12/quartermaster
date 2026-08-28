import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, read, record, summarise } from './ledger.mjs';

const scratch = () => join(mkdtempSync(join(tmpdir(), 'ledger-')), 'approvals.jsonl');

test('every decision is recorded, allowed as well as denied', () => {
  /**
   * The reports counted refusals and never approvals, which is backwards for a system built on
   * this gate: a refusal is the case where nothing happened. What somebody needs later is what was
   * let through.
   */
  const path = scratch();
  record({ session: 's1', tool: 'rollback_deploy', args: '{"deploy_id":"4c21"}', refused: false }, path);
  record({ session: 's1', tool: 'restart_service', args: '{}', refused: true, reason: 'denied by the operator' }, path);

  const entries = read(path);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.decision), ['allowed', 'denied']);
  assert.equal(entries[0].tool, 'rollback_deploy');
  assert.equal(entries[1].reason, 'denied by the operator');
});

test('an approval that did not come from a terminal is surfaced, not counted', () => {
  /**
   * The single invariant this project makes. `decideApproval` enforces it at the moment of the
   * decision; this checks the record from the other side, which is the only way to catch the day
   * somebody changes that function and every unit test still passes.
   */
  const path = scratch();
  record({ tool: 'send_email', refused: false, by: 'pipe' }, path);
  record({ tool: 'close_issue', refused: false, by: 'terminal' }, path);
  record({ tool: 'close_issue', refused: true, by: 'pipe' }, path);

  const s = summarise(read(path));
  assert.equal(s.allowed, 2);
  assert.equal(s.approvedWithoutATerminal.length, 1, 'a denial by pipe is fine; an approval is not');
  assert.equal(s.approvedWithoutATerminal[0].tool, 'send_email');
});

test('the arguments are digested rather than copied', () => {
  /**
   * The full text is already in the session's own report. Duplicating it here would put issue
   * bodies, commit contents and email drafts into a file whose whole purpose is to be widely
   * readable - so this carries enough to compare entries and nothing anybody would mind reading.
   */
  const path = scratch();
  const secretish = '{"body":"the customer\'s home address"}';
  record({ tool: 'send_email', args: secretish, refused: false }, path);

  const [entry] = read(path);
  assert.ok(!JSON.stringify(entry).includes('home address'));
  assert.equal(entry.args, digest(secretish));
  assert.equal(digest(secretish), digest(secretish), 'stable');
  assert.notEqual(digest('a'), digest('b'));
});

test('a truncated line is kept as a gap rather than dropped', () => {
  // Appending can leave a half-written last line, and one unreadable entry must not hide the
  // hundred good ones above it. A gap in an audit file is itself worth seeing.
  const path = scratch();
  record({ tool: 'close_issue', refused: false }, path);
  writeFileSync(path, `${read(path).map((e) => JSON.stringify(e)).join('\n')}\n{"tool":"send_ema`);

  const entries = read(path);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].decision, 'unreadable');
  assert.equal(summarise(entries).unreadable, 1);
});

test('a ledger that cannot be written does not take the run with it', () => {
  /**
   * The decision has already been made by the time this is called. Failing here would lose the
   * record and the turn, and the turn matters more.
   *
   * The unwritable path is a file used as a directory, which is ENOTDIR on every platform and
   * immediate. This used to be `/proc/nope/...`, chosen because /proc does not exist on macOS - and
   * on Linux, where CI runs, it very much does, and asking to create a directory inside a virtual
   * filesystem is not the fast refusal it is here. A test that depends on a path being absent is a
   * test that behaves differently wherever that path is present.
   */
  const blocked = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'a-file');
  writeFileSync(blocked, 'not a directory');
  assert.equal(record({ tool: 'x', refused: false }, join(blocked, 'approvals.jsonl')), false);
  assert.deepEqual(read(join(blocked, 'nothing.jsonl')), []);
});
