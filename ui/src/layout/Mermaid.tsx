import { useEffect, useId, useRef, useState } from 'react';
import { useTheme } from './useTheme';

/**
 * A mermaid diagram, rendered.
 *
 * The agents produce diagrams - a timeline of an incident, the shape of a query result - and every
 * document in this repository is already drawn in mermaid, so a diagram in an answer and a diagram
 * in `ARCHITECTURE.md` are the same language. Showing one as a fenced block of arrows is showing
 * the source of a picture instead of the picture.
 *
 * It also settles a question that had no good answer. The analytics agent is asked for charts, and
 * whether its sandbox has matplotlib turned out to be difficult to establish - the local model
 * prints tool calls rather than making them, so five attempts to ask it failed. Mermaid needs
 * nothing installed anywhere: the agent writes text, and the text is the chart.
 *
 * Loaded on demand. Mermaid is large, most conversations contain no diagram at all, and paying for
 * it on first paint to serve the ones that do is the wrong trade.
 */
export function Mermaid({ code }: { code: string }) {
  const id = useId().replace(/:/g, '');
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const { resolved } = useTheme();
  /** So a slow import that resolves after the theme changed cannot paint the old one. */
  const generation = useRef(0);

  useEffect(() => {
    const mine = (generation.current += 1);
    let alive = true;

    void (async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({
          startOnLoad: false,
          /**
           * Mermaid's own dark theme rather than this palette. Matching the tokens exactly would
           * mean maintaining a mapping for every node type mermaid has, and getting it wrong reads
           * as a broken diagram rather than an off-brand one.
           */
          theme: resolved === 'dark' ? 'dark' : 'neutral',
          /**
           * Sandboxed, not merely sanitised.
           *
           * This renders text the model wrote into the page through `dangerouslySetInnerHTML`, and
           * the model reads issue bodies, repository files and web pages - which this project
           * spends a whole fixture demonstrating can persuade it. So the chain
           * "injection -> model emits a crafted diagram -> it executes in the operator's browser"
           * is not hypothetical here; it is the attack this repository is about, pointed at the
           * interface instead of the gate.
           *
           * `strict` would rely on mermaid's DOMPurify, which resolves to 3.4.8 and carries four
           * open advisories, one of them an XSS through a detached subtree. Depending on a
           * sanitiser to be perfect against input an attacker helped write is the wrong shape of
           * bet. `sandbox` renders into an iframe instead, so a bypass executes somewhere that
           * cannot reach this page.
           *
           * It costs the diagram its inherited fonts and some layout control. That is a fair price
           * for not having to be right about DOMPurify.
           */
          securityLevel: 'sandbox',
          fontFamily: 'inherit',
        });
        const { svg: rendered } = await mermaid.render(`m${id}`, code);
        if (alive && mine === generation.current) setSvg(rendered);
      } catch (error) {
        /**
         * A diagram that will not parse is shown as its source rather than swallowed. The model
         * wrote something, and a reader deciding whether to trust this agent needs to see what.
         */
        if (alive && mine === generation.current) {
          setFailed(String((error as Error)?.message ?? error));
        }
      }
    })();

    return () => {
      alive = false;
    };
  }, [code, id, resolved]);

  if (failed !== null) {
    return (
      <div className="overflow-hidden rounded-lg border border-line bg-bg/60">
        <p className="border-b border-line-soft px-3 py-1.5 text-2xs text-muted">
          This diagram did not parse, so here is what was written: {failed}
        </p>
        <pre
          tabIndex={0}
          role="region"
          aria-label="Diagram source"
          className="max-h-72 overflow-auto p-2.5 font-mono text-xs whitespace-pre-wrap break-words text-ink focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          {code}
        </pre>
      </div>
    );
  }

  if (svg === null) {
    // Reserving the height keeps the answer from jumping when the diagram arrives.
    return <div className="h-32 animate-pulse rounded-lg border border-line-soft bg-raised/40" aria-hidden />;
  }

  return (
    <div
      /**
       * A scrollable region containing a picture, not a picture. A wide diagram scrolls inside this
       * box rather than pushing the page sideways, and a scroll container a keyboard cannot enter
       * is content it cannot reach - which is the same rule every other scrolling block here follows.
       */
      tabIndex={0}
      role="region"
      aria-label="Diagram"
      className="qm-enter overflow-auto rounded-lg border border-line bg-surface p-3 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent [&_iframe]:w-full [&_iframe]:min-h-64 [&_iframe]:border-0 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      // Mermaid's own output, rendered with securityLevel 'strict', which strips script and
      // event handlers. The alternative is not rendering diagrams at all.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
