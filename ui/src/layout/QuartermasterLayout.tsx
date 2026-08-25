import { useEffect, useState } from 'react';
import { ComposerContainer, ThreadContainer, ThreadListContainer } from '@truefoundry/trueforge-ui';
import { StatusRail } from './StatusRail';

/**
 * Three columns: where you have been, what is happening, and where the agent has got to.
 *
 * The stock chat layout is two columns and answers the first two. The third is the one that
 * matters when an agent is about to do something you cannot undo.
 *
 * Below 1024px the rail moves under the conversation rather than disappearing - on a narrow screen
 * the agent's state is more important than the scrollback, and hiding it would mean the safety
 * information is the first thing to go.
 */
function useIsNarrow(query = '(max-width: 1023px)') {
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return narrow;
}

export function QuartermasterLayout({ className }: { className?: string }) {
  const narrow = useIsNarrow();

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: narrow ? 'column' : 'row',
        height: '100%',
        background: 'var(--qm-bg)',
        color: 'var(--qm-text)',
      }}
    >
      {!narrow && (
        <nav
          aria-label="Conversations"
          style={{
            width: 260,
            flex: 'none',
            borderRight: '1px solid var(--qm-border-soft)',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          <Brand />
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <ThreadListContainer />
          </div>
        </nav>
      )}

      <main style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {narrow && <Brand />}
        <ThreadContainer composer={<ComposerContainer placeholder="Point it at a failing test..." />} />
      </main>

      <StatusRail />
    </div>
  );
}

function Brand() {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--qm-space-lg)',
        padding: 'var(--qm-space-xl)',
        borderBottom: '1px solid var(--qm-border-soft)',
      }}
    >
      <img src="/mark.svg" alt="" width={22} height={22} />
      <div>
        <div style={{ font: '600 14px/1.2 var(--qm-font-sans)' }}>Quartermaster</div>
        <div style={{ font: '11px/1.3 var(--qm-font-sans)', color: 'var(--qm-text-muted)' }}>
          proves it, then asks
        </div>
      </div>
    </header>
  );
}
