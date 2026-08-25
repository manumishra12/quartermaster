import { useMemo, useState } from 'react';
import { useComposerBusyState } from '@truefoundry/trueforge-ui';
import { useAgentState } from './useAgentState';
// @ts-expect-error - shared JS module, aliased in vite.config.ts
import { PHASES, progress, testRuns } from '@evidence';
import { CheckIcon, ClockIcon, CrossIcon, DotIcon, SpinnerIcon } from './icons';

/**
 * The three questions a person actually has while an agent is running: what is it doing, what is
 * it waiting on me for, and what has it actually done. The transcript answers them in paragraphs,
 * in the past tense, mixed in with everything else.
 *
 * Everything here is derived from recorded tool responses, never from the agent's narration. The
 * agent writes the transcript; it does not write the event stream.
 */

type Run = { exitCode: number | null; output: string };

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        borderBottom: '1px solid var(--qm-border-soft)',
        padding: 'var(--qm-space-xl)',
      }}
    >
      <h2
        style={{
          margin: '0 0 var(--qm-space-lg)',
          font: '600 11px/1 var(--qm-font-sans)',
          letterSpacing: '0.09em',
          textTransform: 'uppercase',
          color: 'var(--qm-text-muted)',
        }}
      >
        {label}
      </h2>
      {children}
    </section>
  );
}

