import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionals, readFlag } from './flags.mjs';

test('an ordinary value is read, and a flag that was not given keeps the default', () => {
  assert.deepEqual(readFlag(['--agent', 'analytics', 'fix it'], 'agent'), { value: 'analytics' });
  assert.deepEqual(readFlag(['fix it'], 'agent', 'quartermaster-local'), { value: 'quartermaster-local' });
});

test('a flag cannot become the value of the flag before it', () => {
  /**
   * The one that mattered: `--agent --deny-all` set the agent name to "--deny-all" and the flag
   * that refuses every irreversible call was consumed as text. It did not warn, and the run then
   * approved at the gate exactly as if the flag had never been typed.
   */
  assert.deepEqual(readFlag(['--agent', '--deny-all', 'fix it'], 'agent'), { problem: '--agent needs a value' });
});

test('a flag with nothing after it is a problem, not undefined', () => {
  assert.deepEqual(readFlag(['fix it', '--agent'], 'agent'), { problem: '--agent needs a value' });
  // And the fallback does not rescue it: the operator asked for something and did not say what.
  assert.deepEqual(readFlag(['--agent'], 'agent', 'quartermaster-local'), { problem: '--agent needs a value' });
});

test('a value that merely looks odd is still a value', () => {
  // Only a leading `--` is treated as a flag. A single dash, or a word containing dashes, is text.
  assert.deepEqual(readFlag(['--answer', '-1'], 'answer'), { value: '-1' });
  assert.deepEqual(readFlag(['--answer', 'no-do-not'], 'answer'), { value: 'no-do-not' });
  assert.deepEqual(readFlag(['--answer', ''], 'answer'), { value: '' });
});

test('the prompt is what is left when the flags and their values are taken out', () => {
  assert.deepEqual(
    positionals(['--agent', 'analytics', 'fix', 'the', 'test'], ['agent', 'answer']),
    ['fix', 'the', 'test'],
  );
  assert.deepEqual(
    positionals(['--deny-all', 'fix', 'the', 'test'], ['agent', 'answer']),
    ['fix', 'the', 'test'],
  );
});

test('a boolean flag does not swallow the word after it', () => {
  // --deny-all takes no value, so "fix" is prompt. Listing it as a value flag would eat the first
  // word of every prompt, which is the mirror image of the bug above.
  assert.deepEqual(positionals(['--resume', '--deny-all', 'fix'], ['agent']), ['fix']);
});
