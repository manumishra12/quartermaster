import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advance, blankCheckpoint, parseCheckpoint, sessionDirName, writeCheckpoint } from './checkpoint.mjs';

const good = JSON.stringify({
  sessionId: 'sess_1',
  turnId: 'turn_1',
  lastSequenceNumber: 42,
  agentName: 'quartermaster-local',
  denied: ['call_a'],
});

test('a checkpoint the runner wrote reads back unchanged', () => {
  assert.deepEqual(parseCheckpoint(good), {
    sessionId: 'sess_1',
    turnId: 'turn_1',
    lastSequenceNumber: 42,
    agentName: 'quartermaster-local',
    denied: ['call_a'],
    // A checkpoint written before delegation existed has no chain, which reads as never delegated.
    chain: [],
  });
});

test('a fresh run parses too, so the guard does not reject the ordinary starting state', () => {
  assert.deepEqual(parseCheckpoint(JSON.stringify(blankCheckpoint('analytics'))), blankCheckpoint('analytics'));
});

test('a truncated file is named as one instead of throwing somewhere else', () => {
  // The realistic corruption: a kill during the in-place write the save used to do.
  assert.throws(() => parseCheckpoint('{"sessionId": "sess_1", "las'), /not valid JSON/);
});

test('a field of the wrong type is refused rather than used', () => {
  // sessionId went into a request URL and into the report path; turnId into the URL beside it.
  assert.throws(() => parseCheckpoint('{"sessionId": {"toString": 1}}'), /sessionId is not a string/);
  assert.throws(() => parseCheckpoint('{"turnId": 7}'), /turnId is not a string/);
  // lastSequenceNumber went out as afterSequenceNumber, where a string means nothing good.
  assert.throws(() => parseCheckpoint('{"lastSequenceNumber": "42"}'), /whole count of events/);
  assert.throws(() => parseCheckpoint('{"lastSequenceNumber": -1}'), /whole count of events/);
  assert.throws(() => parseCheckpoint('{"lastSequenceNumber": 1.5}'), /whole count of events/);
  assert.throws(() => parseCheckpoint('[]'), /not an object/);
});

test('a denied list that is not a list of ids is refused, not repaired', () => {
  /**
   * Dropping the bad entry and keeping the rest would be the tempting thing, and it is the wrong
   * one: every id in here is a call a person refused, and losing one turns it back into a call the
   * report says ran.
   */
  assert.throws(() => parseCheckpoint('{"denied": "call_a"}'), /denied is not a list/);
  assert.throws(() => parseCheckpoint('{"denied": ["call_a", 3]}'), /not a tool call id/);
  assert.throws(() => parseCheckpoint('{"denied": [""]}'), /not a tool call id/);
});

test('a checkpoint is written whole or not at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quartermaster-checkpoint-'));
  const path = join(dir, 'run.json');
  writeFileSync(path, JSON.stringify({ sessionId: 'old' }));
  writeCheckpoint(path, { ...blankCheckpoint('analytics'), sessionId: 'sess_2' });

  assert.equal(parseCheckpoint(readFileSync(path, 'utf8')).sessionId, 'sess_2');
  // The temp file is a sibling, so the rename is atomic - and it must not be left lying around
  // looking like a checkpoint of its own.
  assert.deepEqual(readdirSync(dir), ['run.json']);
});

test('the directory is created, because the first save of a run happens before anything else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quartermaster-checkpoint-'));
  const path = join(dir, 'nested', 'run.json');
  writeCheckpoint(path, blankCheckpoint('analytics'));
  assert.equal(parseCheckpoint(readFileSync(path, 'utf8')).agentName, 'analytics');
});

test('a session id cannot choose where the report is written', () => {
  // evidence/<session>/report.md, with the session id coming from the server or from the file.
  assert.equal(sessionDirName('../../etc/cron.d/x'), '.._.._etc_cron.d_x');
  assert.equal(sessionDirName('/etc/passwd'), '_etc_passwd');
  assert.equal(sessionDirName('..'), 'unknown-session');
  assert.equal(sessionDirName('.'), 'unknown-session');
  assert.equal(sessionDirName(''), 'unknown-session');
  assert.equal(sessionDirName(null), 'unknown-session');
  assert.equal(sessionDirName('a\u0000b'), 'a_b');
});

test('a real session id is left exactly as it is', () => {
  // The confinement is worthless if it renames every report directory the project already has.
  assert.equal(sessionDirName('sess_01JQZ8Q7X9'), 'sess_01JQZ8Q7X9');
  assert.equal(sessionDirName('4d1f2e0a-9c3b-4f5a-8e21-77bb0c1d2e3f'), '4d1f2e0a-9c3b-4f5a-8e21-77bb0c1d2e3f');
});

test('the read mark only ever goes forward', () => {
  /**
   * An out-of-order or replayed sequence id used to move the mark backwards, and the next --resume
   * asked for everything after that lower number. Replayed tool responses are counted a second
   * time, so a command that ran once appears twice in the evidence.
   */
  assert.equal(advance(10, 11), 11);
  assert.equal(advance(10, 4), 10);
  assert.equal(advance(10, '11'), 11);
  assert.equal(advance(0, 1), 1);
});

test('an unusable sequence id leaves the mark where it was', () => {
  // The replay path passes null deliberately, and a non-numeric id used to write NaN, which
  // JSON.stringify stores as null and resume then sends as afterSequenceNumber.
  assert.equal(advance(10, null), 10);
  assert.equal(advance(10, undefined), 10);
  assert.equal(advance(10, 'evt_7'), 10);
  assert.equal(advance(10, Infinity), 10);
});

test('the handoff chain survives a resume, because argv does not', () => {
  /**
   * The chain lived only on argv, and `--resume` does not carry `--chain`. A resumed delegated run
   * rebuilt it as just itself, so `MAX_CHAIN` counted one hop and the no-revisiting rule had
   * nothing to check - B could hand straight back to A and the pair would trade the request
   * between them, one process per hop, with nothing counting.
   */
  const read = parseCheckpoint(JSON.stringify({ ...blankCheckpoint('b'), chain: ['a', 'b'] }));
  assert.deepEqual(read.chain, ['a', 'b']);
});

test('a chain entry that is not an agent name is dropped rather than throwing', () => {
  /**
   * Deliberately unlike `denied`, which throws on a bad entry. Losing a denial turns a refusal
   * into a call that ran; losing a chain entry only shortens a bound, and shorter is the safe
   * direction. A missing chain is simply a run that never delegated.
   */
  assert.deepEqual(parseCheckpoint(JSON.stringify({ ...blankCheckpoint('b'), chain: ['a', 7, ''] })).chain, ['a']);
  assert.deepEqual(parseCheckpoint(JSON.stringify(blankCheckpoint('b'))).chain, []);
});
