import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The rail is the safety surface. These tests exist to catch two specific ways it can be wrong:
 * showing nothing because it reads the wrong field, and showing green because it reached its own
 * conclusion instead of the shared one.
 *
 * The harness hooks are mocked; the evidence rules are NOT. Those come through the real
 * `@evidence` module, so a rail that disagreed with the CLI would fail here.
 */

const state = {
  executions: [] as Array<{ toolName: string; command: string | null; output: string; exitCode: number | null }>,
  pendingApprovals: [] as Array<{ approvalId: string; toolName: string; argsText?: string }>,
  respondToApproval: vi.fn(),
  pendingQuestions: [] as Array<{ question?: string }>,
  sandboxId: undefined as string | undefined,
};

let busy = false;

vi.mock('@truefoundry/trueforge-ui', () => ({ useComposerBusyState: () => busy }));
vi.mock('./useAgentState', () => ({ useAgentState: () => state }));

const { StatusRail } = await import('./StatusRail');

const exec = (output: string, exitCode: number | null, command: string | null = 'python3 -m unittest discover -s .') => ({
  toolName: 'exec',
  command,
  output,
  exitCode,
});

const GREEN = exec('Ran 5 tests in 0.001s\n\nOK\n', 0);
const RED = exec('Ran 5 tests\n\nFAILED (failures=1)\nAssertionError: 999 != 1000', 1);

beforeEach(() => {
  state.executions = [];
  state.pendingApprovals = [];
  state.pendingQuestions = [];
  state.sandboxId = undefined;
  state.respondToApproval = vi.fn();
  busy = false;
});

describe('before anything has run', () => {
  test('says what is missing and what to try, rather than sitting blank', () => {
    render(<StatusRail />);
    expect(screen.getByText(/No test run recorded yet/i)).toBeInTheDocument();
    expect(screen.getByText(/anything the agent says about tests passing is\s+unsupported/i)).toBeInTheDocument();
    expect(screen.getByText(/Fix the failing test in ledger/i)).toBeInTheDocument();
  });

  test('reports nothing pending', () => {
    render(<StatusRail />);
    expect(screen.getByText(/It has not asked for anything/i)).toBeInTheDocument();
  });
});

describe('what it did', () => {
  test('a passing run reads as passed, in words as well as colour', () => {
    state.executions = [RED, GREEN];
    render(<StatusRail />);
    expect(screen.getByText('Last run passed')).toBeInTheDocument();
    expect(screen.getByText(/exit 0/)).toBeInTheDocument();
  });

  test('a failing run is never dressed up as a pass', () => {
    state.executions = [GREEN, RED];
    render(<StatusRail />);
    expect(screen.getByText('Last run did not pass')).toBeInTheDocument();
    expect(screen.queryByText('Last run passed')).not.toBeInTheDocument();
  });

  test('a non-zero exit contradicts output that looks green - the CLI rule, applied here', () => {
    // Real `go test` output: "ok" appears for the packages that passed, and it still exits 1.
    state.executions = [exec('ok\tacme/util\t0.01s\n--- FAIL: TestX\nFAIL', 1, 'go test ./...')];
    render(<StatusRail />);
    expect(screen.getByText('Last run did not pass')).toBeInTheDocument();
  });

  test('a command that is not a test run is counted as an execution but not as proof', () => {
    state.executions = [exec('ok\n', 0, 'echo ok')];
    render(<StatusRail />);
    expect(screen.getByText(/1 execution recorded/i)).toBeInTheDocument();
    expect(screen.getByText(/No test run recorded yet/i)).toBeInTheDocument();
  });

  test('a live sandbox is stated, not implied', () => {
    state.executions = [GREEN];
    state.sandboxId = 'v1:local:/tmp/sandbox';
    render(<StatusRail />);
    expect(screen.getByText(/sandbox live/i)).toBeInTheDocument();
  });

  test('long output is truncated with a marker and can be expanded', async () => {
    const user = userEvent.setup();
    state.executions = [exec(`${'line of output\n'.repeat(60)}Ran 60 tests in 0.4s\n\nOK`, 0)];
    render(<StatusRail />);

    const toggle = screen.getByRole('button', { name: /show more/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: /show less/i })).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('the approval gate', () => {
  const approval = {
    approvalId: 'ap_1',
    toolName: 'create_pull_request',
    argsText: '{"title":"Fix split_evenly","base":"main"}',
  };

  test('shows the tool and the actual arguments - approving blind is not consent', () => {
    state.pendingApprovals = [approval];
    render(<StatusRail />);
    expect(screen.getByText('create_pull_request')).toBeInTheDocument();
    expect(screen.getByText(/Fix split_evenly/)).toBeInTheDocument();
  });

  test('announces assertively, because the agent is stopped until someone acts', () => {
    state.pendingApprovals = [approval];
    render(<StatusRail />);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAccessibleName(/create_pull_request/);
  });

  test('Deny and Allow are both reachable as buttons', () => {
    state.pendingApprovals = [approval];
    render(<StatusRail />);
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: 'Deny' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Allow' })).toBeInTheDocument();
  });

  test('denying sends approved: false with a reason', async () => {
    const user = userEvent.setup();
    state.pendingApprovals = [approval];
    render(<StatusRail />);
    await user.click(screen.getByRole('button', { name: 'Deny' }));
    expect(state.respondToApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'ap_1', approved: false }),
    );
  });

  test('allowing sends approved: true', async () => {
    const user = userEvent.setup();
    state.pendingApprovals = [approval];
    render(<StatusRail />);
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    expect(state.respondToApproval).toHaveBeenCalledWith({ approvalId: 'ap_1', approved: true });
  });

  test('an approval outranks a pending question - it is the thing that blocks', () => {
    state.pendingApprovals = [approval];
    state.pendingQuestions = [{ question: 'Which environment?' }];
    render(<StatusRail />);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.queryByText('Which environment?')).not.toBeInTheDocument();
  });
});

