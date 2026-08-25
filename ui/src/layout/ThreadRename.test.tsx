import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Renaming a conversation.
 *
 * The session id comes from the SDK's thread-list state, which only exists inside its provider.
 * That is the environment, not the behaviour under test, so it is stubbed - the assertions are all
 * about what a person sees and what survives a reload.
 */
vi.mock('@truefoundry/trueforge-ui/assistant-ui', () => ({
  useAuiState: (selector: (s: unknown) => unknown) => selector({ threadListItem: { remoteId: 'sess_1' } }),
}));

const { ThreadRow } = await import('./ThreadRow');

const base = { title: 'Fix the ledger test', active: false, onSelect: vi.fn() };

describe('renaming a conversation', () => {
  /**
   * Clearing storage directly is not something a browser does silently - it fires a storage event,
   * and the module caches its snapshot until one arrives. Announcing the clear is what a real
   * browser does, so the next test starts from an empty list rather than the previous one's name.
   */
  const reset = () => {
    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: 'quartermaster.thread-titles' }));
  };
  beforeEach(reset);
  afterEach(reset);

  test('the rename control names the conversation it renames', () => {
    render(<ThreadRow {...base} />);
    expect(screen.getByRole('button', { name: 'Rename Fix the ledger test' })).toBeInTheDocument();
  });

  test('a new name replaces the one TrueForge derived', async () => {
    render(<ThreadRow {...base} />);
    await userEvent.click(screen.getByRole('button', { name: /^Rename/ }));
    const field = screen.getByRole('textbox');
    await userEvent.clear(field);
    await userEvent.type(field, 'Ledger rounding{Enter}');
    expect(screen.getByText('Ledger rounding')).toBeInTheDocument();
    expect(screen.queryByText('Fix the ledger test')).not.toBeInTheDocument();
  });

  test('the new name outlives the component, because that is the whole point', async () => {
    const { unmount } = render(<ThreadRow {...base} />);
    await userEvent.click(screen.getByRole('button', { name: /^Rename/ }));
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), 'Ledger rounding{Enter}');
    unmount();

    render(<ThreadRow {...base} />);
    expect(screen.getByText('Ledger rounding')).toBeInTheDocument();
  });

  test('escape abandons the edit rather than saving it', async () => {
    render(<ThreadRow {...base} />);
    await userEvent.click(screen.getByRole('button', { name: /^Rename/ }));
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), 'half a thought{Escape}');
    expect(screen.getByText('Fix the ledger test')).toBeInTheDocument();
    expect(screen.queryByText('half a thought')).not.toBeInTheDocument();
  });

  test('an empty name hands the conversation back to its original title', async () => {
    render(<ThreadRow {...base} />);
    await userEvent.click(screen.getByRole('button', { name: /^Rename/ }));
    await userEvent.type(screen.getByRole('textbox'), ' mine{Enter}');
    expect(screen.getByText('Fix the ledger test mine')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Rename/ }));
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), '   {Enter}');
    expect(screen.getByText('Fix the ledger test')).toBeInTheDocument();
  });

  test('clicking away saves, because losing a typed name to a stray click is worse', async () => {
    render(<ThreadRow {...base} />);
    await userEvent.click(screen.getByRole('button', { name: /^Rename/ }));
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), 'Ledger rounding');
    await userEvent.tab();
    expect(screen.getByText('Ledger rounding')).toBeInTheDocument();
  });

  test('storage that refuses to store does not take the rename down with it', async () => {
    // Private windows and blocked site data throw on write. The name still applies to this render.
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    render(<ThreadRow {...base} />);
    await userEvent.click(screen.getByRole('button', { name: /^Rename/ }));
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), 'Ledger rounding{Enter}');
    expect(screen.getByText('Fix the ledger test')).toBeInTheDocument();
    setItem.mockRestore();
  });

  test('a stored value of the wrong type is ignored rather than rendered', () => {
    window.localStorage.setItem('quartermaster.thread-titles', JSON.stringify({ sess_1: { not: 'a string' } }));
    // Announced, or the module never reads it and this passes without exercising anything.
    window.dispatchEvent(new StorageEvent('storage', { key: 'quartermaster.thread-titles' }));
    render(<ThreadRow {...base} />);
    expect(screen.getByText('Fix the ledger test')).toBeInTheDocument();
    expect(screen.queryByText(/object Object/)).not.toBeInTheDocument();
  });
});
