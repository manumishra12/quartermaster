import { ComposerContainer, ThreadContainer, ThreadListContainer } from '@truefoundry/trueforge-ui';
import { StatusRail } from './StatusRail';
import { ThemeToggle } from './ThemeToggle';
import type { ThemeMode } from './useTheme';

/**
 * Three columns: where you have been, what is happening, and where the agent has got to.
 *
 * The stock chat layout is two columns and answers the first two. The third is the one that
 * matters when an agent is about to do something you cannot undo.
 *
 * Below the large breakpoint the rail moves under the conversation rather than disappearing. On a
 * narrow screen the agent's state is more important than the scrollback, and collapsing it would
 * make the safety information the first casualty.
 */
export function QuartermasterLayout({
  className,
  mode,
  onThemeChange,
}: {
  className?: string;
  mode: ThemeMode;
  onThemeChange: (m: ThemeMode) => void;
}) {
  return (
    <div className={['flex h-full flex-col bg-bg text-ink lg:flex-row', className].filter(Boolean).join(' ')}>
      <nav
        aria-label="Conversations"
        className="hidden min-h-0 w-64 shrink-0 flex-col border-r border-line-soft lg:flex"
      >
        <Brand mode={mode} onThemeChange={onThemeChange} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ThreadListContainer />
        </div>
      </nav>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="lg:hidden">
          <Brand mode={mode} onThemeChange={onThemeChange} />
        </div>
        <ThreadContainer composer={<ComposerContainer placeholder="Point it at a failing test…" />} />
      </main>

      <StatusRail />
    </div>
  );
}

function Brand({ mode, onThemeChange }: { mode: ThemeMode; onThemeChange: (m: ThemeMode) => void }) {
  return (
    <header className="flex items-center gap-3 border-b border-line-soft px-5 py-4">
      <img src="/mark.svg" alt="" width={22} height={22} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-base font-semibold leading-tight">Quartermaster</div>
        <div className="text-2xs text-muted">proves it, then asks</div>
      </div>
      <ThemeToggle mode={mode} onChange={onThemeChange} />
    </header>
  );
}
