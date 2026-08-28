import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Code } from './Code';

/** The SDK's highlighter, stubbed at the boundary so we can see what was handed back to it. */
vi.mock('@truefoundry/trueforge-ui', () => ({
  SyntaxHighlighter: ({ code, language }: { code: string; language?: string }) => (
    <div data-testid="sdk-highlighter" data-language={language}>
      {code}
    </div>
  ),
}));

/** Mermaid is loaded on demand and needs a real DOM measurement; the boundary is what matters here. */
vi.mock('./Mermaid', () => ({
  Mermaid: ({ code }: { code: string }) => <div data-testid="mermaid">{code}</div>,
}));

const PATCH = `--- a/x.py
+++ b/x.py
@@ -1,2 +1,2 @@
-old
+new`;

describe('what the code block intercepts', () => {
  test('a patch is rendered as a patch', () => {
    render(<Code code={PATCH} />);
    expect(screen.queryByTestId('sdk-highlighter')).not.toBeInTheDocument();
    expect(screen.getByText(/Patch/)).toBeInTheDocument();
  });

  test('a fence labelled mermaid is rendered as a diagram', () => {
    render(<Code code="flowchart LR\n  A --> B" language="mermaid" />);
    expect(screen.getByTestId('mermaid')).toBeInTheDocument();
    expect(screen.queryByTestId('sdk-highlighter')).not.toBeInTheDocument();
  });
});

describe('what it hands back to the SDK', () => {
  test('everything else, with its language intact', () => {
    /**
     * This is the point of overriding one slot rather than replacing the highlighter: syntax
     * colouring for every language these agents touch stays the SDK's problem, and stays whatever
     * the SDK improves it into.
     */
    for (const language of ['python', 'javascript', 'sql', 'bash', undefined]) {
      const { unmount } = render(<Code code="print(1)" language={language} />);
      const handed = screen.getByTestId('sdk-highlighter');
      expect(handed).toHaveTextContent('print(1)');
      if (language) expect(handed).toHaveAttribute('data-language', language);
      unmount();
    }
  });

  test('and mermaid-looking prose that was never labelled', () => {
    /**
     * No sniffing, deliberately. Mermaid's grammar overlaps ordinary prose enough that a guess
     * would turn a paragraph into a broken diagram, and a wrong guess costs more than a missed one.
     */
    render(<Code code="graph the results and then flowchart the process" />);
    expect(screen.getByTestId('sdk-highlighter')).toBeInTheDocument();
    expect(screen.queryByTestId('mermaid')).not.toBeInTheDocument();
  });
});
