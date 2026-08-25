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
