import { describe, expect, test } from 'vitest';
// @ts-expect-error - shared JS module, aliased in vite.config.ts
import { isGreen, resultOf } from '@evidence';

/**
 * The interface and the CLI must reach the same verdict on the same envelope.
 *
 * This file exists because they did not. Sharing `isGreen` was not enough: the rail had its own
 * `unwrap`, so the *rule* was shared while the parsing feeding it was not. On four real envelope
 * shapes the CLI read FAILED and the rail rendered "Last run passed" - the safety surface
 * disagreeing with the verifier, in the direction of reassurance.
 *
 * These are the exact shapes that diverged.
 */
const envelope = (inner: unknown) => ({ content: JSON.stringify({ response: inner }) });

describe('the rail parses envelopes exactly as the CLI does', () => {
  const failing = [
    ['snake_case exit code', { exit_code: 1, result: 'Ran 3 tests\nOK\n' }],
    ['numeric-string exit code', { exitCode: '1', result: 'Ran 3 tests\nOK\n' }],
    ['empty result masking a populated output', { exitCode: 0, result: '', output: 'FAILED (failures=1)' }],
    ['MCP text-part array', { exitCode: 0, result: [{ type: 'text', text: 'FAILED (failures=1)' }] }],
  ] as const;

  for (const [name, inner] of failing) {
    test(`${name} is a failure, not a pass`, () => {
      const run = resultOf(envelope(inner), 'npm test');
      expect(isGreen(run), `${name} was read as passing`).toBe(false);
    });
  }

  test('a genuinely passing run is still read as passing', () => {
    const run = resultOf(envelope({ exitCode: 0, result: 'Ran 5 tests in 0.01s\n\nOK\n' }), 'npm test');
    expect(isGreen(run)).toBe(true);
  });

  test('an unrecognised shape is reported as unread, not as empty output', () => {
    // Silently returning "" deletes a red run from the evidence and turns a contradiction into a pass.
    const run = resultOf({ content: JSON.stringify({ response: { exitCode: 0, result: { nested: {} } } }) });
    expect(run.understood).toBe(false);
  });
});
