/**
 * A patch, rendered as a patch.
 *
 * The fixing agents produce diffs and the transcript showed them as undifferentiated monospace, so
 * the one thing a reader wants from a patch - what changed - had to be worked out by reading every
 * line. It is also the thing the demo has to show, because a diff nobody can scan is a fix nobody
 * can judge.
 *
 * Colour is never the only signal here, for the same reason it is not anywhere else in this
 * interface: every line keeps its `+` or `-` in a gutter, so the patch reads the same to somebody
 * who cannot tell the two tints apart, and survives being copied into a terminal.
 */

/** Whether this text is a unified diff, rather than code that happens to start with a dash. */
export function looksLikeDiff(code: string, language?: string): boolean {
  if (language === 'diff' || language === 'patch') return true;

  const lines = String(code ?? '').split('\n');
  /**
   * A hunk header is the honest marker. `+`/`-` lines alone are not enough - a CSS file full of
   * vendor prefixes and a shell script of flags both open lines with them - and mistaking ordinary
   * code for a patch would colour half of it red for no reason.
   */
  return lines.some((line) => /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(line));
}

type Row = { kind: 'add' | 'remove' | 'hunk' | 'meta' | 'context'; text: string };

export function parseDiff(code: string): Row[] {
  return String(code ?? '')
    .split('\n')
    .map((text): Row => {
      if (/^@@ /.test(text)) return { kind: 'hunk', text };
      // Checked before the single-character cases: `+++`/`---` are file headers, not changed lines.
      if (/^(\+\+\+|---|diff |index |new file|deleted file|similarity index|rename )/.test(text)) {
        return { kind: 'meta', text };
      }
      if (text.startsWith('+')) return { kind: 'add', text };
      if (text.startsWith('-')) return { kind: 'remove', text };
      return { kind: 'context', text };
    });
}

const TONE: Record<Row['kind'], string> = {
  add: 'bg-verified/[0.09] text-ink',
  remove: 'bg-failed/[0.09] text-ink',
  hunk: 'bg-raised text-muted',
  meta: 'text-muted',
  context: 'text-ink',
};

export function Diff({ code, className }: { code: string; className?: string }) {
  const rows = parseDiff(code);
  const added = rows.filter((r) => r.kind === 'add').length;
  const removed = rows.filter((r) => r.kind === 'remove').length;

  return (
    <div
      className={[
        'overflow-hidden rounded-lg border border-line bg-bg/60',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="flex items-center gap-3 border-b border-line-soft px-3 py-1.5">
        <span className="text-2xs font-[550] uppercase tracking-[0.07em] text-muted">Patch</span>
        {/* The counts carry a sign as well as a colour, so they read without it. */}
        <span className="qm-nums ml-auto text-2xs text-verified">+{added}</span>
        <span className="qm-nums text-2xs text-failed">&minus;{removed}</span>
      </div>

      {/* Its own scroll container: a wide patch must not push the page sideways. */}
      <div
        tabIndex={0}
        role="region"
        aria-label={`Patch, ${added} lines added and ${removed} removed`}
        className="max-h-96 overflow-auto focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <table className="w-full border-collapse font-mono text-xs leading-relaxed">
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={TONE[row.kind]}>
                <td
                  aria-hidden
                  className="w-6 select-none border-r border-line-soft px-1.5 text-center text-muted"
                >
                  {row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ''}
                </td>
                <td className="whitespace-pre-wrap break-words px-2.5">
                  {/* The marker is in the gutter, so it is not repeated in the text. */}
                  {row.kind === 'add' || row.kind === 'remove' ? row.text.slice(1) : row.text}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
