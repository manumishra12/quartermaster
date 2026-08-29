// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const state = { executions: [] as unknown[], finalText: '' };
vi.mock('./useAgentState', () => ({ useAgentState: () => state }));

const { EvidenceReport } = await import('./EvidenceReport');

describe('the evidence report panel', () => {
  it('renders the report rather than throwing the whole interface away', () => {
    /**
     * `buildReport` returns `{ json, markdown }` and this rendered the object as a React child,
     * which throws "Objects are not valid as a React child" - at render, so the panel's own
     * try/catch could not see it, and the app's single top-level error boundary replaced the
     * entire interface with the error screen. The button that did it is the one the demo
     * walkthrough points at, and no test had ever opened this panel, so the suite stayed green.
     */
    state.executions = [{ command: 'python3 -m unittest -v', output: 'OK\n', exitCode: 0, toolName: 'exec' }];
    state.finalText = 'The tests pass.';

    render(<EvidenceReport agent="quartermaster-local" onClose={() => {}} />);
    expect(screen.getByText(/python3 -m unittest -v/)).toBeInTheDocument();
  });

  it('is the CLI report, not a second rendering of the same judgement', () => {
    /**
     * The whole argument for this panel: it calls the function that writes the file, so the two
     * cannot disagree. If it ever renders something `buildReport` did not produce, that argument
     * is gone.
     */
    state.executions = [{ command: 'pytest -q', output: '1 failed\n', exitCode: 1, toolName: 'exec' }];
    state.finalText = 'The tests pass.';

    render(<EvidenceReport agent="quartermaster-local" onClose={() => {}} />);
    // The verdict the CLI would write for a passing claim over a failing run.
    expect(document.body.textContent).toMatch(/CONTRADICTED/i);
  });
});
