import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';

const setText = vi.fn();
vi.mock('@assistant-ui/react', () => ({ useComposerRuntime: () => ({ setText }) }));

const { Welcome } = await import('./Welcome');

describe('Welcome', () => {
  test('says what the agent is for, not just hello', () => {
    render(<Welcome />);
    expect(screen.getByText(/runs the work in a sandbox/i)).toBeInTheDocument();
    expect(screen.getByText(/asks before anything irreversible/i)).toBeInTheDocument();
  });

  test('every suggestion is a button, so it is reachable by keyboard', () => {
    render(<Welcome />);
    expect(screen.getAllByRole('button')).toHaveLength(4);
  });

  test('a suggestion fills the composer with a prompt that actually works', async () => {
    // A card describing a capability teaches nothing. A card that fills the box with a working
    // prompt teaches the product in one click.
    const user = userEvent.setup();
    render(<Welcome />);
    await user.click(screen.getByRole('button', { name: /fix a failing test/i }));
    expect(setText).toHaveBeenCalledWith(expect.stringContaining('ledger-fixture'));
    expect(setText).toHaveBeenCalledWith(expect.stringContaining('Do not edit the test'));
  });

  test('a runtime that cannot take text does not blank the page', async () => {
    setText.mockImplementation(() => {
      throw new Error('no runtime');
    });
    const user = userEvent.setup();
    render(<Welcome />);
    await user.click(screen.getByRole('button', { name: /run code safely/i }));
    expect(screen.getByText(/What should it prove/i)).toBeInTheDocument();
  });

  test('a supplied heading is used', () => {
    setText.mockImplementation(() => {});
    render(<Welcome heading="Custom heading" />);
    expect(screen.getByRole('heading', { name: 'Custom heading' })).toBeInTheDocument();
  });
});
