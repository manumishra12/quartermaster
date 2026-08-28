import { useEffect, useState } from 'react';
import { ThreadListContainer, useServerCapabilities } from '@truefoundry/trueforge-ui';
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
export function Sidebar({ mode, resolved, onThemeChange }: { mode: ThemeMode; resolved: 'light' | 'dark'; onThemeChange: (m: ThemeMode) => void }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SidebarHeader mode={mode} resolved={resolved} onThemeChange={onThemeChange} />

      {/* ThreadListShell is overridden, so the heading and the count live with the list. */}
      <ThreadListContainer />

      <Reach />
    </div>
  );
}

export function SidebarHeader({
  mode,
  resolved,
  onThemeChange,
  onOpenSidebar,
}: {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  onThemeChange: (m: ThemeMode) => void;
  onOpenSidebar?: () => void;
}) {
  return (
    <header className="flex items-center gap-2.5 border-b border-line-soft px-5 py-4">
      {onOpenSidebar ? (
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label="Open conversations and what this agent can reach"
          className="qm-tap inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-line bg-surface transition-colors duration-200 hover:border-accent"
        >
          <img src="/mark.svg" alt="" width={18} height={18} />
        </button>
      ) : (
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line-soft bg-surface">
          <img src="/mark.svg" alt="" width={18} height={18} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h1 className="text-base font-[550] leading-tight tracking-[-0.01em]">Quartermaster</h1>
        <p className="text-2xs text-muted">proves it, then asks</p>
      </div>
      <ThemeToggle mode={mode} resolved={resolved} onChange={onThemeChange} />
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
  const { agentSpec, isSpecLoading, specError } = (useTrueFoundryAgentSpec() ?? {}) as {
    agentSpec?: SpecShape | null;
    isSpecLoading?: boolean;
    specError?: unknown;
  };
  const spec = agentSpec ?? undefined;
  const servers: Server[] = spec?.mcpServers ?? spec?.mcp_servers ?? [];
  const model = spec?.model?.name;
  const sandbox = spec?.config?.sandbox?.enabled;

  return (
    <section className="border-t border-line-soft px-5 py-4" aria-labelledby="reach-heading">
      <h2 id="reach-heading" className="mb-3 text-2xs font-[550] uppercase tracking-[0.07em] text-muted">
        Can reach
      </h2>

      {/* Not knowing must never render as knowing nothing. Both of these used to come out as
          "Nothing yet." - the same words as a genuinely unattached agent, on the panel whose only
          job is disclosing what this agent can touch. */}
      {isSpecLoading ? (
        <p className="text-sm text-muted">Reading the agent definition…</p>
      ) : specError ? (
        <p role="alert" className="text-sm text-failed">
          Could not read the agent definition, so what it can reach is unknown. Do not assume this
          means nothing.
        </p>
      ) : (
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
      )}

      {model && (
        <p className="mt-3 truncate font-mono text-2xs text-muted" title={model}>
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
        <span className={warn ? 'text-failed' : 'text-muted'}>
          <DotIcon />
        </span>
        <span className="truncate text-ink">{label}</span>
      </span>
      <span className={['shrink-0 text-2xs', warn ? 'text-failed' : 'text-muted'].join(' ')}>{note}</span>
    </li>
  );
}

/**
 * The footer row from the reference: the places a stranger goes when the interface has not
 * answered their question. Real destinations only - a link to a page that does not exist is worse
 * than no link, because it costs a click to discover.
 */
export function FooterLinks() {
  // Null while loading or if the call failed - the SDK's own documented semantics, and the reason
  // this needs a third state rather than two.
  const capabilities = useServerCapabilities();

  /**
   * Three states, because null means two different things.
   *
   * Reading null as "not answering" meant every fresh page load accused the harness of being down
   * for as long as the first request took - on the one line that is the only connectivity
   * statement on screen below the large breakpoint. Saying a running server is down is a worse
   * error than saying nothing yet, and it is the error somebody sees first.
   *
   * The grace period is a heuristic and is worth naming as one: the SDK reports null for both
   * cases and offers nothing to tell them apart, so this waits before drawing a conclusion rather
   * than pretending to know. Two and a half seconds is longer than a local harness takes to answer
   * and shorter than anybody's patience.
   */
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), 2500);
    return () => clearTimeout(timer);
  }, []);

  const health = capabilities ? 'connected' : waited ? 'down' : 'checking';

  const links = [
    { label: 'Repository', href: 'https://github.com/manumishra12/quartermaster' },
    { label: 'TrueForge', href: 'https://trueforge.dev' },
    { label: 'Demo script', href: 'https://github.com/manumishra12/quartermaster/blob/main/DEMO.md' },
  ];

  return (
    <footer className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line-soft px-5 py-2.5 text-2xs text-muted">
      {links.map(({ label, href }) => (
        <a
          key={label}
          href={href}
          target="_blank"
          rel="noreferrer"
          className="rounded transition-colors duration-200 hover:text-ink"
        >
          {label}
        </a>
      ))}
      {/* Driven by whether the server actually answered. It used to be a hardcoded green dot and
          the words "harness connected", which said connected while the harness was down - and
          below the large breakpoint it is the only connectivity statement on screen. */}
      <span className="ml-auto inline-flex items-center gap-1.5">
        <span
          className={[
            'inline-block size-1.5 rounded-full',
            health === 'connected' ? 'bg-verified' : health === 'down' ? 'bg-failed' : 'bg-muted',
          ].join(' ')}
        />
        {health === 'connected' ? 'harness connected' : health === 'down' ? 'harness not answering' : 'checking harness'}
      </span>
    </footer>
  );
}
