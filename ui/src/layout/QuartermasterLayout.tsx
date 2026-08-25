import { ComposerContainer, ThreadContainer } from '@truefoundry/trueforge-ui';
import { StatusRail } from './StatusRail';
import { Sidebar, SidebarHeader } from './Sidebar';
import { Topbar } from './Topbar';
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
  agentName,
}: {
  className?: string;
  mode: ThemeMode;
  onThemeChange: (m: ThemeMode) => void;
  agentName: string;
}) {
  return (
    <div className={['flex h-full flex-col bg-bg text-ink lg:flex-row', className].filter(Boolean).join(' ')}>
      <nav
        aria-label="Conversations and agent reach"
        className="hidden w-64 shrink-0 border-r border-line-soft lg:block"
      >
        <Sidebar mode={mode} onThemeChange={onThemeChange} />
      </nav>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* On a narrow screen only the header comes across. The conversation list and the reach
            panel belong behind a control there, not stacked on top of the conversation. */}
        <div className="lg:hidden">
          <SidebarHeader mode={mode} onThemeChange={onThemeChange} />
        </div>
        <Topbar agentName={agentName} />
        <ThreadContainer composer={<ComposerContainer placeholder="Point it at a failing test…" />} />
      </main>

      <StatusRail />
    </div>
  );
}
