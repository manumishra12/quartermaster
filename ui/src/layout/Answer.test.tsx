import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Answer } from './Answer';

/** The SDK's markdown renderer, stubbed at the boundary as it is elsewhere in these tests. */
vi.mock('@truefoundry/trueforge-ui', () => ({
  Markdown: ({ content }: { content: string }) => <div data-testid="sdk-markdown">{content}</div>,
}));

/** What a model that cannot use tools emits instead of failing. Taken from a real run. */
const PRINTED = `{
  "name": "exec",
  "arguments": {
    "command": "python3 -c \\"import sys; print(sys.version)\\"",
    "cwd": "/opt/tf/sandbox",
    "intent": "Check the Python version"
  }
}`;

describe('an answer that is a tool call', () => {
  test('is named rather than dumped as braces', () => {
    /**
     * Rendered as prose this is unreadable, and worse than unreadable: it looks like a question the
     * agent is asking, and nothing is listening for an answer because the call was never made.
     */
    render(<Answer content={PRINTED} />);
    expect(screen.getByText(/written out, not called/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing ran and nothing is waiting/i)).toBeInTheDocument();
    expect(screen.queryByTestId('sdk-markdown')).not.toBeInTheDocument();
  });

  test('and says which call it wanted, in words', () => {
    render(<Answer content={PRINTED} />);
    // The rendering is the CLI's, imported rather than reimplemented, so the two surfaces cannot
    // describe the same event differently.
    // Scoped to the rendered list: the raw text below also contains the word.
    const named = [...document.querySelectorAll('li')].map((li) => li.textContent).join(' ');
    expect(named).toMatch(/exec/);
  });

  test('the raw text is kept for whoever is debugging the model', () => {
    render(<Answer content={PRINTED} />);
    expect(screen.getByText(/what it actually emitted/i)).toBeInTheDocument();
  });
});

describe('an ordinary answer', () => {
  test('goes to the SDK untouched', () => {
    const prose = 'The suite passes: 3 passed in 0.4s.';
    render(<Answer content={prose} />);
    expect(screen.getByTestId('sdk-markdown')).toHaveTextContent(prose);
    expect(screen.queryByText(/written out, not called/i)).not.toBeInTheDocument();
  });

  test('and so does prose that merely mentions JSON', () => {
    const prose = 'I would call exec with { "command": "ls" } but the sandbox is not ready.';
    render(<Answer content={prose} />);
    expect(screen.getByTestId('sdk-markdown')).toBeInTheDocument();
  });
});

test('nothing is intercepted while the answer is still arriving', () => {
  /**
   * A half-streamed JSON object looks exactly like a printed call, and flashing this banner at
   * somebody mid-sentence would be its own kind of wrong.
   */
  render(<Answer content={PRINTED} isStreaming />);
  expect(screen.getByTestId('sdk-markdown')).toBeInTheDocument();
  expect(screen.queryByText(/written out, not called/i)).not.toBeInTheDocument();
});
