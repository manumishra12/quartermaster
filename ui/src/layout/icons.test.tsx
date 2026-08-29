import { describe, expect, test } from 'vitest';
import { iconForTool, DotIcon } from './icons';

/**
 * Every tool call used to render with the same dot, which wastes the one glance a person gives an
 * approval prompt before deciding. What matters at that moment is the *kind* of thing about to
 * happen, and that is legible from the name.
 */
describe('the icon for a tool', () => {
  test('an irreversible remediation reads as one, whatever else it also is', () => {
    // close_issue is a ticket and a one-way door; the door is the part that matters.
    const oneWay = iconForTool('rollback_deploy');
    expect(iconForTool('close_issue')).toBe(oneWay);
    expect(iconForTool('restart_service')).toBe(oneWay);
    expect(iconForTool('delete_file')).toBe(oneWay);
  });

  test('kinds are distinguished from each other', () => {
    const kinds = ['exec', 'create_pull_request', 'send_message', 'create_issue', 'web_search_exa'];
    const icons = kinds.map((name) => iconForTool(name));
    expect(new Set(icons).size).toBe(kinds.length);
  });

  test('something it does not recognise gets the neutral mark, not a guess', () => {
    expect(iconForTool('frobnicate')).toBe(DotIcon);
    expect(iconForTool(undefined)).toBe(DotIcon);
    expect(iconForTool('')).toBe(DotIcon);
  });
});
