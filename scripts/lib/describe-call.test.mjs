import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeCall } from './describe-call.mjs';

const render = (name, args) => describeCall(name, JSON.stringify(args)).join('\n');

test('a pull request shows what it is and where it goes', () => {
  const out = render('create_pull_request', {
    owner: 'manumishra12',
    repo: 'ledger-fixture',
    title: 'Fix split_evenly dropping the remainder',
    head: 'fix/split-remainder',
    base: 'main',
    body: 'x'.repeat(4000),
  });
  assert.match(out, /create_pull_request/);
  assert.match(out, /manumishra12/);
  assert.match(out, /Fix split_evenly/);
  assert.match(out, /base: main/);
});

test('a file write shows the whole body, not its first line', () => {
  // Two unrelated files share a first line every day. Showing only that let an operator approve
  // code they had never seen, while the display read as a complete account of the change.
  const out = render('push_files', {
    owner: 'o',
    repo: 'r',
    branch: 'fix/x',
    files: [
      { path: 'ledger/money.py', content: 'def split_evenly():\n    return REMAINDER_GOES_HERE' },
      { path: 'tests/test_money.py', content: 'import unittest\nassert True' },
    ],
  });
  assert.match(out, /writes 2 file\(s\)/);
  assert.match(out, /ledger\/money\.py {2}50 bytes/);
  assert.match(out, /REMAINDER_GOES_HERE/, 'the body must be visible, not just the first line');
  assert.match(out, /assert True/);
});

test('bytes are counted as bytes, not as UTF-16 code units', () => {
  // e-acute is two bytes and the emoji is four. Calling string length "bytes" understated both.
  const out = render('create_or_update_file', { path: 'note.md', content: 'é😀' });
  assert.match(out, /note\.md {2}6 bytes/);
});

test('text that will be published is shown in full', () => {
  // A pull request body and an issue comment are read by other people. Truncating them at 120
  // characters meant everything after that was approved unseen and published anyway.
  const body = `${'a'.repeat(300)}TRAILING_CLAUSE`;
  const out = render('create_pull_request', { owner: 'o', repo: 'r', title: 't', body });
  assert.match(out, /TRAILING_CLAUSE/);
});

test('every path is listed, however many there are', () => {
  // Stopping at ten meant the eleventh path - the interesting one - never reached the operator.
  const files = Array.from({ length: 25 }, (_, i) => ({ path: `f${i}.txt`, content: 'x' }));
  const out = render('push_files', { files });
  assert.match(out, /writes 25 file\(s\)/);
  assert.match(out, /f24\.txt/);
  assert.doesNotMatch(out, /and \d+ more/);
});

test('terminal control characters cannot rewrite the prompt', () => {
  // Formatted output has to escape these deliberately; the raw JSON it replaced escaped them
  // for free. A carriage return alone lets a crafted path overwrite the line above it.
  const esc = String.fromCharCode(27);
  const out = render('create_or_update_file', {
    path: `ok.txt${esc}[2J${String.fromCharCode(13)}  tool: harmless_tool`,
    content: `body${String.fromCharCode(7)}`,
  });
  assert.doesNotMatch(out, new RegExp(esc), 'no raw escape character may reach the terminal');
  assert.doesNotMatch(out, /\r/, 'no raw carriage return may reach the terminal');
  assert.match(out, /\\x1b/, 'it is escaped and still visible');
  assert.match(out, /\\x07/);
});

test('a display it cannot complete says so instead of trailing off', () => {
  const out = render('push_files', {
    files: [{ path: 'huge.txt', content: 'x'.repeat(60_000) }],
  });
  assert.match(out, /display incomplete/);
  assert.match(out, /deny unless/);
});

test('fields it does not recognise are still shown, so the summary hides nothing', () => {
  const out = render('some_tool', { unexpected_field: 'matters anyway' });
  assert.match(out, /unexpected_field: matters anyway/);
});

test('unparseable arguments are shown raw rather than summarised away', () => {
  const out = describeCall('exec', 'not json at all').join('\n');
  assert.match(out, /arguments \(unparsed\)/);
  assert.match(out, /not json at all/);
});

test('a call with no arguments still names the tool', () => {
  assert.match(describeCall('merge_pull_request', '').join('\n'), /merge_pull_request/);
});

test('bidirectional controls cannot reorder what the operator reads', () => {
  /**
   * These are not C0 or C1 and they print as nothing, but U+202E reverses the run after it and
   * the isolates reorder text around it - so a path can be made to read as something other than
   * what will be sent. Same attack as clearing the screen, done quietly.
   */
  const rlo = String.fromCharCode(0x202e);
  const isolate = String.fromCharCode(0x2066);
  const out = describeCall(
    'create_or_update_file',
    JSON.stringify({ path: `safe${rlo}gnp.exe`, title: `a${isolate}b` }),
  ).join('\n');
  assert.doesNotMatch(out, new RegExp(rlo));
  assert.doesNotMatch(out, new RegExp(isolate));
  assert.match(out, /\\x202e/);
  assert.match(out, /\\x2066/);
});

test('a field name cannot forge a line of the prompt', () => {
  // Unknown keys are deliberately rendered, so the label is argument-controlled like any value.
  // A key holding a newline could inject a line into the display the operator is reading.
  const out = describeCall('some_tool', JSON.stringify({ 'bad\nkey': 'x' })).join('\n');
  assert.doesNotMatch(out, /^bad$/m);
  assert.match(out, /bad\\nkey/);
});
