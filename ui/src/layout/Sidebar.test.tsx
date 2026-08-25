import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The reach panel is read from the live agent spec on purpose. A hand-written list of what an
 * agent can touch is a comment, and comments go stale silently - which for this panel would mean
 * telling someone a write is gated when it is not.
 */
let spec: unknown = {};

vi.mock('@truefoundry/trueforge-ui', () => ({
  ThreadListContainer: () => <div data-testid="thread-list" />,
}));
// The real hook returns { agentSpec, isSpecLoading, updateAgentSpec, ... }, not the spec. These
// tests used to mock it as the spec itself, which is exactly how the component came to read the
// wrapper and render an empty panel: the test agreed with the bug.
vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryAgentSpec: () => ({ agentSpec: spec, isSpecLoading: false, isSpecSyncing: false, specError: null }),
}));

const { Sidebar } = await import('./Sidebar');

const renderSidebar = () => render(<Sidebar mode="system" resolved="dark" onThemeChange={vi.fn()} />);

beforeEach(() => {
  spec = {};
});

describe('Sidebar', () => {
  test('names the product with a top-level heading', () => {
    renderSidebar();
    expect(screen.getByRole('heading', { level: 1, name: 'Quartermaster' })).toBeInTheDocument();
  });

  test('groups the conversation list under its own heading', () => {
    renderSidebar();
    expect(screen.getByRole('heading', { level: 2, name: 'Conversations' })).toBeInTheDocument();
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
