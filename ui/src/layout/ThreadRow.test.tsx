import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { ThreadList, ThreadRow } from './ThreadRow';

describe('ThreadRow', () => {
  const base = { title: 'Fix the ledger test', active: false, onSelect: vi.fn() };

  test('the title carries the row and the agent is secondary', () => {
    render(<ThreadRow {...base} agentName="quartermaster-local" />);
    expect(screen.getByText('Fix the ledger test')).toBeInTheDocument();
    expect(screen.getByText('quartermaster-local')).toBeInTheDocument();
  });

  test('selecting a conversation reports it', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<ThreadRow {...base} onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: /fix the ledger test/i }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  test('the active row is marked for assistive technology, not only in colour', () => {
    render(<ThreadRow {...base} active />);
    expect(screen.getByRole('button', { name: /fix the ledger test/i })).toHaveAttribute('aria-current', 'true');
  });

  test('time is relative for scanning but exact on inspection', () => {
    const when = new Date(Date.now() - 3 * 60 * 60 * 1000);
    render(<ThreadRow {...base} lastMessageAt={when} />);
    const time = screen.getByText('3h');
    expect(time).toHaveAttribute('dateTime', when.toISOString());
    expect(time).toHaveAttribute('title', when.toLocaleString());
  });

  test('relative time reads sensibly across the ranges', () => {
    const cases: Array<[number, string]> = [
      [30 * 1000, 'now'],
      [5 * 60 * 1000, '5m'],
      [2 * 60 * 60 * 1000, '2h'],
      [3 * 24 * 60 * 60 * 1000, '3d'],
      [21 * 24 * 60 * 60 * 1000, '3w'],
    ];
    for (const [agoMs, expected] of cases) {
      const { unmount } = render(<ThreadRow {...base} lastMessageAt={new Date(Date.now() - agoMs)} />);
      expect(screen.getByText(expected)).toBeInTheDocument();
      unmount();
    }
  });

  test('a future timestamp does not render a negative age', () => {
    render(<ThreadRow {...base} lastMessageAt={new Date(Date.now() + 60_000)} />);
    expect(screen.getByText('now')).toBeInTheDocument();
  });
});

describe('ThreadList', () => {
  test('counts the conversations, because a scrolling list hides its own size', () => {
    render(
      <ThreadList header={null}>
        <div>one</div>
        <div>two</div>
        <div>three</div>
      </ThreadList>,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Conversations' })).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  test('an empty list shows no count rather than a zero', () => {
    render(<ThreadList header={null}>{null}</ThreadList>);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });
});
