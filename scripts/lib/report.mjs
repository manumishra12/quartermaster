/**
 * Turns a finished run into an artifact somebody else can check.
 *
 * The verdict printed at the end of a run is gone when the terminal scrolls. A reviewer asking
 * "did this actually pass?" a day later needs the executions themselves - the commands, the exit
 * codes, the captured output - not a summary of them. So every run writes both a machine-readable
 * record and something a person can read.
 */
import { PHASES, judge, progress, resultOf } from './evidence.mjs';

const VERDICT_TEXT = {
  substantiated: 'SUBSTANTIATED',
  unsubstantiated: 'UNSUBSTANTIATED',
  contradicted: 'CONTRADICTED',
  'no-claim': 'NO CLAIM',
};

export function buildReport({ agent, prompt, sessionId, finalText = '', toolResponses = [], at }) {
  const { verdict, reason, runs } = judge({ finalText, toolResponses });
  // The runner hands us executions it has already derived and enriched with the command; older
  // callers pass raw events. Accept both rather than parsing an already-parsed thing.
  const executions = toolResponses.map((r) => (r?.output !== undefined ? r : resultOf(r)));
  const phase = progress(toolResponses);

  const json = {
    session: sessionId,
    agent,
    prompt,
    recordedAt: at ?? null,
    verdict,
    reason,
    phase: { index: phase.index, label: phase.label, of: PHASES },
    counts: { executions: executions.length, testRuns: runs.length },
    executions: executions.map((e, i) => ({ index: i, command: e.command ?? null, exitCode: e.exitCode, output: e.output })),
    answer: finalText.trim(),
  };

  return { json, markdown: render(json, runs) };
}

/** A fence at least one backtick longer than the longest run inside the content. */
function fenceFor(content = '') {
  const longest = Math.max(0, ...[...String(content).matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1)) + 'text';
}

function render(r, runs) {
  const lines = [
    `# Evidence report`,
    '',
    `- **Verdict** — ${VERDICT_TEXT[r.verdict] ?? r.verdict}`,
    `- **Why** — ${r.reason}`,
    `- **Agent** — \`${r.agent}\``,
    `- **Session** — \`${r.session}\``,
    r.recordedAt ? `- **Recorded** — ${r.recordedAt}` : null,
    `- **Reached** — ${r.phase.label}`,
    `- **Executions** — ${r.counts.executions} recorded, ${r.counts.testRuns} of them test runs`,
    '',
    `## Asked`,
    '',
    '> ' + (r.prompt || '(none)').replace(/\n/g, '\n> '),
    '',
  ].filter((l) => l !== null);

  if (!r.executions.length) {
    lines.push(
      '## Executions',
      '',
      'None. Nothing ran, so nothing in the answer below is supported by this session.',
      '',
    );
  } else {
    lines.push('## Executions', '');
    for (const e of r.executions) {
      const isTest = runs.some((run) => run.output === e.output);
      lines.push(
        `### ${e.index + 1}. ${isTest ? 'Test run' : 'Command'}${
          e.exitCode === null ? '' : ` - exit ${e.exitCode}`
        }`,
        '',
        e.command ? `\`${e.command}\`` : '_command not recorded_',
        '',
        // Fence longer than any run of backticks in the content. Output containing ``` used to
        // close the block early, letting recorded output render as markdown and forge an entire
        // second "Executions" section in the artifact a reviewer reads.
        fenceFor(e.output),
        (e.output || '(no output)').trimEnd(),
        fenceFor(e.output),
        '',
      );
    }
  }

  lines.push('## Answer', '', r.answer || '(none)', '');
  return lines.join('\n');
}
