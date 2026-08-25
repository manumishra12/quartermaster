import { useEffect, useMemo, useRef, useState } from 'react';
import { useComposerBusyState } from '@truefoundry/trueforge-ui';
// @ts-expect-error - shared JS module, aliased in vite.config.ts
import { PHASES, isGreen, progress, testRuns } from '@evidence';
import { useAgentState } from './useAgentState';
import { CheckIcon, ClockIcon, CloseIcon, CrossIcon, DotIcon, ExpandIcon, SpinnerIcon } from './icons';

/**
 * The three questions a person actually has while an agent is running: what is it doing, what is
 * it waiting on me for, and what has it actually done. The transcript answers them in paragraphs,
 * in the past tense, mixed in with everything else.
 *
 * Everything here is derived from recorded tool responses, never from the agent's narration, and
 * through the same shared functions the CLI uses. The interface must not hold its own opinion
 * about what counts as a passing test.
 */

type Run = { exitCode: number | null; output: string; command?: string | null };

function Section({
  label,
  badge,
  children,
}: {
  label: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-line-soft px-5 py-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-2xs font-semibold uppercase tracking-[0.09em] text-muted">{label}</h2>
        {badge && <span className="qm-nums text-2xs text-muted">{badge}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * An empty state is a place to say what happens next, not a blank.
 *
 * This one carries the argument as well as the instruction: until a run is recorded, anything the
 * agent says about tests passing is unsupported. That is the product, stated where it is most
 * obviously true.
 */
function Empty({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-line-soft p-3">
      <p className="max-w-[46ch] text-sm text-muted">{children}</p>
      {hint && (
        <p className="mt-2 font-mono text-2xs text-muted">
          <span className="select-none text-muted">try </span>
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * "Step 3 of 4" beats an undifferentiated spinner on any multi-step process.
 *
 * The spine matters more than it looks: five separate lines read as a list of options, while a
 * connected run of them reads as one process with a position in it. The filled portion is the
 * distance travelled.
 */
function Steps({ index, settled, busy }: { index: number; settled: boolean; busy: boolean }) {
  const phases = PHASES as string[];
  return (
    <ol className="relative grid gap-2.5">
      {phases.map((phase, i) => {
        const done = i < index;
        const current = i === index;
        const last = i === phases.length - 1;
        return (
          <li key={phase} className="relative flex items-center gap-2.5">
            {!last && (
              <span
                aria-hidden
                className={[
                  'absolute left-[6px] top-4 h-[calc(100%+0.125rem)] w-px transition-colors duration-300',
                  done || (current && settled) ? 'bg-verified/50' : 'bg-line-soft',
                ].join(' ')}
              />
            )}
            <span
              className={[
                'relative z-10 inline-flex w-3.5 shrink-0 justify-center transition-colors duration-200',
                done || (current && settled) ? 'text-verified' : current ? 'text-accent' : 'text-muted',
              ].join(' ')}
            >
              {done || (current && settled) ? <CheckIcon /> : current && busy ? <SpinnerIcon /> : <DotIcon />}
            </span>
            <span
              className={[
                'text-sm transition-colors duration-200',
                done ? 'text-muted' : current ? 'font-medium text-ink' : 'text-muted',
              ].join(' ')}
            >
              {phase}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function StatusRail() {
  const busy = useComposerBusyState() as unknown as boolean | { isBusy?: boolean } | null;
  const { executions, pendingApprovals, respondToApproval, pendingQuestions, sandboxId } = useAgentState();

  const isBusy = typeof busy === 'boolean' ? busy : Boolean(busy?.isBusy);

  // The shared evidence rules accept already-derived executions, so pass them straight through
  // with their command attached. Re-serialising would drop it, and the command is what separates a
  // real test run from output that merely looks like one.
  const asResponses = useMemo(
    () => executions.map((e) => ({ exitCode: e.exitCode, output: e.output, command: e.command })),
    [executions],
  );
  const runs = useMemo(() => testRuns(asResponses) as Run[], [asResponses]);
  const step = useMemo(() => progress(asResponses) as { index: number; label: string; settled: boolean }, [asResponses]);
  const last = runs[runs.length - 1];

  return (
    <aside
      aria-label="Agent status"
      // Below lg this is a column flex child with no ceiling, so its content height won every
      // contest and the conversation and composer were squeezed to zero. Capped at half the
      // viewport there, which is also what makes its own overflow-y-auto do anything.
      className="max-h-[50vh] w-full shrink-0 overflow-y-auto border-t border-line-soft bg-bg text-ink lg:max-h-none lg:w-[22rem] lg:border-l lg:border-t-0"
    >
      <Section label="Doing" badge={step.index >= 0 ? `${step.index + 1} of ${(PHASES as string[]).length}` : undefined}>
        <p
          aria-live="polite"
          className={['mb-3 flex items-center gap-2.5 text-sm', isBusy ? 'text-accent' : 'text-muted'].join(' ')}
        >
          {isBusy ? <SpinnerIcon /> : <ClockIcon />}
          {isBusy ? `Working — ${step.label}` : step.index >= 0 ? 'Finished' : 'Idle'}
        </p>
        <Steps index={step.index} settled={step.settled} busy={isBusy} />
      </Section>

      <Section label="Waiting on" badge={pendingApprovals.length > 1 ? `${pendingApprovals.length} pending` : undefined}>
        {pendingApprovals.length > 0 ? (
          <ApprovalPrompt approvals={pendingApprovals} respond={respondToApproval} />
        ) : pendingQuestions.length > 0 ? (
          <p aria-live="assertive" className="flex items-start gap-2.5 text-sm text-waiting">
            <span className="mt-1 shrink-0">
              <ClockIcon />
            </span>
            {pendingQuestions[0]?.question ?? 'Your answer to a question'}
          </p>
        ) : (
          <p aria-live="polite" className="flex items-center gap-2.5 text-sm text-muted">
            <DotIcon />
            Nothing. It has not asked for anything.
          </p>
        )}
      </Section>

      <Section label="Did" badge={executions.length > 0 ? `${runs.length}/${executions.length} test runs` : undefined}>
        {executions.length > 0 && (
          <p className="qm-nums mb-3 text-sm text-muted">
            {executions.length} execution{executions.length === 1 ? '' : 's'} recorded
            {sandboxId && (
              <span className="ml-2 inline-flex items-center gap-1.5 text-verified">
                <span className="inline-block size-1.5 rounded-full bg-verified" />
                sandbox live
              </span>
            )}
          </p>
        )}
        {last ? (
          <Verdict last={last} />
        ) : (
          <Empty hint="Fix the failing test in ledger. Run it first.">
            No test run recorded yet. Until one is, anything the agent says about tests passing is
            unsupported.
          </Empty>
        )}
      </Section>
    </aside>
  );
}

function Verdict({ last }: { last: Run }) {
  const [expanded, setExpanded] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  // The shared rule, not a copy of it. The copy had already drifted: it treated any "N failed" as
  // a failure including "0 failed", and it did not know that a non-zero exit code decides. Two
  // implementations of "did this pass" is one more than a product about verdicts can afford.
  const green = isGreen(last) as boolean;

  const text = last.output.trim();
  const long = text.length > 400;
  // Show the tail: a runner puts its verdict at the end. Marked, because silently starting
  // mid-line looks like corrupted output rather than a deliberate excerpt.
  const shown = expanded || !long ? text : `… ${text.slice(-400).replace(/^[^\n]*\n/, '')}`;

  return (
    <div
      className={[
        'mt-3 rounded-lg border p-3 shadow-[var(--qm-shadow)]',
        green ? 'border-verified/40 bg-verified/[0.06]' : 'border-failed/40 bg-failed/[0.06]',
      ].join(' ')}
    >
      {/* Colour is never the only signal - the icon and the words carry it too, so this reads the
          same to someone who cannot distinguish the two. */}
      <p
        aria-live="polite"
        className={[
          'flex items-center gap-2.5 text-sm font-semibold',
          green ? 'text-verified' : 'text-failed',
        ].join(' ')}
      >
        <span
          className={[
            'inline-flex size-5 shrink-0 items-center justify-center rounded-full',
            green ? 'bg-verified/15' : 'bg-failed/15',
          ].join(' ')}
        >
          {green ? <CheckIcon /> : <CrossIcon />}
        </span>
        {green ? 'Last run passed' : 'Last run did not pass'}
        {last.exitCode !== null && (
          <span className="qm-nums ml-auto text-2xs font-normal text-muted">exit {last.exitCode}</span>
        )}
      </p>

      <pre
        className={[
          'mt-3 overflow-auto rounded-md border border-line-soft bg-bg/60 p-2.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-words text-ink',
          expanded ? 'max-h-80' : 'max-h-40',
        ].join(' ')}
      >
        {shown}
      </pre>

      <div className="mt-2.5 flex gap-2">
        {long && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="min-h-9 flex-1 cursor-pointer rounded-lg border border-line text-2xs text-muted transition-colors duration-200 hover:border-accent hover:bg-raised hover:text-ink"
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
        <button
          type="button"
          onClick={() => setEnlarged(true)}
          className="inline-flex min-h-9 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-line text-2xs text-muted transition-colors duration-200 hover:border-accent hover:bg-raised hover:text-ink"
        >
          <ExpandIcon />
          Enlarge
        </button>
      </div>

      {enlarged && <OutputDialog run={last} green={green} onClose={() => setEnlarged(false)} />}
    </div>
  );
}

/**
 * The approval moment.
 *
 * Three things it has to get right. It must be impossible to miss, because the agent is stopped
 * and nothing proceeds until someone acts. It must show the actual arguments, because approving
 * `create_pull_request` without seeing what is in it is not consent. And Deny has to be exactly as
 * reachable as Allow - a dialog where the safe option is smaller, greyer or further away is a
 * dialog designed to be clicked through.
 */
function ApprovalPrompt({
  approvals,
  respond,
}: {
  approvals: Array<{ approvalId: string; toolName: string; argsText?: string }>;
  respond?: (r: { approvalId: string; approved: boolean; reason?: string }) => void;
}) {
  const [pending] = approvals;
  const [sent, setSent] = useState<'allow' | 'deny' | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  // Reset when a different approval takes its place, or the next one inherits this one's disabled
  // state and cannot be acted on at all.
  useEffect(() => {
    setSent(null);
    setFailed(null);
  }, [pending?.approvalId]);

  /**
   * Focus the prompt once, when this approval arrives.
   *
   * This was an inline `ref={(node) => node?.focus()}`, which React re-invokes on every commit -
   * and while an agent streams there is a commit every few hundred milliseconds. The result was
   * focus being yanked back to the dialog continuously: a keyboard user could not read the
   * arguments, could not tab to Deny, could not leave. A keyboard trap on the one surface in this
   * product where someone is deciding whether to allow something irreversible.
   *
   * Focus belongs to the person once they have it. This takes it when the prompt appears and never
   * takes it again.
   */
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (pending?.approvalId) dialogRef.current?.focus();
  }, [pending?.approvalId]);

  if (!pending) return null;

  const decide = (approved: boolean) => {
    if (sent) return;
    if (!respond) {
      // No way to send the decision. Saying nothing here would leave the agent paused forever
      // behind a button that looked like it worked.
      setFailed('This session cannot send a decision. The agent is still waiting.');
      return;
    }

    setSent(approved ? 'allow' : 'deny');
    setFailed(null);
    try {
      respond({
        approvalId: pending.approvalId,
        approved,
        ...(approved ? {} : { reason: 'Denied by the operator' }),
      });
    } catch (error) {
      // It reported "Allowed" and disabled both buttons before knowing the call succeeded, so a
      // closed stream left the operator locked out of a decision that was never sent while the
      // rail stated it had been granted.
      setSent(null);
      setFailed(error instanceof Error ? error.message : 'The decision could not be sent.');
    }
  };

  return (
    <div
      role="alertdialog"
      aria-modal="false"
      aria-label={`Approval required for ${pending.toolName}`}
      ref={dialogRef}
      tabIndex={-1}
      className="rounded-lg border border-waiting/60 bg-surface p-3 shadow-[var(--qm-shadow)] focus:outline-2 focus:outline-offset-2 focus:outline-accent"
    >
      {/* Announced separately: an alertdialog label is read on focus, but this must reach someone
          whose focus is elsewhere entirely. */}
      <p role="alert" className="sr-only">
        Approval required before {pending.toolName} can run. The agent is paused.
      </p>
      <p className="flex items-center gap-2.5 text-sm font-semibold text-waiting">
        <ClockIcon />
        Approval required
      </p>

      <p className="mt-3 mb-2 text-sm text-muted">
        It wants to run <code className="font-mono text-ink">{pending.toolName}</code>
        {approvals.length > 1 && ` and ${approvals.length - 1} more`}. Nothing happens until you choose.
      </p>

      {pending.argsText && (
        <pre className="max-h-44 overflow-auto rounded-lg border border-line-soft bg-bg p-2.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-words">
          {pending.argsText}
        </pre>
      )}

      {failed && (
        <p role="alert" className="mt-3 text-sm text-failed">
          {failed} Nothing was sent - the agent is still waiting.
        </p>
      )}

      {/* Equal size, equal weight. Deny is first because it is the reversible one. */}
      <div className="mt-3 flex gap-2.5">
        <button
          type="button"
          onClick={() => decide(false)}
          disabled={sent !== null}
          className="min-h-11 flex-1 cursor-pointer rounded-lg border border-line text-sm font-medium text-ink transition-colors duration-200 hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sent === 'deny' ? 'Sending…' : 'Deny'}
        </button>
        <button
          type="button"
          onClick={() => decide(true)}
          disabled={sent !== null}
          className="min-h-11 flex-1 cursor-pointer rounded-lg border border-accent text-sm font-medium text-accent transition-colors duration-200 hover:bg-accent hover:text-on-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sent === 'allow' ? 'Sending…' : 'Allow'}
        </button>
      </div>
    </div>
  );
}


/**
 * The recorded output, full size.
 *
 * This output is the evidence the whole product rests on, and it was being read through a
 * forty-line window in a 22rem column. Anything with a stack trace in it was effectively unreadable
 * at exactly the moment it mattered most.
 */
function OutputDialog({ run, green, onClose }: { run: Run; green: boolean; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

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
        aria-label="Recorded output"
        ref={(node) => node?.focus()}
        tabIndex={-1}
        className="relative flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl border border-line-soft bg-surface shadow-[var(--qm-shadow)] focus:outline-2 focus:outline-offset-2 focus:outline-accent"
      >
        <header className="flex items-center gap-2.5 border-b border-line-soft px-4 py-3">
          <span className={green ? 'text-verified' : 'text-failed'}>{green ? <CheckIcon /> : <CrossIcon />}</span>
          <h2 className={['text-sm font-semibold', green ? 'text-verified' : 'text-failed'].join(' ')}>
            {green ? 'Last run passed' : 'Last run did not pass'}
          </h2>
          {run.exitCode !== null && (
            <span className="qm-nums text-2xs text-muted">exit {run.exitCode}</span>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto inline-flex size-8 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors duration-200 hover:bg-raised hover:text-ink"
          >
            <CloseIcon />
          </button>
        </header>

        {run.command && (
          <p className="border-b border-line-soft px-4 py-2 font-mono text-2xs text-muted">{run.command}</p>
        )}

        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-ink">
          {run.output.trim() || '(no output)'}
        </pre>
      </div>
    </div>
  );
}
