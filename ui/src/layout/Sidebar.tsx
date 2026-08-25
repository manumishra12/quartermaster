import { ThreadListContainer } from '@truefoundry/trueforge-ui';
import { useTrueFoundryAgentSpec } from '@truefoundry/assistant-ui-runtime';
import { ThemeToggle } from './ThemeToggle';
import type { ThemeMode } from './useTheme';
import { DotIcon } from './icons';

/**
 * The sidebar carries the one question this product exists to answer before anything else:
 * what is this agent allowed to touch?
 *
 * Most chat sidebars are a list of past conversations and nothing more. Here the list is the least
 * important thing in the column - what matters is the standing reach of the agent you are about to
 * let act, visible without opening a settings page.
 */
export function Sidebar({ mode, onThemeChange }: { mode: ThemeMode; onThemeChange: (m: ThemeMode) => void }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SidebarHeader mode={mode} onThemeChange={onThemeChange} />

      <div className="flex min-h-0 flex-1 flex-col">
        <h2 className="px-5 pb-2 pt-4 text-2xs font-semibold uppercase tracking-[0.09em] text-muted">
          Conversations
        </h2>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ThreadListContainer />
        </div>
      </div>

      <Reach />
    </div>
  );
}

export function SidebarHeader({ mode, onThemeChange }: { mode: ThemeMode; onThemeChange: (m: ThemeMode) => void }) {
  return (
    <header className="flex items-center gap-2.5 border-b border-line-soft px-5 py-4">
      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line-soft bg-surface">
        <img src="/mark.svg" alt="" width={18} height={18} />
      </span>
      <div className="min-w-0 flex-1">
        <h1 className="text-base font-semibold leading-tight tracking-[-0.01em]">Quartermaster</h1>
        <p className="text-2xs text-muted">proves it, then asks</p>
      </div>
      <ThemeToggle mode={mode} onChange={onThemeChange} />
    </header>
  );
}

type Server = {
  name?: string;
  require_approval_for_tools?: string[];
  requireApprovalForTools?: string[];
};

type SpecShape = {
  model?: { name?: string };
  mcp_servers?: Server[];
  mcpServers?: Server[];
  config?: { sandbox?: { enabled?: boolean } };
};

/**
 * The agent's standing reach: its model, whether it has a sandbox, and every system it can touch
 * with the gate that stands in front of each one.
 *
 * Read from the live agent spec rather than written by hand, so it cannot drift from what the
 * agent is actually configured to do. A hand-written list of what an agent can reach is a comment,
 * and comments go stale silently.
 */
function Reach() {
  /**
   * The hook returns a wrapper - { agentSpec, isSpecLoading, updateAgentSpec, ... } - not the spec.
   * This read the wrapper directly and looked for snake_case fields the runtime does not use, so
   * the panel was permanently empty: it told every viewer the agent could reach nothing, which for
   * a panel whose whole job is disclosing reach is the worst way to be wrong.
   *
   * Both casings are accepted because the runtime uses camelCase while the JSON specs on disk and
   * the HTTP API use snake_case, and this panel is fed from whichever the SDK hands over.
   */
  const { agentSpec } = (useTrueFoundryAgentSpec() ?? {}) as { agentSpec?: SpecShape | null };
  const spec = agentSpec ?? undefined;
  const servers: Server[] = spec?.mcpServers ?? spec?.mcp_servers ?? [];
  const model = spec?.model?.name;
  const sandbox = spec?.config?.sandbox?.enabled;

  return (
    <section className="border-t border-line-soft px-5 py-4" aria-labelledby="reach-heading">
      <h2 id="reach-heading" className="mb-3 text-2xs font-semibold uppercase tracking-[0.09em] text-muted">
        Can reach
      </h2>

      <ul className="grid gap-2">
        {sandbox && (
          <Row label="Sandbox" note="isolated" />
        )}
        {servers.length === 0 && !sandbox && <li className="text-sm text-muted">Nothing yet.</li>}
        {servers.map((server) => {
          const gate = server.require_approval_for_tools ?? server.requireApprovalForTools ?? ['@write', '@destructive'];
          const gated = gate.includes('@all') ? 'all gated' : gate.length > 0 ? 'writes gated' : 'ungated';
          return <Row key={server.name} label={server.name ?? 'connector'} note={gated} warn={gate.length === 0} />;
        })}
      </ul>

      {model && (
        <p className="mt-3 truncate font-mono text-2xs text-muted/70" title={model}>
          {model}
        </p>
      )}
    </section>
  );
}

function Row({ label, note, warn = false }: { label: string; note: string; warn?: boolean }) {
  return (
    <li className="flex items-center justify-between gap-2.5 text-sm">
      <span className="flex min-w-0 items-center gap-2.5">
        <span className={warn ? 'text-failed' : 'text-muted/50'}>
          <DotIcon />
        </span>
        <span className="truncate text-ink">{label}</span>
      </span>
      <span className={['shrink-0 text-2xs', warn ? 'text-failed' : 'text-muted'].join(' ')}>{note}</span>
    </li>
  );
}
