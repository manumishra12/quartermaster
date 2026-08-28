import { describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const initialize = vi.fn();
const renderDiagram = vi.fn(async () => ({ svg: '<iframe sandbox="allow-scripts" srcdoc="..."></iframe>' }));

vi.mock('mermaid', () => ({ default: { initialize, render: renderDiagram } }));
vi.mock('./useTheme', () => ({ useTheme: () => ({ resolved: 'dark', mode: 'system', choose: vi.fn() }) }));

const { Mermaid } = await import('./Mermaid');

describe('rendering a diagram the model wrote', () => {
  test('it is sandboxed, not merely sanitised', async () => {
    /**
     * This is the security decision in this file and it is worth pinning rather than trusting a
     * comment. The component puts model-written text into the page through
     * `dangerouslySetInnerHTML`, and the model reads issue bodies, repository files and web pages -
     * which this repository spends a whole fixture demonstrating can persuade it.
     *
     * `strict` relies on mermaid's DOMPurify, which resolves to 3.4.8 and carries four open
     * advisories including an XSS through a detached subtree. `sandbox` renders into an iframe, so
     * a bypass executes somewhere that cannot reach this page.
     */
    render(<Mermaid code="flowchart LR\n  A --> B" />);
    await waitFor(() => expect(initialize).toHaveBeenCalled());

    const config = initialize.mock.calls.at(-1)?.[0];
    expect(config.securityLevel).toBe('sandbox');
    expect(config.startOnLoad).toBe(false);
  });

  test('a diagram that will not parse shows its source rather than vanishing', async () => {
    // The model wrote something, and somebody deciding whether to trust this agent needs to see
    // what. Swallowing it would report a diagram nobody can find.
    renderDiagram.mockRejectedValueOnce(new Error('Parse error on line 2'));
    render(<Mermaid code="flowchart LR\n  A -->" />);

    await waitFor(() => expect(screen.getByText(/did not parse/i)).toBeInTheDocument());
    expect(screen.getByText(/Parse error on line 2/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /diagram source/i })).toHaveAttribute('tabindex', '0');
  });
});
