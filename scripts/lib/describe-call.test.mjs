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

test('a file write shows the paths and sizes, not four thousand characters of JSON', () => {
  // The case this exists for: the operator used to see 800 characters of a blob and type allow.
  const out = render('push_files', {
    owner: 'o',
    repo: 'r',
    branch: 'fix/x',
    files: [
      { path: 'ledger/money.py', content: 'def split_evenly():\n' + 'y'.repeat(3000) },
      { path: 'tests/test_money.py', content: 'import unittest\n' + 'z'.repeat(500) },
    ],
  });
  assert.match(out, /writes 2 file\(s\)/);
  assert.match(out, /ledger\/money\.py {2}3020 bytes/);
  assert.match(out, /first line: def split_evenly\(\):/);
  assert.ok(out.length < 900, 'the summary must stay readable');
});

test('a long value is truncated with its true length stated', () => {
  const out = render('create_issue', { title: 'a'.repeat(400) });
  assert.match(out, /\(400 chars\)/);
});

test('many files are counted rather than listed forever', () => {
  const files = Array.from({ length: 25 }, (_, i) => ({ path: `f${i}.txt`, content: 'x' }));
  const out = render('push_files', { files });
  assert.match(out, /writes 25 file\(s\)/);
  assert.match(out, /… and 15 more/);
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
