import { Markdown } from '@truefoundry/trueforge-ui';
// @ts-expect-error - shared JS modules, aliased in vite.config.ts
import { unexecutedToolCalls } from '@evidence';
// @ts-expect-error - shared JS modules, aliased in vite.config.ts
import { renderUnexecutedCalls } from '@render-call';
import { AlertIcon } from './icons';

/**
 * The answer, except when the answer is a tool call the model typed out.
 *
 * A model that cannot use tools writes the call instead of making it, and it arrives in the
 * transcript as a wall of braces:
 *
 *     { "name": "exec", "arguments": { "command": "python3 -c ...", "cwd": "/opt/tf/sandbox" } }
 *
 * Rendered as prose that is unreadable, and worse than unreadable: it looks like a question the
 * agent is asking, and nothing is listening for an answer, because the call was never made. The
 * status rail already names this. The transcript did not, so the thing somebody actually reads
 * showed the failure as a formatting problem.
 *
 * The detection and the wording are the CLI's, imported rather than reimplemented - the point of
 * the shared modules is that the two surfaces cannot describe the same event differently.
 */
export function Answer({ content, ...rest }: { content: string; isStreaming?: boolean }) {
  /**
   * Nothing is intercepted while the answer is still arriving. A half-streamed JSON object looks
   * exactly like a printed call, and flashing this banner at somebody mid-sentence would be its
   * own kind of wrong.
   *
   * The guard comes first, which is not cosmetic. Scanning ran before it, on every chunk, and the
   * result was thrown away immediately - about 3ms a call on an ordinary answer, so roughly
   * three-quarters of a second of blocked main thread across a four-hundred-chunk stream, spent
   * computing something the next line discarded.
   */
  if (rest.isStreaming) return <Markdown content={content} {...rest} />;

  const printed = (unexecutedToolCalls(content) ?? []) as unknown[];
  if (printed.length === 0) return <Markdown content={content} {...rest} />;

  const lines = renderUnexecutedCalls(printed) as string[];

  return (
    <div className="qm-enter rounded-lg border border-failed/40 bg-failed/[0.05] p-3">
      <p className="flex items-center gap-2 text-sm font-[550] text-failed">
        <span aria-hidden>
          <AlertIcon />
        </span>
        Written out, not called
      </p>

      <p className="mt-1.5 text-sm leading-relaxed text-ink">
        The model wrote this call as text instead of making it, so nothing ran and nothing is
        waiting for an answer.
      </p>

      <ul className="mt-2.5 space-y-1 font-mono text-xs leading-relaxed text-ink">
        {lines.map((line, i) => (
          <li key={`${i}-${line}`} className={line.startsWith('      ') ? 'pl-4 text-muted' : ''}>
            {line.trim()}
          </li>
        ))}
      </ul>

      {/* The raw text is kept, because somebody debugging the model wants exactly what it emitted. */}
      <details className="mt-2.5">
        <summary className="cursor-pointer text-2xs text-muted hover:text-ink">
          What it actually emitted
        </summary>
        <pre
          tabIndex={0}
          role="region"
          aria-label="What the model emitted"
          className="mt-1.5 max-h-48 overflow-auto rounded border border-line bg-bg/60 p-2 font-mono text-2xs whitespace-pre-wrap break-words text-muted focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          {content}
        </pre>
      </details>
    </div>
  );
}
