import { useState } from 'react';
import { useComposerBusyState } from '@truefoundry/trueforge-ui';
import { useTrueFoundryCancel, useTrueFoundrySandboxId } from '@truefoundry/assistant-ui-runtime';
import { SpinnerIcon } from './icons';

/**
 * The bar above the conversation carries the two things you need while an agent is running and
 * cannot get from the transcript: whether it is still going, and how to make it stop.
 *
 * Stop matters more than it looks. Every other control here asks the agent to do something; this
 * is the only one that takes something back. An agent you cannot interrupt is an agent you have to
 * trust completely, and the entire argument of this project is that you should not have to.
 */
export function Topbar({ agentName }: { agentName: string }) {
  const busy = useComposerBusyState() as unknown as boolean | { isBusy?: boolean } | null;
  const cancel = useTrueFoundryCancel();
  const sandboxId = useTrueFoundrySandboxId();
  const [stopping, setStopping] = useState(false);

  const isBusy = typeof busy === 'boolean' ? busy : Boolean(busy?.isBusy);

  return (
    <div className="flex items-center gap-3 border-b border-line-soft px-5 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <h2 className="truncate font-mono text-sm text-ink">{agentName}</h2>
        {sandboxId && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line-soft px-2 py-0.5 text-2xs text-muted">
            <span className="inline-block size-1.5 rounded-full bg-verified" />
            sandbox
          </span>
        )}
      </div>

      <div className="ml-auto flex items-center gap-3">
        <span
          aria-live="polite"
          className={['flex items-center gap-2 text-2xs', isBusy ? 'text-accent' : 'text-muted'].join(' ')}
        >
          {isBusy && <SpinnerIcon />}
          {isBusy ? 'Running' : 'Idle'}
        </span>

        {isBusy && (
          <button
            type="button"
            disabled={stopping}
            onClick={async () => {
              setStopping(true);
              try {
                await cancel();
              } finally {
                setStopping(false);
              }
            }}
            className="min-h-8 cursor-pointer rounded-lg border border-line px-3 text-2xs font-medium text-ink transition-colors duration-200 hover:border-failed hover:text-failed disabled:cursor-wait disabled:opacity-60"
          >
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>
    </div>
  );
}
