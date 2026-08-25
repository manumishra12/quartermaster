import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from './env.mjs';

test('reads plain assignments', () => {
  assert.deepEqual(parseEnv('A=1\nB=two'), { A: '1', B: 'two' });
});

test('ignores comments and blank lines', () => {
  assert.deepEqual(parseEnv('# a comment\n\nA=1\n   \n'), { A: '1' });
});

test('strips a matching pair of quotes, and only a matching pair', () => {
  assert.equal(parseEnv('A="hello world"').A, 'hello world');
  assert.equal(parseEnv("A='hello world'").A, 'hello world');
  assert.equal(parseEnv('A="mismatched\'').A, '"mismatched\'');
});

test('keeps a value containing an equals sign intact', () => {
  assert.equal(parseEnv('URL=http://x/?a=1&b=2').URL, 'http://x/?a=1&b=2');
});

test('drops a trailing comment only when unquoted', () => {
  assert.equal(parseEnv('A=value # note').A, 'value');
  assert.equal(parseEnv('A="value # not a note"').A, 'value # not a note');
});

test('tolerates the export prefix people paste in', () => {
  assert.equal(parseEnv('export A=1').A, '1');
});

test('a line with no equals sign is skipped rather than throwing', () => {
  assert.deepEqual(parseEnv('nonsense\nA=1'), { A: '1' });
});

test('an empty value is respected, not treated as unset', () => {
  assert.deepEqual(parseEnv('A='), { A: '' });
});
