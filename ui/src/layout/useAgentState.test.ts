import { describe, expect, test } from 'vitest';
import { commandOf } from './useAgentState';

/**
 * These cover the shape the harness actually produces, read from the runtime adapter:
 * a tool-call part is { type, toolCallId, toolName, argsText, args, result? } and `result` is the
 * raw `tool.response.content` string.
 *
 * That shape was a guess for a while, and the panel that depended on it could never have worked.
 */
describe('commandOf', () => {
  test('reads the command from parsed args', () => {
    expect(commandOf({ command: 'python3 -m unittest' })).toBe('python3 -m unittest');
  });

  test('reads the command from an args string, as the part carries it', () => {
    expect(commandOf('{"command":"npm test","cwd":"/work"}')).toBe('npm test');
  });

  test('accepts the alternative keys different servers use', () => {
    expect(commandOf({ cmd: 'go test ./...' })).toBe('go test ./...');
    expect(commandOf({ script: 'pytest -q' })).toBe('pytest -q');
  });

  test('falls back to the tool name when there is no command', () => {
    expect(commandOf({ query: 'anything' }, 'web_search_exa')).toBe('web_search_exa');
  });

  test('an empty command is not a command', () => {
    expect(commandOf({ command: '' }, 'exec')).toBe('exec');
  });

  test('unparseable args do not throw', () => {
    expect(commandOf('not json at all', 'exec')).toBe('exec');
    expect(commandOf(undefined)).toBeNull();
  });
});
