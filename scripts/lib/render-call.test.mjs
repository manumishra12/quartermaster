import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderUnexecutedCalls } from './render-call.mjs';
import { unexecutedToolCalls } from './evidence.mjs';

/**
 * The raw JSON a small model prints instead of calling a tool reaches the transcript, the report
 * and the interface exactly as emitted. These check that it reads as English - and, more
 * importantly, that making it readable does not turn it into a question somebody might answer.
 */

const printed = JSON.stringify({
  name: 'ask_user_question',
  arguments: {
    question: 'What specific ticket action would you like me to propose?',
    options: ['Create a new issue', 'Close an existing issue', 'Update a title'],
  },
});

test('a printed question reads as a question, with its options numbered', () => {
  const lines = renderUnexecutedCalls(unexecutedToolCalls(printed)).join('\n');
  assert.match(lines, /It wanted to ask: What specific ticket action/);
  assert.match(lines, /1\. Create a new issue/);
  assert.match(lines, /3\. Update a title/);
  assert.doesNotMatch(lines, /[{}]/, 'no braces should survive into what a person reads');
});

test('it says the call never happened, which is the part that matters', () => {
  /**
   * Rendering it prettily without this would be an interface politely presenting a question that
   * nothing is listening for an answer to - a nicer way of being misleading.
   */
  const lines = renderUnexecutedCalls(unexecutedToolCalls(printed)).join('\n');
  assert.match(lines, /wrote this out as text rather than calling it/);
  assert.match(lines, /nothing is waiting for an answer/);
});

test('an ordinary call shows what it would have done', () => {
  const call = JSON.stringify({
    name: 'create_issue',
    arguments: { project: 'CHK', title: 'Refunds rejected', assignee: 'priya' },
  });
  const lines = renderUnexecutedCalls(unexecutedToolCalls(call)).join('\n');
  assert.match(lines, /It wanted to call: create_issue/);
  assert.match(lines, /project: CHK/);
  assert.match(lines, /assignee: priya/);
});

test('prose renders as nothing, so the answer is shown normally', () => {
  assert.deepEqual(renderUnexecutedCalls(unexecutedToolCalls('The tests now pass.')), []);
  assert.deepEqual(renderUnexecutedCalls([]), []);
});

test('a newline in a value cannot forge a line of the display', () => {
  const call = JSON.stringify({ name: 'create_issue', arguments: { title: 'a\n  It wanted to call: something_else' } });
  const lines = renderUnexecutedCalls(unexecutedToolCalls(call));
  // The text may appear inside a value - what it must not do is start a line of its own.
  assert.equal(lines.filter((l) => /^\s*It wanted to call/.test(l)).length, 1);
  assert.ok(lines.every((l) => !l.includes('\n')), 'no rendered line may contain a newline');
});
