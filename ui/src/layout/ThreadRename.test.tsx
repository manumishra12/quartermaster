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
  useAuiState: (selector: (s: unknown) => unknown) =>
    selector({ threadListItem: { remoteId: 'sess_1', id: 'local_1' } }),
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
    // A real localStorage.clear() emits an event with a null key, meaning the whole store went.
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
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
    /**
     * Private windows and blocked site data throw on write. The name still has to apply here and
     * now - it simply will not be there tomorrow. This test used to assert the opposite, which is
     * how the defect survived: the code caught the failure and then re-read from the storage that
     * had just refused it, so the rename vanished from the screen as well.
     */
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    try {
      render(<ThreadRow {...base} />);
      await userEvent.click(screen.getByRole('button', { name: /^Rename/ }));
      await userEvent.clear(screen.getByRole('textbox'));
      await userEvent.type(screen.getByRole('textbox'), 'Ledger rounding{Enter}');
      expect(screen.getByText('Ledger rounding')).toBeInTheDocument();
    } finally {
      // Restored even when the assertion fails, or every test after this one writes into a mock.
      setItem.mockRestore();
    }
  });

  test('a name given before the session is persisted follows it to its real id', () => {
    // A conversation has a local id until the harness persists it and a remote id afterwards.
    // Keyed only on the current one, a name given early was orphaned under the old id.
    window.localStorage.setItem('quartermaster.thread-titles', JSON.stringify({ local_1: 'Named early' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'quartermaster.thread-titles' }));

    render(<ThreadRow {...base} />);
    expect(screen.getByText('Named early')).toBeInTheDocument();

    const stored = JSON.parse(window.localStorage.getItem('quartermaster.thread-titles') ?? '{}');
    expect(stored).toEqual({ sess_1: 'Named early' });
  });

  test('another tab renaming a different conversation is not overwritten', async () => {
    /**
     * Each tab held a whole map. Writing ours back erased theirs, and their storage event then
     * erased ours - last writer wins, silently, on a change neither person made. Only the one
     * conversation being renamed here is ours to decide, so the write merges onto what is on disk.
     */
    render(<ThreadRow {...base} />);

    // Another tab names a different conversation while this row is open.
    window.localStorage.setItem(
      'quartermaster.thread-titles',
      JSON.stringify({ sess_other: 'Named in the other tab' }),
    );

    await userEvent.click(screen.getByRole('button', { name: /^Rename/ }));
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), 'Ledger rounding{Enter}');

    const stored = JSON.parse(window.localStorage.getItem('quartermaster.thread-titles') ?? '{}');
    expect(stored).toEqual({ sess_other: 'Named in the other tab', sess_1: 'Ledger rounding' });
  });

  test('a stale flag from an abandoned edit does not eat the next rename', async () => {
    // Escape sets a flag so the blur that follows does not save. If that blur never arrives, the
    // flag was still set next time and silently threw away a rename the person did want.
    render(<ThreadRow {...base} />);
    await userEvent.click(screen.getByRole('button', { name: /^Rename/ }));
    await userEvent.type(screen.getByRole('textbox'), '{Escape}');

    await userEvent.click(screen.getByRole('button', { name: /^Rename/ }));
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.type(screen.getByRole('textbox'), 'Ledger rounding');
    await userEvent.tab();
    expect(screen.getByText('Ledger rounding')).toBeInTheDocument();
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
