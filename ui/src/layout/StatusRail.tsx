import { useMemo, useState } from 'react';
import { useComposerBusyState } from '@truefoundry/trueforge-ui';
// @ts-expect-error - shared JS module, aliased in vite.config.ts
import { PHASES, progress, testRuns } from '@evidence';
import { useAgentState } from './useAgentState';
import { CheckIcon, ClockIcon, CrossIcon, DotIcon, SpinnerIcon } from './icons';

/**
 * The three questions a person actually has while an agent is running: what is it doing, what is
 * it waiting on me for, and what has it actually done. The transcript answers them in paragraphs,
 * in the past tense, mixed in with everything else.
 *
 * Everything here is derived from recorded tool responses, never from the agent's narration, and
 * through the same shared functions the CLI uses. The interface must not hold its own opinion
 * about what counts as a passing test.
 */

type Run = { exitCode: number | null; output: string };

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line-soft px-5 py-4">
      <h2 className="mb-3 text-2xs font-semibold uppercase tracking-[0.09em] text-muted">{label}</h2>
      {children}
    </section>
  );
}

/** "Step 3 of 5" beats an undifferentiated spinner on any multi-step process. */
function Steps({ index }: { index: number }) {
  return (
    <ol className="grid gap-2">
      {(PHASES as string[]).map((phase, i) => {
        const done = i < index;
        const current = i === index;
        return (
          <li
            key={phase}
            className={[
              'flex items-center gap-2.5 text-sm transition-colors duration-200',
              done ? 'text-verified' : current ? 'text-accent' : 'text-muted/60',
            ].join(' ')}
          >
            <span className="inline-flex w-3.5 shrink-0">
              {done ? <CheckIcon /> : current ? <SpinnerIcon /> : <DotIcon />}
            </span>
            <span className={current ? 'font-medium' : undefined}>{phase}</span>
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

  // Re-wrap into the harness envelope so the shared evidence rules apply unchanged.
  const asResponses = useMemo(
    () => executions.map((e) => ({ content: JSON.stringify({ response: { exitCode: e.exitCode, result: e.output } }) })),
    [executions],
  );
  const runs = useMemo(() => testRuns(asResponses) as Run[], [asResponses]);
  const step = useMemo(() => progress(asResponses) as { index: number; label: string }, [asResponses]);
  const last = runs[runs.length - 1];

  return (
    <aside
      aria-label="Agent status"
      className="w-full shrink-0 overflow-y-auto border-line-soft bg-bg text-ink lg:w-[22rem] lg:border-l"
    >
      <Section label="Doing">
        <p
          aria-live="polite"
          className={['mb-3 flex items-center gap-2.5 text-sm', isBusy ? 'text-accent' : 'text-muted'].join(' ')}
        >
          {isBusy ? <SpinnerIcon /> : <ClockIcon />}
          {isBusy ? `Working — ${step.label}` : 'Idle'}
        </p>
        <Steps index={step.index} />
      </Section>

      <Section label="Waiting on">
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

      <Section label="Did">
        <p className="text-sm text-muted">
          {executions.length} execution{executions.length === 1 ? '' : 's'} recorded
          {runs.length > 0 && `, ${runs.length} of them test runs`}
          {sandboxId ? ' — sandbox live' : ''}
        </p>
        {last ? (
          <Verdict last={last} />
        ) : (
          <p className="mt-3 max-w-[52ch] text-sm text-muted">
            No test run recorded yet. Until one is, anything the agent says about tests passing is
            unsupported.
          </p>
        )}
      </Section>
    </aside>
  );
}

function Verdict({ last }: { last: Run }) {
  const [expanded, setExpanded] = useState(false);
  const failed = /\b(FAILED|FAIL|failures=[1-9]|errors=[1-9]|\d+\s+failed|assertionerror|traceback|not ok)/i.test(
    last.output,
  );
  const green = !failed && (last.exitCode === 0 || /^OK$/im.test(last.output));

  const text = last.output.trim();
  const long = text.length > 400;
  const shown = expanded || !long ? text : text.slice(-400);

  return (
    <div
      className={[
        'mt-3 rounded-lg border p-3 shadow-[var(--qm-shadow)]',
        green ? 'border-verified/40 bg-verified/[0.06]' : 'border-failed/40 bg-failed/[0.06]',
      ].join(' ')}
    >
      {/* Colour is never the only signal - the icon and the words carry it too. */}
      <p
        className={[
          'flex items-center gap-2.5 text-sm font-semibold',
          green ? 'text-verified' : 'text-failed',
        ].join(' ')}
      >
        {green ? <CheckIcon /> : <CrossIcon />}
        {green ? 'Last run passed' : 'Last run did not pass'}
      </p>

      <pre
        className={[
          'mt-3 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed text-ink',
          expanded ? 'max-h-80' : 'max-h-40',
        ].join(' ')}
      >
        {shown}
      </pre>

      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-2 min-h-11 w-full cursor-pointer rounded-lg border border-line bg-transparent text-sm text-muted transition-colors duration-200 hover:border-accent hover:bg-raised hover:text-ink"
        >
          {expanded ? 'Show less' : 'Show full output'}
        </button>
      )}
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
  if (!pending) return null;

  return (
    <div
      role="alertdialog"
      aria-label={`Approval required for ${pending.toolName}`}
      className="rounded-lg border border-waiting/60 bg-surface p-3 shadow-[var(--qm-shadow)]"
    >
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

      {/* Equal size, equal weight. Deny is first because it is the reversible one. */}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => respond?.({ approvalId: pending.approvalId, approved: false, reason: 'Denied by the operator' })}
          className="min-h-11 flex-1 cursor-pointer rounded-lg border border-line text-sm font-medium text-ink transition-colors duration-200 hover:bg-raised"
        >
          Deny
        </button>
        <button
          type="button"
          onClick={() => respond?.({ approvalId: pending.approvalId, approved: true })}
          className="min-h-11 flex-1 cursor-pointer rounded-lg border border-accent text-sm font-medium text-accent transition-colors duration-200 hover:bg-accent hover:text-on-accent"
        >
          Allow
        </button>
      </div>
    </div>
  );
}
