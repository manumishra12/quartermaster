import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

let busy = false;
let sandboxId: string | undefined;
const cancel = vi.fn(async () => {});

vi.mock('@truefoundry/trueforge-ui', () => ({ useComposerBusyState: () => busy }));
vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryCancel: () => cancel,
  useTrueFoundrySandboxId: () => sandboxId,
}));

const { Topbar } = await import('./Topbar');

beforeEach(() => {
  busy = false;
  sandboxId = undefined;
  cancel.mockClear();
});

describe('Topbar', () => {
  test('names the agent that is actually running', () => {
    render(<Topbar agentName="quartermaster-local" />);
    expect(screen.getByText('quartermaster-local')).toBeInTheDocument();
  });

  test('is idle, and offers nothing to stop, when nothing is running', () => {
    render(<Topbar agentName="quartermaster" />);
    expect(screen.getByText('Idle')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
  });

  test('offers Stop while the agent is running', () => {
    // An agent you cannot interrupt is one you have to trust completely.
    busy = true;
    render(<Topbar agentName="quartermaster" />);
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  test('Stop actually cancels the turn', async () => {
    busy = true;
    const user = userEvent.setup();
    render(<Topbar agentName="quartermaster" />);
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  test('Stop cannot be double-fired while it is in flight', async () => {
    busy = true;
    let release: () => void = () => {};
    cancel.mockImplementation(() => new Promise<void>((r) => (release = r)));
    const user = userEvent.setup();
    render(<Topbar agentName="quartermaster" />);

    await user.click(screen.getByRole('button', { name: 'Stop' }));
    const button = screen.getByRole('button', { name: /stopping/i });
    expect(button).toBeDisabled();

    // Resolving inside act so the resulting state update is flushed here rather than escaping the
    // test and being reported as an unwrapped update.
    await act(async () => {
      release();
    });
  });

  test('a live sandbox is shown as a fact, not inferred from activity', () => {
    sandboxId = 'v1:local:/tmp/sandbox';
    render(<Topbar agentName="quartermaster" />);
    expect(screen.getByText('sandbox')).toBeInTheDocument();
  });

  test('no sandbox badge when none has been provisioned', () => {
    render(<Topbar agentName="quartermaster" />);
    expect(screen.queryByText('sandbox')).not.toBeInTheDocument();
  });
});
