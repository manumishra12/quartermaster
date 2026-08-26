import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { AgentStepsCard, ReasoningCard } from './Steps';

const THINKING = [
  'Okay, the user asked "how are you". Let me think about the best response.',
  'First, I need to respond naturally. Since I am an AI, I do not have feelings.',
  'The user is just greeting me, so no tool calls are needed here.',
].join('\n\n');

/**
 * These exist because the defaults gave the agent's working more of the screen than the answer:
 * a one-line greeting arrived underneath eight lines of expanded reasoning. Collapsing it is only
 * correct if nothing is lost, so both halves are tested - the summary that shows, and the content
 * that is still one click away.
 */
describe('ReasoningCard', () => {
  test('starts collapsed, and says what is behind it', () => {
    render(<ReasoningCard content={THINKING} />);
    expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument();
    // The first sentence, as a preview - not the whole of it.
    expect(screen.getByText(/Okay, the user asked/)).toBeInTheDocument();
    expect(screen.queryByText(/no tool calls are needed/)).not.toBeInTheDocument();
  });

  test('a click opens it and nothing has been thrown away', async () => {
    render(<ReasoningCard content={THINKING} />);
    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument();
    expect(screen.getByText(/no tool calls are needed/)).toBeInTheDocument();
  });

  test('while it is still thinking the newest line shows, not the oldest', () => {
    // A preview frozen on the first sentence makes a running agent look stuck.
    render(<ReasoningCard content={THINKING} isStreaming />);
    expect(screen.getByText(/no tool calls are needed/)).toBeInTheDocument();
    expect(screen.getByText('thinking')).toBeInTheDocument();
  });

  test('the parent keeps control when it asks for it', async () => {
    const onToggle = vi.fn();
    render(<ReasoningCard content={THINKING} expanded onToggle={onToggle} />);
    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  test('the control names itself for a screen reader', () => {
    render(<ReasoningCard content={THINKING} />);
    // Truncated preview text is not an accessible name; the label has to stand on its own.
    expect(screen.getByRole('button', { name: /reasoning, \d+ words\. expand\./i })).toBeInTheDocument();
  });

  test('empty reasoning does not render an empty preview', () => {
    render(<ReasoningCard content="" />);
    expect(screen.getByRole('button', { name: /reasoning, 0 words/i })).toBeInTheDocument();
  });
});

describe('AgentStepsCard', () => {
  test('counts read as English, singular and plural', () => {
    const { rerender } = render(
      <AgentStepsCard toolCount={1} thinkingCount={1} expanded={false} onToggle={vi.fn()}>
        <div />
      </AgentStepsCard>,
    );
    expect(screen.getByText('1 tool call · 1 thought')).toBeInTheDocument();

    rerender(
      <AgentStepsCard toolCount={3} thinkingCount={2} expanded={false} onToggle={vi.fn()}>
        <div />
      </AgentStepsCard>,
    );
    expect(screen.getByText('3 tool calls · 2 thoughts')).toBeInTheDocument();
  });

  test('a turn that called no tools loses the card, not the information', () => {
    // This is most of what made a greeting feel padded: a bordered box announcing that nothing
    // happened. The line stays; the box goes.
    const { container } = render(
      <AgentStepsCard toolCount={0} thinkingCount={1} expanded={false} onToggle={vi.fn()}>
        <div />
      </AgentStepsCard>,
    );
    expect(container.querySelector('.qm-steps')).toHaveClass('is-quiet');
    expect(screen.getByText('1 thought')).toBeInTheDocument();
  });

  test('a running turn keeps its card and says it is working', () => {
    const { container } = render(
      <AgentStepsCard toolCount={0} thinkingCount={1} expanded={false} active onToggle={vi.fn()}>
        <div />
      </AgentStepsCard>,
    );
    expect(container.querySelector('.qm-steps')).not.toHaveClass('is-quiet');
    expect(screen.getByText('Working')).toBeInTheDocument();
  });

  test('children are rendered only when it is open', () => {
    const { rerender } = render(
      <AgentStepsCard toolCount={2} thinkingCount={0} expanded={false} onToggle={vi.fn()}>
        <p>the steps themselves</p>
      </AgentStepsCard>,
    );
    expect(screen.queryByText('the steps themselves')).not.toBeInTheDocument();

    rerender(
      <AgentStepsCard toolCount={2} thinkingCount={0} expanded onToggle={vi.fn()}>
        <p>the steps themselves</p>
      </AgentStepsCard>,
    );
    expect(screen.getByText('the steps themselves')).toBeInTheDocument();
  });
});
