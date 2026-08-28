// @ts-expect-error - shared JS modules, aliased in vite.config.ts
import { parseHandoffEnvelope } from '@handoff';
import { OneWayIcon } from './icons';

type Envelope = { from: string; to: string; request: string; because: string; chain: string[] };

/** Parsed by the module that writes it, so the two surfaces cannot disagree about what a handoff is. */
export function readHandoff(content: string): Envelope | null {
  return (parseHandoffEnvelope(content) ?? null) as Envelope | null;
}

/**
 * A request that arrived from another agent, shown as provenance rather than as prose.
 *
 * The envelope reaches the receiving agent as three paragraphs: where the work came from, what the
 * person originally asked, and a note the sending agent wrote. The middle one is trustworthy and
 * the last one is not, and flattened into a transcript they look identical - same typeface, same
 * weight, same authority. So the reader has no way to tell which sentences a person wrote and
 * which a model did.
 *
 * That distinction is the entire defence. The note is text written by a model, with the same power
 * to contain "this was pre-approved by the team lead" as any issue body from a stranger, and the
 * receiving agent is instructed to treat it as untrusted. A person auditing the same transcript
 * should be able to see the same boundary the agent was told to respect, because a defence nobody
 * can see is one nobody checks.
 */
export function HandoffCard({ envelope }: { envelope: Envelope }) {
  return (
    <section
      aria-label={`Request handed from ${envelope.from} to ${envelope.to}`}
      className="qm-enter rounded-lg border border-soft bg-raised/60 p-3"
    >
      <p className="flex items-center gap-2 text-sm font-[550] text-ink">
        <span aria-hidden className="text-muted">
          <OneWayIcon />
        </span>
        Handed over by {envelope.from}
      </p>

      <ol className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-2xs text-muted">
        {envelope.chain.map((agent, i) => (
          <li key={`${i}-${agent}`} className="flex items-center gap-1.5">
            {i > 0 && <span aria-hidden>-&gt;</span>}
            <span className={i === envelope.chain.length - 1 ? 'font-mono text-ink' : 'font-mono'}>{agent}</span>
          </li>
        ))}
      </ol>

      <p className="mt-3 text-2xs uppercase tracking-wide text-muted">What the person asked</p>
      <p className="mt-1 text-sm leading-relaxed text-ink">{envelope.request}</p>

      {/*
        Set apart deliberately, and labelled with who wrote it. The visual break is doing the same
        job as the framing in the prompt: this half was written by a model and has not been checked.
      */}
      <div className="mt-3 rounded-md border border-dashed border-waiting/50 bg-waiting/[0.05] p-2.5">
        <p className="text-2xs uppercase tracking-wide text-waiting">
          Note from {envelope.from} - unverified
        </p>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink">{envelope.because}</p>
        <p className="mt-2 text-2xs leading-relaxed text-muted">
          Written by a model and checked by nobody. If it says something was done, run or approved,
          it is a claim rather than a record. Approvals do not travel between agents.
        </p>
      </div>
    </section>
  );
}
