import { useDialog } from './useDialog';
import { SHORTCUTS } from './useShortcuts';
import { CrossIcon } from './icons';

/**
 * The shortcuts, including the one that is not there.
 *
 * The absence is worth printing rather than leaving to be discovered. Somebody sitting in front of
 * a pending approval will try a key, and a list that simply omitted allow and deny would read as
 * an oversight. Said out loud it is what it actually is: a decision.
 */
export function Shortcuts({ onClose }: { onClose: () => void }) {
  const dialog = useDialog<HTMLDivElement>(true, onClose);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-[var(--qm-overlay,rgba(0,0,0,0.6))]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        ref={dialog}
        tabIndex={-1}
        className="relative w-full max-w-md rounded-xl border border-line-soft bg-surface shadow-[var(--qm-shadow)] focus:outline-2 focus:outline-offset-2 focus:outline-accent"
      >
        <header className="flex items-center gap-2.5 border-b border-line-soft px-4 py-3">
          <h2 className="text-sm font-[550] text-ink">Keyboard</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="qm-tap ml-auto inline-flex size-8 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors duration-200 hover:bg-raised hover:text-ink"
          >
            <CrossIcon />
          </button>
        </header>

        <dl className="px-4 py-3">
          {SHORTCUTS.map(({ keys, label }) => (
            <div key={keys} className="flex items-baseline justify-between gap-4 py-1.5">
              <dt className="text-sm text-ink">{label}</dt>
              <dd>
                <kbd className="qm-nums rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-2xs text-muted">
                  {keys}
                </kbd>
              </dd>
            </div>
          ))}
        </dl>

        <p className="border-t border-line-soft px-4 py-3 text-2xs leading-relaxed text-muted">
          <span className="font-[550] text-ink">Allow and deny are deliberately unbound.</span> A
          single keystroke that authorises an irreversible write is the failure the approval gate
          exists to prevent. The prompt takes focus when it appears, so Tab and Enter reach it in
          two deliberate presses - which is the right number for that decision, and one more than
          for anything else here.
        </p>
      </div>
    </div>
  );
}