describe('questions', () => {
  test('the question itself is shown, not a generic placeholder', () => {
    state.pendingQuestions = [{ question: 'Should I rewrite the failing test instead?' }];
    render(<StatusRail />);
    expect(screen.getByText('Should I rewrite the failing test instead?')).toBeInTheDocument();
  });
});

describe('progress', () => {
  test('idle before anything runs', () => {
    render(<StatusRail />);
    expect(screen.getByText('Idle')).toBeInTheDocument();
  });

  test('names the current phase while working', () => {
    busy = true;
    state.executions = [RED];
    render(<StatusRail />);
    expect(screen.getByText(/Working — Diagnose/)).toBeInTheDocument();
  });

  test('every phase is listed so the sequence is legible', () => {
    render(<StatusRail />);
    for (const phase of ['Reproduce', 'Diagnose', 'Verify', 'Report']) {
      expect(screen.getByText(phase)).toBeInTheDocument();
    }
  });
});

describe('approval gate hardening', () => {
  const approval = {
    approvalId: 'ap_1',
    toolName: 'create_pull_request',
    argsText: '{"title":"Fix split_evenly"}',
  };

  test('a second click cannot send a second response', async () => {
    // Found in review: no in-flight guard meant a double click sent two approval responses for the
    // same call, and the second one races whatever the first already set in motion.
    const user = userEvent.setup();
    state.pendingApprovals = [approval];
    render(<StatusRail />);

    const allow = screen.getByRole('button', { name: 'Allow' });
    await user.click(allow);
    // The label is provisional until the approval clears - it says Sending, not Allowed, because
    // the decision is not known to have arrived.
    await user.click(screen.getByRole('button', { name: 'Sending…' }));

    expect(state.respondToApproval).toHaveBeenCalledTimes(1);
  });

  test('both buttons disable once a decision is sent, and say which was taken', async () => {
    const user = userEvent.setup();
    state.pendingApprovals = [approval];
    render(<StatusRail />);

    await user.click(screen.getByRole('button', { name: 'Deny' }));
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
  });

  test('the pause is announced to someone whose focus is elsewhere', () => {
    state.pendingApprovals = [approval];
    render(<StatusRail />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Approval required before create_pull_request can run/i);
  });

  test('the prompt takes focus, because the agent is stopped until someone acts', () => {
    state.pendingApprovals = [approval];
    render(<StatusRail />);
    expect(screen.getByRole('alertdialog')).toHaveFocus();
  });
});

describe('progress settles', () => {
  test('the final phase stops spinning once a run has passed', () => {
    // It used to spin forever after the work finished, because the UI discarded progress().settled.
    state.executions = [RED, GREEN];
    const { container } = render(<StatusRail />);
    expect(container.querySelector('.qm-spin')).toBeNull();
  });

  test('it does keep spinning while the last run is red', () => {
    busy = true;
    state.executions = [RED];
    const { container } = render(<StatusRail />);
    expect(container.querySelector('.qm-spin')).not.toBeNull();
  });
});

