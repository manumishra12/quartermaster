import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const setText = vi.fn();
vi.mock('@assistant-ui/react', () => ({ useComposerRuntime: () => ({ setText }) }));

const { QuickActions } = await import('./QuickActions');

beforeEach(() => setText.mockReset());

describe('QuickActions', () => {
  test('stays available after the welcome screen is gone', () => {
    // The welcome cards teach the product once and disappear. The second and third things you want
    // to ask are the ones you would otherwise have to compose from nothing.
    render(<QuickActions />);
    expect(screen.getByRole('group', { name: /quick actions/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(4);
  });

  test('an action fills the composer with a prompt that works', async () => {
    const user = userEvent.setup();
    render(<QuickActions />);
    await user.click(screen.getByRole('button', { name: /fix a failing test/i }));
    expect(setText).toHaveBeenCalledWith(expect.stringContaining('ledger-fixture'));
  });

  test('focus follows the text into the composer', async () => {
    // Writing into a box the person is not looking at, while focus stays on the button, reads as
    // the button having done nothing.
    const user = userEvent.setup();
    render(
      <div>
        <QuickActions />
        <textarea aria-label="composer" />
      </div>,
    );
    await user.click(screen.getByRole('button', { name: /run code/i }));
    expect(screen.getByLabelText('composer')).toHaveFocus();
  });

  test('a runtime that cannot take text does not blank the page', async () => {
    // mockImplementationOnce rather than mockImplementation: a persistent throwing implementation
    // set after mockReset leaks into the runner's own error handling and fails the test for a
    // reason that has nothing to do with the component.
    setText.mockImplementationOnce(() => {
      throw new Error('no runtime');
    });
    const user = userEvent.setup();
    render(<QuickActions />);
    await user.click(screen.getByRole('button', { name: /query data/i }));
    expect(screen.getByRole('group', { name: /quick actions/i })).toBeInTheDocument();
  });
});
