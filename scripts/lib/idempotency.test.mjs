import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXECUTED,
  NOT_EXECUTED,
  UNKNOWN,
  canonicalise,
  canonicalText,
  checkExecution,
  keyFor,
  load,
  noteCall,
  repeatDecision,
} from './idempotency.mjs';

const scratch = () => join(mkdtempSync(join(tmpdir(), 'idempotency-')), 'keys.jsonl');

test('the same call written two ways is the same key', () => {
  /**
   * The arguments reach the gate as text, and the text is whatever the model happened to emit.
   * `{"a":1,"b":2}` and `{"b":2,"a":1}` are one call; string equality says they are two, and the
   * check goes quiet at exactly the moment the model starts varying its own formatting.
   */
  const one = keyFor({ session: 's1', tool: 'rollback_deploy', args: '{"service":"checkout","force":true}' });
  const two = keyFor({ session: 's1', tool: 'rollback_deploy', args: '{"force":true,"service":"checkout"}' });
  assert.equal(one, two);

  // Nested, because a reordering one level down is the same reordering.
  assert.equal(
    keyFor({ tool: 't', args: { outer: { a: 1, b: 2 }, z: 3 } }),
    keyFor({ tool: 't', args: { z: 3, outer: { b: 2, a: 1 } } }),
  );

  // And an object given directly matches the text of the same object.
  assert.equal(keyFor({ tool: 't', args: { a: 1, b: 2 } }), keyFor({ tool: 't', args: '{"b":2,"a":1}' }));
});

test('order inside an array is meaning, and is kept', () => {
  // Reordering object keys changes nothing about the call. Reordering a list of files to delete
  // changes which file goes first, and collapsing the two would key two different calls the same.
  assert.notEqual(keyFor({ tool: 'delete', args: { paths: ['a', 'b'] } }), keyFor({ tool: 'delete', args: { paths: ['b', 'a'] } }));
});

test('the things that quietly collapse into each other are kept apart', () => {
  // JSON serialises NaN and Infinity as null, which would make three different arguments one key.
  assert.notEqual(canonicalText({ n: NaN }), canonicalText({ n: null }));
  assert.notEqual(canonicalText({ n: Infinity }), canonicalText({ n: NaN }));
  // A key holding undefined never survives the wire, so it is not part of the call that gets sent.
  assert.equal(canonicalText({ a: 1, b: undefined }), canonicalText({ a: 1 }));
  // A Date has no own keys, so a naive walk flattens every date to {} and two deadlines become one.
  assert.notEqual(canonicalText({ at: new Date(1) }), canonicalText({ at: new Date(2) }));
  assert.deepEqual(canonicalise({ b: 2, a: 1 }), { a: 1, b: 2 });
});

test('the session is part of the key, so next week is not a repeat of tonight', () => {
  /**
   * The same rollback during a different incident is a different decision. Keying without the
   * session would refuse it as something already done, which is the opposite failure - a control
   * that stops the work somebody actually asked for.
   */
  assert.notEqual(keyFor({ session: 's1', tool: 't', args: {} }), keyFor({ session: 's2', tool: 't', args: {} }));
  assert.notEqual(keyFor({ session: 's1', tool: 'a', args: {} }), keyFor({ session: 's1', tool: 'b', args: {} }));
});

test('arguments that will not parse are still keyed, and keyed as themselves', () => {
  // Refusing to key unreadable arguments would leave exactly the calls nobody can review either -
  // the ones where the gate already cannot show what is happening - with no protection at all.
  assert.equal(keyFor({ tool: 't', args: '{not json' }), keyFor({ tool: 't', args: '{not json' }));
  assert.notEqual(keyFor({ tool: 't', args: '{not json' }), keyFor({ tool: 't', args: '{also not json' }));
});