describe('the approval prompt does not trap focus', () => {
  const approval = { approvalId: 'ap_1', toolName: 'create_pull_request', argsText: '{}' };

  test('focus is taken once when the prompt appears, and never taken back', async () => {
    // It used to be an inline ref callback, which React re-invokes on every commit. While an agent
    // streams that is several times a second, so focus was yanked back continuously: a keyboard
    // user could not read the arguments, reach Deny, or leave. A trap on the one surface where
    // somebody decides whether to allow something irreversible.
    function Harness() {
      const [n, setN] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setN(n + 1)}>
            bump {n}
          </button>
          <StatusRail />
        </div>
      );
    }

    state.pendingApprovals = [approval];
    const user = userEvent.setup();
    render(<Harness />);

    const bump = screen.getByRole('button', { name: /bump/i });
    bump.focus();
    await user.click(bump);

    expect(document.activeElement).toBe(bump);
  });
});


describe('a decision that cannot be delivered', () => {
  const approval = { approvalId: 'ap_1', toolName: 'create_pull_request', argsText: '{}' };

  test('a throwing respond re-enables the buttons and says nothing was sent', async () => {
    // It used to set the label to "Allowed" and disable both buttons before knowing the call
    // succeeded. A closed stream then left the operator locked out of a decision that was never
    // sent, while the rail stated it had been granted and the agent waited forever.
    state.pendingApprovals = [approval];
    state.respondToApproval = vi.fn(() => {
      throw new Error('stream closed');
    });
    const user = userEvent.setup();
    render(<StatusRail />);

    await user.click(screen.getByRole('button', { name: 'Allow' }));

    // Two alerts exist here: the standing "approval required" announcement and this failure.
    const failure = screen.getAllByRole('alert').find((n) => /stream closed/i.test(n.textContent ?? ''));
    expect(failure).toBeDefined();
    expect(failure).toHaveTextContent(/still waiting/i);
    expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled();
  });

  test('no responder at all is reported rather than silently swallowed', async () => {
    state.pendingApprovals = [approval];
    state.respondToApproval = undefined as never;
    const user = userEvent.setup();
    render(<StatusRail />);

    await user.click(screen.getByRole('button', { name: 'Deny' }));
    const failure = screen.getAllByRole('alert').find((n) => /cannot send a decision/i.test(n.textContent ?? ''));
    expect(failure).toBeDefined();
  });

  test('a new approval clears the previous decision, so the operator is not locked out', () => {
    state.pendingApprovals = [approval];
    const { rerender } = render(<StatusRail />);
    state.pendingApprovals = [{ ...approval, approvalId: 'ap_2', toolName: 'push_files' }];
    rerender(<StatusRail />);
    expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled();
  });
});

describe('the spinner is honest', () => {
  test('nothing spins once the agent has stopped, even mid-procedure', () => {
    // It used to spin forever on the current step whenever the run ended red, while the headline
    // read "Finished". Motion here means something is working.
    busy = false;
    state.executions = [RED];
    const { container } = render(<StatusRail />);
    expect(container.querySelector('.qm-spin')).toBeNull();
  });
});


describe('the recorded output can be read at full size', () => {
  test('enlarging shows the command and the whole output', async () => {
    // The evidence this product rests on was being read through a forty-line window in a 22rem
    // column. Anything with a stack trace was unreadable at the moment it mattered most.
    const user = userEvent.setup();
    state.executions = [exec('Ran 5 tests\n\nFAILED (failures=1)\nAssertionError: 999 != 1000', 1)];
    render(<StatusRail />);

    await user.click(screen.getByRole('button', { name: /enlarge/i }));

    const dialog = screen.getByRole('dialog', { name: /recorded output/i });
    expect(within(dialog).getByText(/python3 -m unittest/)).toBeInTheDocument();
    expect(within(dialog).getByText(/AssertionError: 999 != 1000/)).toBeInTheDocument();
    expect(within(dialog).getByText(/exit 1/)).toBeInTheDocument();
  });

  test('it takes focus and closes on Escape', async () => {
    const user = userEvent.setup();
    state.executions = [exec('Ran 5 tests\n\nOK', 0)];
    render(<StatusRail />);

    await user.click(screen.getByRole('button', { name: /enlarge/i }));
    expect(screen.getByRole('dialog')).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('short output can still be enlarged - there is no Show more to reach for', async () => {
    const user = userEvent.setup();
    state.executions = [exec('Ran 1 test\n\nOK', 0)];
    render(<StatusRail />);
    expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /enlarge/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
