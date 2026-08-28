import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { SHORTCUTS, useShortcuts } from './useShortcuts';

function Harness(handlers: Parameters<typeof useShortcuts>[0]) {
  useShortcuts(handlers);
  return (
    <>
      <input aria-label="a field" />
      <textarea aria-label="the composer" />
    </>
  );
}

describe('keyboard shortcuts', () => {
  test('the bare keys fire outside a field', () => {
    const focusComposer = vi.fn();
    const showHelp = vi.fn();
    render(<Harness focusComposer={focusComposer} showHelp={showHelp} />);

    fireEvent.keyDown(document.body, { key: '/' });
    expect(focusComposer).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document.body, { key: '?' });
    expect(showHelp).toHaveBeenCalledTimes(1);
  });

  test('and never eat a character somebody is typing', () => {
    /**
     * `/` and `?` are ordinary characters in a prompt. A composer that swallowed them would be
     * worse than having no shortcuts at all, because the failure is silent - the key simply does
     * not appear and nobody knows why.
     */
    const focusComposer = vi.fn();
    const showHelp = vi.fn();
    const { getByLabelText } = render(<Harness focusComposer={focusComposer} showHelp={showHelp} />);

    for (const field of [getByLabelText('a field'), getByLabelText('the composer')]) {
      fireEvent.keyDown(field, { key: '/' });
      fireEvent.keyDown(field, { key: '?' });
    }
    expect(focusComposer).not.toHaveBeenCalled();
    expect(showHelp).not.toHaveBeenCalled();
  });

  test('but a meta combination still works in a field, because it is not text', () => {
    const openSearch = vi.fn();
    const { getByLabelText } = render(<Harness openSearch={openSearch} />);

    fireEvent.keyDown(getByLabelText('the composer'), { key: 'k', metaKey: true });
    expect(openSearch).toHaveBeenCalledTimes(1);

    // Ctrl for the same reason, so this is not a Mac-only product.
    fireEvent.keyDown(getByLabelText('the composer'), { key: 'K', ctrlKey: true });
    expect(openSearch).toHaveBeenCalledTimes(2);
  });

  test('nothing approves or denies', () => {
    /**
     * The point of the whole file. A single keystroke that authorises an irreversible write is the
     * failure the gate exists to prevent - an approval given before the person has read what they
     * are approving. Deny is unbound too: a reflex that denies is still a reflex, and the asymmetry
     * would train the hand.
     */
    const handlers = { focusComposer: vi.fn(), toggleSidebar: vi.fn(), openSearch: vi.fn(), showHelp: vi.fn() };
    render(<Harness {...handlers} />);

    for (const key of ['a', 'd', 'y', 'n', 'Enter', 'A', 'D']) {
      fireEvent.keyDown(document.body, { key });
      fireEvent.keyDown(document.body, { key, metaKey: true });
    }
    for (const fn of Object.values(handlers)) expect(fn).not.toHaveBeenCalled();

    // And the published list does not offer one either.
    const listed = SHORTCUTS.map((s) => s.label.toLowerCase()).join(' ');
    expect(listed).not.toMatch(/\b(allow|approve|deny|reject)\b/);
  });

  test('the listener survives a caller that rebuilds its handlers every render', () => {
    // An inline object literal is a new identity each time, and with it in the dependency array
    // the listener is torn down and rebuilt on every render the page causes.
    const focusComposer = vi.fn();
    const { rerender } = render(<Harness focusComposer={focusComposer} />);
    for (let i = 0; i < 5; i += 1) rerender(<Harness focusComposer={focusComposer} />);

    fireEvent.keyDown(document.body, { key: '/' });
    expect(focusComposer).toHaveBeenCalledTimes(1);
  });
});
