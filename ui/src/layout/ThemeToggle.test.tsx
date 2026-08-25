import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { ThemeToggle } from './ThemeToggle';

/**
 * One button cycling three states needs its state said out loud. An icon alone leaves a
 * screen-reader user pressing a control that reports only "theme" and changes something they
 * cannot perceive.
 */
describe('ThemeToggle', () => {
  test('says which theme is active and what pressing it will do', () => {
    render(<ThemeToggle mode="light" resolved="light" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /light theme.*switch to dark/i })).toBeInTheDocument();
  });

  test('dark announces that the next press follows the system', () => {
    render(<ThemeToggle mode="dark" resolved="dark" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /switch to following your system/i })).toBeInTheDocument();
  });

  test('following the system is announced as such, not as the theme it resolved to', () => {
    render(<ThemeToggle mode="system" resolved="dark" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /following your system/i })).toBeInTheDocument();
  });

  test('cycles light to dark to system and back', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();

    const { rerender } = render(<ThemeToggle mode="light" resolved="light" onChange={onChange} />);
    await user.click(screen.getByRole('button'));
    expect(onChange).toHaveBeenLastCalledWith('dark');

    rerender(<ThemeToggle mode="dark" resolved="dark" onChange={onChange} />);
    await user.click(screen.getByRole('button'));
    expect(onChange).toHaveBeenLastCalledWith('system');

    rerender(<ThemeToggle mode="system" resolved="dark" onChange={onChange} />);
    await user.click(screen.getByRole('button'));
    expect(onChange).toHaveBeenLastCalledWith('light');
  });

  test('it is operable by keyboard alone', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ThemeToggle mode="light" resolved="light" onChange={onChange} />);
    await user.tab();
    expect(screen.getByRole('button')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('dark');
  });
});
