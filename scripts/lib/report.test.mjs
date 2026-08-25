import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from './report.mjs';

const toolResponse = (obj) => ({ content: JSON.stringify({ success: true, response: obj }) });
const GREEN = toolResponse({ exitCode: 0, result: 'Ran 5 tests in 0.001s\n\nOK\n' });
const RED = toolResponse({ exitCode: 1, result: 'Ran 5 tests\n\nFAILED (failures=1)' });

const base = { agent: 'quartermaster-local', prompt: 'fix the ledger test', sessionId: 'sess_1' };

test('a substantiated run records both executions', () => {
  const { json } = buildReport({ ...base, finalText: 'The tests now pass.', toolResponses: [RED, GREEN] });
  assert.equal(json.verdict, 'substantiated');
  assert.equal(json.counts.executions, 2);
  assert.equal(json.counts.testRuns, 2);
  assert.equal(json.phase.label, 'Report');
});

test('an unsupported claim says so in the markdown, not just the json', () => {
  const { json, markdown } = buildReport({ ...base, finalText: 'Fixed it, tests pass.', toolResponses: [] });
  assert.equal(json.verdict, 'unsubstantiated');
  assert.match(markdown, /UNSUBSTANTIATED/);
  assert.match(markdown, /Nothing ran/);
});

test('the report carries the raw output, not a summary of it', () => {
  const { markdown } = buildReport({ ...base, finalText: 'done', toolResponses: [RED] });
  assert.match(markdown, /FAILED \(failures=1\)/);
  assert.match(markdown, /exit 1/);
});

test('a multi-line prompt stays quoted throughout', () => {
  const { markdown } = buildReport({ ...base, prompt: 'line one\nline two', finalText: '', toolResponses: [] });
  assert.match(markdown, /> line one\n> line two/);
});

test('a refused call is reported, but never as something that happened', () => {
  /**
   * The gate exists to stop things happening, so what it stops cannot be filed under what
   * happened. A denial arrives as a tool response with no output and no exit code, which reads
   * exactly like a command that ran and printed nothing.
   */
  const denied = { command: 'add_issue_comment', exitCode: null, output: '', denied: true };
  const { json, markdown } = buildReport({
    ...base,
    finalText: 'The tool call was denied by the operator. I cannot post the comment.',
    toolResponses: [denied],
  });
  assert.equal(json.counts.executions, 0, 'a refusal is not an execution');
  assert.equal(json.counts.refused, 1);
  assert.equal(json.refused[0].command, 'add_issue_comment');
  assert.match(markdown, /Refused at the gate/);
  assert.match(markdown, /denied, did not run/);
  assert.doesNotMatch(markdown, /^### 1\. Command/m, 'it must not appear under executions');
});

test('a refusal cannot stand in for the evidence a claim needs', () => {
  // The guard against an answer with nothing behind it asks whether anything ran at all. Counting
  // the refusal answered yes, so being denied made a claim harder to catch rather than easier.
  const denied = { command: 'push_files', exitCode: null, output: '', denied: true };
  const { json } = buildReport({ ...base, finalText: 'Fixed it, the tests pass.', toolResponses: [denied] });
  assert.equal(json.verdict, 'unsubstantiated');
});

test('the answer is not swallowed by the last code block', () => {
  // The closing fence used to carry the `text` info string, which does not close anything. Every
  // report left its final block open, so the answer - the reason anyone opens the file - rendered
  // as code.
  const { markdown } = buildReport({ ...base, finalText: 'ANSWER_MARKER', toolResponses: [GREEN] });
  const fences = markdown.split('\n').filter((l) => /^`{3,}/.test(l.trim()));
  assert.equal(fences.length % 2, 0, 'every opening fence needs a closing one');
  assert.ok(
    fences.every((f, i) => (i % 2 === 1 ? /^`+$/.test(f.trim()) : true)),
    'a closing fence is backticks only',
  );
  const afterLastFence = markdown.slice(markdown.lastIndexOf(fences[fences.length - 1]));
  assert.match(afterLastFence, /ANSWER_MARKER/);
});
