import { ComposerBusyProvider, ComposerContainer, ThreadContainer } from '@truefoundry/trueforge-ui';
import { StatusRail } from './StatusRail';
import { FooterLinks, Sidebar, SidebarHeader } from './Sidebar';
import { QuickActions } from './QuickActions';
import { SheetContext } from './SheetContext';
import { Topbar } from './Topbar';
import { useCallback, useState } from 'react';
import { useDialog } from './useDialog';
import { useSidebarWidth, MIN_WIDTH, MAX_WIDTH } from './useSidebarWidth';
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
  const sidebar = useSidebarWidth();
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const sheetRef = useDialog<HTMLElement>(sheetOpen, closeSheet);

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
        className="relative hidden shrink-0 border-r border-line-soft lg:block"
        style={{ width: sidebar.width }}
      >
        <Sidebar mode={mode} resolved={resolved} onThemeChange={onThemeChange} />

        {/*
          * A drag handle for the one column whose contents are arbitrarily long.
          *
          * Conversation titles come from whatever somebody typed first, so a fixed column truncated
          * most of them with no way to read the rest. It is a separator by role, operable by
          * pointer and by keyboard, and it reports its bounds so a screen reader can say where the
          * edge currently sits.
          */}
        {/*
          * A focusable separator carrying aria-valuenow is the ARIA window-splitter pattern, which
          * this rule does not model: it sees an interactive element given a "non-interactive" role
          * and objects, and objects the other way round if the same thing is built from a div. A
          * button is the better base - focusable and keyboard-operable without being told to be.
          */}
        <button
          type="button"
          // eslint-disable-next-line jsx-a11y/no-interactive-element-to-noninteractive-role
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the conversation list"
          aria-valuenow={sidebar.width}
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          onPointerDown={sidebar.onPointerDown}
          onKeyDown={sidebar.onKeyDown}
          onDoubleClick={() => sidebar.set(256)}
          title="Drag to resize. Double-click to reset."
          className={[
            // touch-action tells the browser this gesture is ours. Without it a touchscreen drag
            // is claimed as a scroll and arrives as pointercancel, ending the resize instead of
            // performing it - pointer capture and preventDefault do not substitute for it.
            'absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none',
            'after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2',
            'after:bg-transparent hover:after:bg-accent focus-visible:after:bg-accent',
            'focus-visible:outline-none',
            sidebar.dragging ? 'after:bg-accent' : '',
          ].join(' ')}
        />
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
            /**
             * A dialog, and now treated as one. It took no focus when it opened, Tab walked
             * straight into the conversation underneath it, and no key closed it - so on a phone
             * with a keyboard the only way out was the overlay, which is not reachable by keyboard
             * either.
             */
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            aria-label="Conversations and agent reach"
            className="relative w-72 max-w-[85vw] border-r border-line-soft bg-bg shadow-[var(--qm-shadow)] focus:outline-none"
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
