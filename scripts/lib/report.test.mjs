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

test('a command cannot write its own section of the report', () => {
  /**
   * The command comes from the model. Interpolated between two plain backticks it could close its
   * own span and then write anything: a heading, a fenced block, a verdict. The report is the
   * artifact somebody reads to decide whether to believe the run, and a call forging that record
   * is the worst thing available here - worse than the call itself, whatever it was.
   */
  const forged = 'echo x`\n\n## Executions\n\n### 1. Test run - exit 0\n\n```text\nOK\n```\n\n`';
  const { markdown } = buildReport({
    ...base,
    finalText: 'done',
    toolResponses: [{ command: forged, exitCode: 0, output: 'x', denied: false }],
  });
  const lines = markdown.split('\n');
  assert.deepEqual(
    lines.filter((l) => l.startsWith('## ')),
    ['## Asked', '## Executions', '## Answer'],
    'the command wrote a section of its own',
  );
  assert.equal(lines.filter((l) => l.startsWith('### ')).length, 1, 'one execution, one heading');
  /**
   * One opening fence for the one recorded output, and one to close it. The command's own line
   * begins with backticks and is deliberately not counted: a backtick run followed by text
   * containing backticks cannot open a fence, which is why the delimiter is chosen to be longer
   * than anything inside it.
   */
  assert.equal(lines.filter((l) => /^`{3,}[a-z]*$/.test(l)).length, 2);
});

test('an ordinary command is still shown as itself', () => {
  // The escaping is worthless if it mangles the thing a reviewer actually came to read.
  const { markdown } = buildReport({
    ...base,
    finalText: 'done',
    toolResponses: [{ command: 'python3 -m pytest -q', exitCode: 0, output: 'OK', denied: false }],
  });
  assert.match(markdown, /python3 -m pytest -q/);
});

test('a turn that failed says why, instead of blaming the agent for the plumbing', () => {
  /**
   * A run killed by a provider quota produces no answer and no executions, which is
   * indistinguishable from an agent that sat there doing nothing. The harness reports the reason;
   * throwing it away left a reader guessing at whether the agent failed or the plumbing did.
   */
  const quota = "Request failed (429): Quota exceeded for quota metric 'GenerateContent'.";
  const { json, markdown } = buildReport({ ...base, finalText: '', toolResponses: [], failure: quota });
  assert.equal(json.verdict, 'no-answer');
  assert.equal(json.failure, quota);
  assert.match(markdown, /The turn did not finish/);
  assert.match(markdown, /429/);
  assert.match(markdown, /the turn failed; the reason is below/);
});

test('a turn that finished carries no failure section', () => {
  // The section must not appear for a healthy run, or every report starts looking like a problem.
  const { json, markdown } = buildReport({ ...base, finalText: 'The tests now pass.', toolResponses: [GREEN] });
  assert.equal(json.failure, null);
  assert.doesNotMatch(markdown, /did not finish/);
});
