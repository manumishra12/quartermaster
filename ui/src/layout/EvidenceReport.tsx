import { useMemo, useState } from 'react';
// @ts-expect-error - shared JS module, aliased in vite.config.ts
import { buildReport } from '@report';
import { useAgentState } from './useAgentState';
import { useDialog } from './useDialog';
import { CheckIcon, CopyIcon, CrossIcon } from './icons';

/**
 * The evidence report, in the interface, built by the function that writes it to disk.
 *
 * The CLI ends a run by writing `evidence/<session>/report.md` and the interface showed a verdict
 * chip. Two renderings of the same judgement is exactly the arrangement this project spends the
 * rest of its time refusing - and it already went wrong once here, when the rail kept its own copy
 * of "did this pass" and disagreed with the verifier in the direction of reassurance.
 *
 * So this is not a second report. `buildReport` is pure - it takes the recorded responses and
 * returns markdown - so the browser calls the same function with the same input and gets the same
 * bytes. If they ever diverge it is because somebody changed the function, which changes both.
 */
export function EvidenceReport({ agent, onClose }: { agent: string; onClose: () => void }) {
  const { executions, finalText } = useAgentState();
  const dialog = useDialog<HTMLDivElement>(true, onClose);
  const [copied, setCopied] = useState(false);

  const report = useMemo(() => {
    try {
      return buildReport({
        agent,
        prompt: '',
        sessionId: '',
        finalText,
        toolResponses: executions.map((e) => ({
          command: e.command,
          output: e.output,
          exitCode: e.exitCode,
          toolName: e.toolName,
        })),
        /**
         * Stamped by the caller, not read here. The CLI passes the time the run ended; a report
         * built in the browser would otherwise carry the time somebody opened the panel, which
         * reads as a fact about the run and is a fact about the reader.
         */
        at: null,
        /**
         * `.markdown`, not the whole thing.
         *
         * `buildReport` returns `{ json, markdown }`. This cast the object to a string and rendered
         * it as a React child, which throws "Objects are not valid as a React child" - at render,
         * so the try/catch below could not see it, and the app's single top-level error boundary
         * replaced the entire interface with the error screen. The button that did it is the one
         * the demo walkthrough points at. Copy produced "[object Object]" for the same reason.
         *
         * No test opened this panel, so the UI suite was green throughout.
         */
      }).markdown as string;
    } catch (error) {
      // A report that cannot be built is worth saying so about. Rendering nothing would read as a
      // run with nothing in it, which is the one thing this panel must never imply.
      return `The report could not be built.\n\n${String((error as Error)?.message ?? error)}`;
    }
  }, [agent, finalText, executions]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access is refused in plenty of ordinary situations. The text is on screen and
      // selectable, so a failed copy costs a click, not the content.
      setCopied(false);
    }
  };

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
        aria-label="Evidence report"
        ref={dialog}
        tabIndex={-1}
        className="relative flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl border border-line-soft bg-surface shadow-[var(--qm-shadow)] focus:outline-2 focus:outline-offset-2 focus:outline-accent"
      >
        <header className="flex items-center gap-2.5 border-b border-line-soft px-4 py-3">
          <h2 className="text-sm font-[550] text-ink">Evidence report</h2>
          <p className="text-2xs text-muted">the same file the CLI writes</p>

          <button
            type="button"
            onClick={copy}
            className="qm-tap ml-auto inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2.5 text-2xs text-muted transition-colors duration-200 hover:border-accent hover:text-ink"
          >
            <span aria-hidden className={copied ? 'text-verified' : undefined}>
              {copied ? <CheckIcon /> : <CopyIcon />}
            </span>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="qm-tap inline-flex size-8 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors duration-200 hover:bg-raised hover:text-ink"
          >
            <CrossIcon />
          </button>
        </header>

        {/* Focusable, because it scrolls: a region a keyboard cannot enter is content it cannot reach. */}
        <pre
          tabIndex={0}
          role="region"
          aria-label="The report"
          className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-ink focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          {report}
        </pre>
      </div>
    </div>
  );
}
