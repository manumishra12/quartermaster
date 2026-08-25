import { ComposerBusyProvider, ComposerContainer, ThreadContainer } from '@truefoundry/trueforge-ui';
import { StatusRail } from './StatusRail';
import { FooterLinks, Sidebar, SidebarHeader } from './Sidebar';
import { QuickActions } from './QuickActions';
import { SheetContext } from './SheetContext';
import { Topbar } from './Topbar';
import { useCallback, useState } from 'react';
import { useThemeControl } from './ThemeContext';

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
export function QuartermasterLayout({ className }: { className?: string }) {
  const { mode, resolved, onThemeChange, agentName } = useThemeControl();
  const [sheetOpen, setSheetOpen] = useState(false);
  const closeSheet = useCallback(() => setSheetOpen(false), []);

  /**
   * ComposerBusyProvider is wired by default inside <Thread />, which this layout does not use - it
   * composes ThreadContainer and ComposerContainer separately so the rail can sit beside them. The
   * rail and the topbar both read busy state, so they need the provider mounted above them here.
   *
   * Without it they throw on mount and the whole surface renders blank. That shipped, because the
   * component tests mocked the very hook that was failing and a smoke check on the dev server only
   * proved the HTML shell was served. There is a mount test now that renders this real tree.
   */
  return (
    <ComposerBusyProvider>
    <div className={['flex h-full flex-col bg-bg text-ink lg:flex-row', className].filter(Boolean).join(' ')}>
      <nav
        aria-label="Conversations and agent reach"
        className="hidden w-64 shrink-0 border-r border-line-soft lg:block"
      >
        <Sidebar mode={mode} resolved={resolved} onThemeChange={onThemeChange} />
      </nav>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* On a narrow screen the sidebar opens as a sheet. It used to be display:none with no
            control anywhere, so the conversation list and the whole "Can reach" panel - including
            the word "ungated" - simply did not exist below this breakpoint. */}
        <div className="lg:hidden">
          <SidebarHeader
            mode={mode}
            resolved={resolved}
            onThemeChange={onThemeChange}
            onOpenSidebar={() => setSheetOpen(true)}
          />
        </div>
        <Topbar agentName={agentName} />
        <ThreadContainer
          composer={
            <>
              <QuickActions />
              <ComposerContainer placeholder="Point it at a failing test…" />
            </>
          }
        />
        <FooterLinks />
      </main>

      <StatusRail />

      {sheetOpen && (
        <div className="fixed inset-0 z-30 flex lg:hidden">
          <button
            type="button"
            aria-label="Close"
            onClick={() => setSheetOpen(false)}
            className="absolute inset-0 cursor-default bg-[var(--qm-overlay,rgba(0,0,0,0.5))]"
          />
          {/* Choosing a conversation closes the sheet. Being left staring at the drawer covering
              the conversation it just opened is the sheet failing at the one thing it exists for. */}
          <nav
            aria-label="Conversations and agent reach"
            className="relative w-72 max-w-[85vw] border-r border-line-soft bg-bg shadow-[var(--qm-shadow)]"
          >
            <SheetContext.Provider value={closeSheet}>
              <Sidebar mode={mode} resolved={resolved} onThemeChange={onThemeChange} />
            </SheetContext.Provider>
          </nav>
        </div>
      )}
    </div>
    </ComposerBusyProvider>
  );
}