test('a call sent with no recorded outcome is unknown, and unknown is not no', () => {
  /**
   * The whole file. A run killed between dispatch and result leaves the `sent` line and nothing
   * after it, and that is the state in which a system that conflates unknown with "did not happen"
   * files the ticket a second time.
   */
  const path = scratch();
  const key = keyFor({ session: 's1', tool: 'create_issue', args: { title: 'checkout 500s' } });
  noteCall({ key, state: 'sent', tool: 'create_issue', session: 's1' }, path);

  const check = checkExecution(load(path), key);
  assert.equal(check.state, UNKNOWN);
  assert.notEqual(check.state, NOT_EXECUTED);
  assert.match(check.because, /no outcome was ever recorded/);

  const decision = repeatDecision(check);
  assert.equal(decision.repeat, false);
  assert.equal(decision.escalate, true, 'an unknown outcome needs a person, not a guess');
});

test('no record at all is unknown too, not an all-clear', () => {
  /**
   * "We have never seen this" and "this did not happen" are different sentences. The record may
   * simply never have been written - the process died, the disk was full - and answering the first
   * question with the second is the same guess made with even less to go on.
   */
  const check = checkExecution(load(scratch()), keyFor({ tool: 'send_email', args: {} }));
  assert.equal(check.state, UNKNOWN);
  assert.equal(repeatDecision(check).escalate, true);
});

test('a recorded outcome is believed, either way', () => {
  const path = scratch();
  const landed = keyFor({ session: 's1', tool: 'close_issue', args: { number: 7 } });
  const stopped = keyFor({ session: 's1', tool: 'send_email', args: { to: 'ops@example.com' } });

  noteCall({ key: landed, state: 'sent', tool: 'close_issue' }, path);
  noteCall({ key: landed, state: EXECUTED, tool: 'close_issue' }, path);
  noteCall({ key: stopped, state: NOT_EXECUTED, tool: 'send_email' }, path);

  const store = load(path);
  assert.equal(checkExecution(store, landed).state, EXECUTED);
  assert.equal(checkExecution(store, stopped).state, NOT_EXECUTED);

  // Refused for opposite reasons, and only one of them wants a person.
  assert.deepEqual(
    [repeatDecision(checkExecution(store, landed)).escalate, repeatDecision(checkExecution(store, stopped)).repeat],
    [false, true],
  );
});

test('a call dispatched again after it landed is unknown again', () => {
  // The second dispatch has its own unobserved outcome. Letting the older `executed` stand would
  // report a settled state for a call that is in flight right now.
  const path = scratch();
  const key = keyFor({ tool: 'restart_service', args: { service: 'checkout' } });
  noteCall({ key, state: EXECUTED }, path);
  noteCall({ key, state: 'sent' }, path);
  assert.equal(checkExecution(load(path), key).state, UNKNOWN);
});

test('a torn line pulls "did not happen" back to "cannot say"', () => {
  /**
   * Appending leaves half-written lines. A line that will not parse could be the outcome that
   * contradicts the one we can read, so answering confidently out of a file with a known hole in it
   * is the exact mistake this module refuses everywhere else.
   */
  const path = scratch();
  const key = keyFor({ tool: 'rollback_deploy', args: { id: '4c21' } });
  noteCall({ key, state: NOT_EXECUTED }, path);
  appendFileSync(path, '{"key":"4c21","sta');

  const store = load(path);
  assert.equal(store.unreadable, 1);
  assert.equal(checkExecution(store, key).state, UNKNOWN);
});

test('a store that cannot be written does not take the run with it', () => {
  // By the time this is called the dispatch has already happened. Throwing would lose the record
  // without unmaking the call, which is strictly the worse of the two outcomes.
  const blocked = join(mkdtempSync(join(tmpdir(), 'idempotency-')), 'a-file');
  writeFileSync(blocked, 'not a directory');
  assert.equal(noteCall({ key: 'k', state: EXECUTED }, join(blocked, 'keys.jsonl')), false);
  assert.equal(load(join(blocked, 'nothing.jsonl')).entries.size, 0);
  // A line with no key, or a state that is not one of the three, is not a record of anything.
  assert.equal(noteCall({ key: null, state: EXECUTED }, scratch()), false);
  assert.equal(noteCall({ key: 'k', state: 'maybe' }, scratch()), false);
});
