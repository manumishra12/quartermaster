import { act, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The reach panel is read from the live agent spec on purpose. A hand-written list of what an
 * agent can touch is a comment, and comments go stale silently - which for this panel would mean
 * telling someone a write is gated when it is not.
 */
let spec: unknown = {};
let isSpecLoading = false;
let specError: unknown = null;

let capabilities: unknown = { sandbox: { enabled: true } };

vi.mock('@truefoundry/trueforge-ui', () => ({
  ThreadListContainer: () => <div data-testid="thread-list" />,
  useServerCapabilities: () => capabilities,
}));
// The real hook returns { agentSpec, isSpecLoading, updateAgentSpec, ... }, not the spec. These
// tests used to mock it as the spec itself, which is exactly how the component came to read the
// wrapper and render an empty panel: the test agreed with the bug.
vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryAgentSpec: () => ({ agentSpec: spec, isSpecLoading, isSpecSyncing: false, specError }),
}));

const { Sidebar } = await import('./Sidebar');

const renderSidebar = () => render(<Sidebar mode="system" resolved="dark" onThemeChange={vi.fn()} />);

beforeEach(() => {
  spec = {};
  isSpecLoading = false;
  specError = null;
});

describe('Sidebar', () => {
  test('names the product with a top-level heading', () => {
    renderSidebar();
    expect(screen.getByRole('heading', { level: 1, name: 'Quartermaster' })).toBeInTheDocument();
  });

  test('renders the conversation list', () => {
    // The heading and the count moved into the ThreadListShell override, so they belong to the
    // list rather than to the sidebar - one owner for one thing.
    renderSidebar();
    expect(screen.getByTestId('thread-list')).toBeInTheDocument();
  });

  test('an agent with nothing attached says so rather than showing an empty box', () => {
    renderSidebar();
    expect(screen.getByText('Nothing yet.')).toBeInTheDocument();
  });

  test('lists the sandbox when the agent has one', () => {
    spec = { config: { sandbox: { enabled: true } } };
    renderSidebar();
    expect(screen.getByText('Sandbox')).toBeInTheDocument();
    expect(screen.getByText('isolated')).toBeInTheDocument();
  });

  test('shows each connector with the gate standing in front of it', () => {
    spec = {
      mcp_servers: [
        { name: 'github', require_approval_for_tools: ['@write', '@destructive'] },
        { name: 'exa', require_approval_for_tools: ['@write', '@destructive'] },
      ],
    };
    renderSidebar();
    expect(screen.getByText('github')).toBeInTheDocument();
    expect(screen.getAllByText('writes gated')).toHaveLength(2);
  });

  test('a policy of @all reads as everything gated', () => {
    spec = { mcp_servers: [{ name: 'github', require_approval_for_tools: ['@all'] }] };
    renderSidebar();
    expect(screen.getByText('all gated')).toBeInTheDocument();
  });

  test('an empty policy is called out as ungated, in the failure colour', () => {
    // The dangerous case: a connector attached with the gate switched off. Saying nothing here
    // would be the interface hiding exactly what it exists to surface.
    spec = { mcp_servers: [{ name: 'github', require_approval_for_tools: [] }] };
    renderSidebar();
    const row = screen.getByText('github').closest('li');
    expect(within(row!).getByText('ungated')).toBeInTheDocument();
    expect(within(row!).getByText('ungated').className).toMatch(/text-failed/);
  });

  test('a connector with no policy shows the harness default, not "ungated"', () => {
    spec = { mcp_servers: [{ name: 'linear' }] };
    renderSidebar();
    expect(screen.getByText('writes gated')).toBeInTheDocument();
  });

  test('shows which model is running the agent', () => {
    spec = { model: { name: 'anthropic/claude-sonnet-4-6' } };
    renderSidebar();
    expect(screen.getByText('anthropic/claude-sonnet-4-6')).toBeInTheDocument();
  });
});

describe('not knowing is not the same as nothing', () => {
  test('while the spec is loading it says so, rather than reporting no reach', () => {
    // Both of these used to render "Nothing yet." - the same words as a genuinely unattached
    // agent, on the panel whose only job is disclosing what this agent can touch.
    spec = null;
    isSpecLoading = true;
    renderSidebar();
    expect(screen.getByText(/Reading the agent definition/i)).toBeInTheDocument();
    expect(screen.queryByText('Nothing yet.')).not.toBeInTheDocument();
  });

  test('a failure to read the spec says the reach is unknown, and says not to assume', () => {
    spec = null;
    specError = new Error('network');
    renderSidebar();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/what it can reach is unknown/i);
    expect(alert).toHaveTextContent(/do not assume this means nothing/i);
    expect(screen.queryByText('Nothing yet.')).not.toBeInTheDocument();
  });

  test('a genuinely unattached agent still says nothing yet', () => {
    renderSidebar();
    expect(screen.getByText('Nothing yet.')).toBeInTheDocument();
  });
});

describe('the connectivity claim is not hardcoded', () => {
  test('says connected only when the server actually answered', async () => {
    const { FooterLinks } = await import('./Sidebar');
    capabilities = { sandbox: { enabled: true } };
    render(<FooterLinks />);
    expect(screen.getByText('harness connected')).toBeInTheDocument();
  });

  test('says it is not answering once it has actually waited', async () => {
    // It used to render a green dot and "harness connected" unconditionally, including while the
    // harness was down - and on a narrow screen that is the only connectivity statement visible.
    vi.useFakeTimers();
    try {
      const { FooterLinks } = await import('./Sidebar');
      capabilities = null;
      render(<FooterLinks />);

      /**
       * Null means two things - still loading, and failed - and the SDK offers nothing to tell
       * them apart. Reading it as failure meant every fresh page load accused a running harness of
       * being down for as long as the first request took. Saying a working server is broken is a
       * worse error than saying nothing yet, and it is the one somebody sees first.
       */
      expect(screen.getByText('checking harness')).toBeInTheDocument();
      expect(screen.queryByText('harness not answering')).not.toBeInTheDocument();

      act(() => void vi.advanceTimersByTime(2500));
      expect(screen.getByText('harness not answering')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('finding the keyboard', () => {
  test('the sidebar offers the shortcuts, because a key nobody knows is not an affordance', async () => {
    /**
     * `?` opens the list, which only helps somebody who already knows to press it. The reference
     * design puts Shortcuts in the sidebar for the same reason.
     */
    const { FooterLinks } = await import('./Sidebar');
    const onShowShortcuts = vi.fn();
    render(<FooterLinks onShowShortcuts={onShowShortcuts} />);
    screen.getByRole('button', { name: 'Shortcuts' }).click();
    expect(onShowShortcuts).toHaveBeenCalledTimes(1);
  });

  test('and stays out of the way where nothing can open them', async () => {
    // Rendered without the handler - as the tests for the rest of this footer do - it must not
    // offer a control that does nothing.
    const { FooterLinks } = await import('./Sidebar');
    render(<FooterLinks />);
    expect(screen.queryByRole('button', { name: 'Shortcuts' })).not.toBeInTheDocument();
  });
});
