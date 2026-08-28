import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endedBecause, endedBadly, runExitCode } from './turn-state.mjs';

/**
 * The harness explains itself in two fields depending on how the turn died. Reading only one of
 * them is a mistake that has been made twice here, and it is invisible from the outside: the run
 * prints a bare status and the report records nothing, which reads as an agent that gave up.
 */

test('an error explains itself in message', () => {
  const state = { status: 'error', message: "Request failed (429): Quota exceeded for quota metric 'GenerateContent'." };
  assert.match(endedBecause(state), /429/);
});

test('a cancellation explains itself in reason', () => {
  // This is the one that was being dropped: two runs printed "[cancelled]" and nothing else.
  assert.equal(endedBecause({ status: 'cancelled', reason: 'server-execution-timeout' }), 'server-execution-timeout');
});

test('message wins when both are present, because it is the more specific of the two', () => {
  assert.equal(endedBecause({ message: 'the actual failure', reason: 'generic' }), 'the actual failure');
});

test('a turn that ended cleanly explains nothing', () => {
  // A failure section on a healthy run would make every report look like a problem.
  assert.equal(endedBecause({ status: 'completed' }), null);
  assert.equal(endedBecause(undefined), null);
  assert.equal(endedBecause(null), null);
});

test('an empty explanation is the absence of one, not a blank section', () => {
  assert.equal(endedBecause({ status: 'error', message: '' }), null);
  assert.equal(endedBecause({ status: 'error', message: '   ' }), null);
  // And it falls through to the field that does say something.
  assert.equal(endedBecause({ status: 'cancelled', message: '  ', reason: 'server-execution-timeout' }), 'server-execution-timeout');
});

test('a non-string explanation is not rendered into the report', () => {
  // JSON.stringify of an object here would put "[object Object]" in front of a person deciding.
  assert.equal(endedBecause({ message: { nested: 'thing' } }), null);
  assert.equal(endedBecause({ reason: 42 }), null);
});

test('which statuses are worth explaining', () => {
  assert.equal(endedBadly('error'), true);
  assert.equal(endedBadly('cancelled'), true);
  assert.equal(endedBadly('failed'), true);
  assert.equal(endedBadly('completed'), false);
  assert.equal(endedBadly(undefined), false);
});

/**
 * The exit code is what a pipeline reads, and it used to be the verdict alone - so every way a run
 * can fail without the agent claiming anything came out as success.
 */

test('a run that finished and proved its claim is the only zero', () => {
  assert.equal(runExitCode({ proved: true, status: 'completed' }), 0);
  assert.equal(runExitCode({ proved: false, status: 'completed' }), 1);
});

test('a crash is a failure however good the answer looked', () => {
  // The report is still written from whatever was recorded before the throw. It is the record of a
  // run that did not finish, and the exit code has to say the same thing the report does.
  assert.equal(runExitCode({ proved: true, crashed: true }), 1);
});

test('a turn that died on the plumbing is not a run that succeeded', () => {
  // No answer means no claim, and no claim used to be zero: a provider quota read as work done.
  assert.equal(runExitCode({ proved: true, status: 'error' }), 1);
  assert.equal(runExitCode({ proved: true, status: 'cancelled' }), 1);
  assert.equal(runExitCode({ proved: true, failure: 'Request failed (429): Quota exceeded' }), 1);
});

test('a run that ran out of rounds, or is waiting for a connector, has not finished', () => {
  assert.equal(runExitCode({ proved: true, unfinished: true }), 1);
  assert.equal(runExitCode({ proved: true, blockedOnAuth: true }), 1);
});

test('the ordinary healthy run is not caught by any of that', () => {
  // Both directions: an exit code that is always 1 tells CI as little as one that is always 0.
  assert.equal(runExitCode({ proved: true, status: 'completed', failure: null }), 0);
  assert.equal(runExitCode({ proved: true, status: undefined }), 0);
  assert.equal(runExitCode({ proved: true }), 0);
});
