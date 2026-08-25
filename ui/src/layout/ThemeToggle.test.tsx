import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { ThemeToggle } from './ThemeToggle';

/**
 * Real radios in a fieldset, so the control is keyboard navigable and announced as a group without
 * any ARIA of our own. A div-based toggle would look identical and be unusable without a mouse.
 */
describe('ThemeToggle', () => {
  test('offers all three states, including following the system', () => {
    render(<ThemeToggle mode="system" onChange={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'Light' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Auto' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeInTheDocument();
  });

  test('the current mode is the checked radio, not just a styled one', () => {
    render(<ThemeToggle mode="dark" onChange={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Light' })).not.toBeChecked();
  });

  test('the group is labelled for screen readers', () => {
    render(<ThemeToggle mode="system" onChange={vi.fn()} />);
    expect(screen.getByRole('group', { name: /colour theme/i })).toBeInTheDocument();
  });

  test('choosing a mode reports it', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ThemeToggle mode="system" onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: 'Light' }));
    expect(onChange).toHaveBeenCalledWith('light');
  });

  test('it is reachable and operable by keyboard alone', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ThemeToggle mode="light" onChange={onChange} />);
    await user.tab();
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalled();
  });
});