/** "Step 3 of 5" beats an undifferentiated spinner on any multi-step process. */
function Steps({ index }: { index: number }) {
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--qm-space-md)' }}>
      {(PHASES as string[]).map((phase, i) => {
        const done = i < index;
        const current = i === index;
        const color = done ? 'var(--qm-verified)' : current ? 'var(--qm-accent)' : 'var(--qm-text-muted)';
        return (
          <li key={phase} style={{ display: 'flex', alignItems: 'center', gap: 'var(--qm-space-md)', color }}>
            <span style={{ display: 'inline-flex', width: 14 }}>
              {done ? <CheckIcon /> : current ? <SpinnerIcon /> : <DotIcon />}
            </span>
            <span style={{ fontWeight: current ? 600 : 400, opacity: done || current ? 1 : 0.55 }}>{phase}</span>
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

  // The shared evidence rules expect the harness envelope, so re-wrap what we unwrapped. Same
  // functions the CLI uses; the rail must not invent its own idea of what counts as a test run.
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
      style={{
        width: 340,
        flex: 'none',
        borderLeft: '1px solid var(--qm-border-soft)',
        background: 'var(--qm-bg)',
        color: 'var(--qm-text)',
        overflowY: 'auto',
        fontSize: 13,
        zIndex: 'var(--qm-z-rail)' as never,
      }}
    >
      <style>{`
        @keyframes qm-spin { to { transform: rotate(360deg) } }
        .qm-spin { animation: qm-spin 900ms linear infinite; transform-origin: 50% 50%; }
      `}</style>

      <Section label="Doing">
        {/* Announced politely so a screen-reader user hears state changes without losing their place. */}
        <p
          aria-live="polite"
          style={{
            margin: '0 0 var(--qm-space-lg)',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--qm-space-md)',
            color: isBusy ? 'var(--qm-accent)' : 'var(--qm-text-muted)',
          }}
        >
          {isBusy ? <SpinnerIcon /> : <ClockIcon />}
          {isBusy ? `Working - ${step.label}` : 'Idle'}
        </p>
        <Steps index={step.index} />
      </Section>

      <Section label="Waiting on">
        {pendingApprovals.length > 0 ? (
          <ApprovalPrompt approvals={pendingApprovals} respond={respondToApproval} />
        ) : pendingQuestions.length > 0 ? (
          <p aria-live="assertive" style={{ margin: 0, display: 'flex', gap: 'var(--qm-space-md)', color: 'var(--qm-waiting)' }}>
            <ClockIcon />
            {pendingQuestions[0]?.question ?? 'Your answer to a question'}
          </p>
        ) : (
          <p aria-live="polite" style={{ margin: 0, display: 'flex', gap: 'var(--qm-space-md)', color: 'var(--qm-text-muted)' }}>
            <DotIcon />
            Nothing. It has not asked for anything.
          </p>
        )}
      </Section>

      <Section label="Did">
        <p style={{ margin: 0, color: 'var(--qm-text-muted)' }}>
          {executions.length} execution{executions.length === 1 ? '' : 's'} recorded
          {runs.length > 0 && `, ${runs.length} of them test runs`}
          {sandboxId ? ' - sandbox live' : ''}
        </p>
        {last ? (
          <Verdict last={last} />
        ) : (
          <p style={{ margin: 'var(--qm-space-lg) 0 0', color: 'var(--qm-text-muted)', maxWidth: '60ch' }}>
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
  const failed = /\b(FAILED|failures=[1-9]|errors=[1-9]|\d+\s+failed|assertionerror|traceback)/i.test(last.output);
  const green = !failed && (last.exitCode === 0 || /\bOK\b/.test(last.output));
  const color = green ? 'var(--qm-verified)' : 'var(--qm-failed)';

  const text = last.output.trim();
  const long = text.length > 400;
  const shown = expanded || !long ? text : text.slice(-400);

  return (
    <div
      style={{
        marginTop: 'var(--qm-space-lg)',
        border: `1px solid ${color}`,
        background: 'var(--qm-surface)',
        borderRadius: 'var(--qm-radius)',
        padding: 'var(--qm-space-lg)',
      }}
    >
      {/* Colour is never the only signal - the icon and the words say it too. */}
      <p style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 'var(--qm-space-md)', color, fontWeight: 600 }}>
        {green ? <CheckIcon /> : <CrossIcon />}
        {green ? 'Last run passed' : 'Last run did not pass'}
      </p>

      <pre
        className="qm-mono"
        style={{
          margin: 'var(--qm-space-lg) 0 0',
          maxHeight: expanded ? 320 : 160,
          overflow: 'auto',
          fontSize: 11,
          lineHeight: 1.5,
          color: 'var(--qm-text)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {shown}
      </pre>

      {long && (
        <button
          type="button"
          className="qm-button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          style={{ marginTop: 'var(--qm-space-md)' }}
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
 * Three things this has to get right. It has to be impossible to miss, because the agent is
 * stopped and nothing proceeds until someone acts. It has to show the actual arguments, because
 * approving "create_pull_request" without seeing what is in it is not consent. And Deny has to be
 * exactly as easy to reach as Allow - a dialog where the safe option is smaller, greyer or further
 * away is a dialog designed to be clicked through.
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
      style={{
        border: '1px solid var(--qm-waiting)',
        background: 'var(--qm-surface)',
        borderRadius: 'var(--qm-radius)',
        padding: 'var(--qm-space-lg)',
      }}
    >
      <p style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 'var(--qm-space-md)', color: 'var(--qm-waiting)', fontWeight: 600 }}>
        <ClockIcon />
        Approval required
      </p>

      <p style={{ margin: 'var(--qm-space-lg) 0 var(--qm-space-md)', color: 'var(--qm-text-muted)' }}>
        It wants to run <code className="qm-mono" style={{ color: 'var(--qm-text)' }}>{pending.toolName}</code>
        {approvals.length > 1 && ` (and ${approvals.length - 1} more)`}. Nothing happens until you choose.
      </p>

      {pending.argsText && (
        <pre
          className="qm-mono"
          style={{
            margin: 0,
            maxHeight: 180,
            overflow: 'auto',
            fontSize: 11,
            lineHeight: 1.5,
            padding: 'var(--qm-space-md)',
            background: 'var(--qm-bg)',
            border: '1px solid var(--qm-border-soft)',
            borderRadius: 'var(--qm-radius)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {pending.argsText}
        </pre>
      )}

      {/* Equal weight, equal size. Deny is listed first because it is the reversible one. */}
      <div style={{ display: 'flex', gap: 'var(--qm-space-md)', marginTop: 'var(--qm-space-lg)' }}>
        <button
          type="button"
          className="qm-button"
          onClick={() => respond?.({ approvalId: pending.approvalId, approved: false, reason: 'Denied by the operator' })}
        >
          Deny
        </button>
        <button
          type="button"
          className="qm-button qm-button-accent"
          onClick={() => respond?.({ approvalId: pending.approvalId, approved: true })}
        >
          Allow
        </button>
      </div>
    </div>
  );
}
