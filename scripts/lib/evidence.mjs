/**
 * Checks what the agent said against what the harness actually recorded.
 *
 * An agent can be told not to claim an unverified result and will do it anyway - a small local
 * model did exactly that during development, inventing a line of passing test output it never ran.
 * Instructions are a request. This is enforcement: the event stream is ground truth, and a claim
 * that no recorded tool call supports is reported as unsubstantiated.
 */

export const SUBSTANTIATED = 'substantiated';
export const UNSUBSTANTIATED = 'unsubstantiated';
export const CONTRADICTED = 'contradicted';
export const NO_CLAIM = 'no-claim';
export const NO_ANSWER = 'no-answer';

/**
 * Language that asserts something was executed and reports its result.
 *
 * Only six of the seven agents here run tests, but every one of them can be asked to run something
 * and report back. A code runner that says "the output is 81" without having run anything is making
 * exactly the same unsupported claim as one that says "the tests pass" - it just happens to be
 * right this time.
 *
 * Kept narrow on purpose: this matches assertions that an execution *happened*, not explanations of
 * what code would do. "This function returns 81" is analysis. "The output is 81" is a claim.
 */
const CLAIM_EXECUTED =
  /\b(the (output|result|stdout|stderr) (is|was)|it (printed|output|returned|produced)|exit code (is|was)|when (i|we) ran|running it (gives|prints|produces|returns))\b/i;

/**
 * The labelled-report form: `stdout: 81`, `exit code: 0`.
 *
 * This is the shape an agent produces when it has been told to report stdout, stderr and an exit
 * code - and it will produce it whether or not anything ran. Filling in that template from
 * imagination is the most convincing fabrication of the lot, because it looks like transcribed
 * output rather than prose.
 */
const CLAIM_REPORT_FORM =
  /^\s*(?:[-*]\s*)?(?:\*\*|__)?\s*(stdout|stderr|exit\s?code)\s*(?:\*\*|__)?\s*[:=]/im;

/** Language that asserts a passing result. Deliberately broad - over-detecting a claim is safe. */
const CLAIM =
  /\b(tests?\s+(all\s+)?(now\s+)?(pass\w*|succeed\w*)|all\s+(the\s+)?tests?\s+\w*\s*pass\w*|(everything|all\s+checks?)\s+pass\w*|passing|all\s+green|(suite|build)\s+is\s+(green|clean|passing)|now\s+works|fix(ed|es)\s+it|is\s+fixed|works\s+now|verified|\d+\s+passed,\s*0\s+failed)\b/i;

/**
 * What a test runner's output looks like.
 *
 * `\bOK\b` used to be the pass marker. Case-insensitively that matches the "ok" inside TAP's
 * `not ok 3 - ...`, which is the *failure* line of `node --test` - this repo's own JS fixture
 * emits it. It also matched `HTTP/1.1 200 OK` from a curl and a bare `echo ok`. A pass marker that
 * matches a failure line is worse than no pass marker.
 */
const RAN_TESTS =
  /(\bran\s+\d+\s+tests?\b|\b\d+\s+(passed|failed|failing)\b|^#\s*(pass|fail)\s+\d+|^(not\s+)?ok\s+\d+|\bFAILED\b|\bassertionerror\b|^(PASS|FAIL)\b|\btests?\s+(passed|failed)\b)/im;

const FAILED =
  /(\bFAILED\b|\bFAIL\b|failures=[1-9]|errors=[1-9]|\b\d+\s+(failed|failing)\b|^#\s*fail\s+[1-9]|^not\s+ok\s|\bassertionerror\b|\btraceback\b|[\u2716\u2717])/im;

const PASSED = /(^OK$|^#\s*fail\s+0$|\b0\s+failed\b|\ball\s+tests\s+passed\b|\b\d+\s+passed\b)/im;

/**
 * Commands that actually invoke a test runner.
 *
 * Classifying by output alone means any execution whose text happens to look test-shaped becomes
 * evidence: `echo ok`, a curl header, or a file the agent wrote itself and read back. The command
 * is the half the agent cannot phrase its way around.
 */
const TEST_COMMAND =
  /\b(pytest|unittest|nose2|npm\s+(run\s+)?test|pnpm\s+test|yarn\s+test|node\s+--test|jest|vitest|mocha|ava\b|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+(test|verify)|gradle\s+test|rspec|phpunit|tox|ctest|make\s+test)\b/i;

export function looksLikeTestCommand(command = '') {
  return TEST_COMMAND.test(String(command));
}

/** Pull the executed command output out of a tool.response event. */
/**
 * True when the final answer is a tool call the model typed out instead of making.
 *
 * A model too weak to use tools does not fail loudly - it emits the JSON it was supposed to send
 * and calls that an answer. Nothing ran, nothing errored, and the transcript looks busy. Worth
 * naming precisely, because the fix is a different model rather than a different prompt.
 */
export function looksLikeUnexecutedToolCall(text = '') {
  // The JSON is often introduced ("Here is the call I would make:") or wrapped in <tool_call> tags,
  // so requiring it at position zero missed the most common emissions.
  const candidates = [text];
  for (const [, body] of text.matchAll(/```(?:json)?\n([\s\S]*?)```/g)) candidates.push(body);
  for (const [, body] of text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/gi)) candidates.push(body);

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    const start = trimmed.search(/[{[]/);
    if (start === -1) continue;
    try {
      const parsed = JSON.parse(trimmed.slice(start));
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      if (
        calls.some(
          (c) =>
            c &&
            typeof c === 'object' &&
            typeof c.name === 'string' &&
            // A tool name is an identifier. Requiring that keeps ordinary data - an analytics
            // answer like {"name": "Q1 revenue", "parameters": {...}} - from being flagged.
            /^[a-z][a-z0-9_.-]*$/i.test(c.name) &&
            ('arguments' in c || 'parameters' in c),
        )
      ) {
        return true;
      }
    } catch {
      // Not JSON; try the next candidate.
    }
  }
  return false;
}

/**
 * The concrete values an answer says something printed.
 *
 * Deliberately literal and deliberately small. The aim is not to parse the answer, it is to pull
 * out a few strings that must appear in real output if the claim is true. Anything it cannot read
 * confidently it leaves out: a missed claim is safe, a mis-extracted one is not.
 */
export function claimedValues(text = '') {
  const values = [];
  for (const [, value] of text.matchAll(
    /^\s*(?:[-*]\s*)?(?:\*\*)?(?:stdout|output|result)(?:\*\*)?\s*[:=]\s*(.+)$/gim,
  )) {
    // Strip the markdown the label was wearing: `- **stdout:** 81` claims `81`, not `** 81`.
    const cleaned = value
      .trim()
      .replace(/^(?:\*\*|__)\s*/, '')
      .replace(/\s*(?:\*\*|__)$/, '')
      .replace(/^[`"']+|[`"']+$/g, '')
      .trim();
    if (cleaned && cleaned.length <= 120) values.push(cleaned);
  }
  for (const [, value] of text.matchAll(/\bthe\s+(?:output|result)\s+(?:is|was)\s+`?([^`\n.,]{1,80})`?/gi)) {
    const cleaned = value.trim();
    if (cleaned) values.push(cleaned);
  }
  return [...new Set(values)];
}

/**
 * Pull the executed command output out of a tool.response event.
 *
 * Every branch exists because a real envelope shape landed in it. A shape it cannot read is
 * reported as `understood: false` rather than as empty output - silently returning "" deletes a red
 * test run from the evidence and turns a contradiction into a pass.
 */
export function resultOf(toolResponse, command = null) {
  const raw = toolResponse?.content;
  if (raw == null) return { exitCode: null, output: '', command, understood: false };

  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { exitCode: null, output: String(raw), command, understood: true };
  }

  if (typeof parsed === 'string') return { exitCode: null, output: parsed, command, understood: true };
  if (parsed == null || typeof parsed !== 'object') {
    return { exitCode: null, output: String(raw), command, understood: false };
  }

  const inner = parsed.response ?? parsed;

  // Exit codes arrive as numbers, and from some servers as numeric strings.
  const rawExit = inner.exitCode ?? inner.exit_code ?? inner.exitcode;
  const exitCode =
    typeof rawExit === 'number' ? rawExit : /^-?\d+$/.test(String(rawExit ?? '')) ? Number(rawExit) : null;

  // `??` alone would stop at an empty `result` and never look at a populated `output`.
  const candidates = [inner.result, inner.output, inner.stdout, inner.text];
  const value = candidates.find((c) => typeof c === 'string' && c !== '') ?? candidates.find((c) => c != null);
  let output = '';
  let understood = true;

  if (typeof value === 'string') {
    output = value;
  } else if (Array.isArray(value)) {
    output = value.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('');
  } else if (value && typeof value === 'object') {
    output = String(value.stdout ?? value.output ?? '');
    understood = output !== '';
  } else if (Array.isArray(parsed.content)) {
    // The MCP content-array shape: [{type: 'text', text: '...'}]
    output = parsed.content.map((part) => part?.text ?? '').join('');
  } else {
    understood = false;
  }

  return { exitCode, output, command, understood };
}

/**
 * Did this run pass?
 *
 * The exit code decides whenever we have one. It used to be one side of an OR, so a non-zero exit
 * could never disqualify a run whose text happened to contain a pass marker: a real `go test`
 * failure exiting 1 was read as green. The exit code is the one signal a model cannot phrase its
 * way around, and it was the weakest input in the function.
 */
export function isGreen(run) {
  if (FAILED.test(run.output)) return false;
  if (typeof run.exitCode === 'number') return run.exitCode === 0;
  return PASSED.test(run.output);
}

/**
 * Every recorded execution that is a test run.
 *
 * When the command is known it must look like a test invocation. Classifying on output alone let
 * `echo ok`, a curl header, and a file the agent wrote itself and read back all count as proof.
 */
export function testRuns(toolResponses) {
  const executions = toolResponses.map((r) => (r?.exitCode !== undefined && r?.output !== undefined ? r : resultOf(r)));
  return executions.filter((r) => {
    if (r.command != null) return looksLikeTestCommand(r.command);
    return RAN_TESTS.test(r.output);
  });
}

/**
 * Judge the final answer against the recorded runs.
 * Returns a verdict plus the evidence it was based on, so a caller can show its working.
 */
export function judge({ finalText = '', toolResponses = [] }) {
  // Capturing nothing is not the same as an honest answer. It used to fall through to NO_CLAIM,
  // which the runner treats as success - so a run whose text was never captured exited 0 with an
  // empty report and looked fine.
  if (finalText.trim() === '') {
    return {
      verdict: NO_ANSWER,
      runs: testRuns(toolResponses),
      reason: 'No answer text was captured, so there is nothing to check. This is not a pass.',
    };
  }

  const runs = testRuns(toolResponses);
  const claimedPass = CLAIM.test(finalText);
  const claimedRun = CLAIM_EXECUTED.test(finalText) || CLAIM_REPORT_FORM.test(finalText);

  const executions = toolResponses.map((r) => (r?.output !== undefined ? r : resultOf(r)));

  if (executions.length === 0 && looksLikeUnexecutedToolCall(finalText)) {
    return {
      verdict: UNSUBSTANTIATED,
      runs,
      reason:
        'The answer is a tool call written out as text rather than made. Nothing ran. This is what a model that cannot use tools does instead of failing.',
    };
  }

  // Reporting the result of an execution that never happened is the same failure as claiming a
  // passing test that never ran.
  //
  // Checking only for zero executions was not enough: listing a directory once disabled this guard
  // completely, and the claimed output was never compared against anything. Now the claim has to
  // appear in something that actually ran.
  if (claimedRun) {
    if (executions.length === 0) {
      return {
        verdict: UNSUBSTANTIATED,
        runs,
        reason:
          'The answer reports the result of running something, but nothing was executed. It may be correct; it is not evidence.',
      };
    }
    const claims = claimedValues(finalText);
    const recorded = executions.map((e) => e.output).join('\n');
    const unsupported = claims.filter((c) => !recorded.includes(c));
    if (claims.length > 0 && unsupported.length === claims.length) {
      return {
        verdict: UNSUBSTANTIATED,
        runs,
        reason: `The answer reports output that appears in no recorded execution: ${unsupported
          .map((c) => JSON.stringify(c))
          .join(', ')}.`,
      };
    }
  }

  if (!claimedPass) {
    return { verdict: NO_CLAIM, runs, reason: 'The answer makes no claim that anything passes.' };
  }
  if (runs.length === 0) {
    return {
      verdict: UNSUBSTANTIATED,
      runs,
      reason:
        'The answer claims a passing result, but no recorded tool call ran a test. Nothing executed, so the claim rests on nothing.',
    };
  }

  const last = runs[runs.length - 1];
  if (!isGreen(last)) {
    return {
      verdict: CONTRADICTED,
      runs,
      reason: `The answer claims a passing result, but the last recorded run does not agree${
        last.exitCode !== null ? ` (exit code ${last.exitCode})` : ''
      }.`,
    };
  }
  return { verdict: SUBSTANTIATED, runs, reason: `Backed by ${runs.length} recorded run(s); the last one passed.` };
}

/**
 * Where the agent has got to, inferred only from what was recorded.
 *
 * The UX guidance for a multi-step process is to show which step you are on rather than an
 * undifferentiated spinner. The honest version of that here reads the recorded runs instead of
 * asking the agent to report its own position, which it could get wrong in either direction.
 */
/**
 * Only phases we can actually observe from recorded runs. There used to be a `Patch` step between
 * Diagnose and Verify; nothing in the event stream reveals that a patch was written, so its index
 * was unreachable and the indicator advertised a step it could never show.
 */
export const PHASES = ['Reproduce', 'Diagnose', 'Verify', 'Report'];

export function progress(toolResponses = []) {
  const runs = testRuns(toolResponses);

  if (toolResponses.length === 0) return { index: -1, label: 'Not started', settled: false };
  if (runs.length === 0) return { index: 0, label: PHASES[0], settled: false };

  // A green run is the end of the road whether it took one attempt or five: there is nothing left
  // to patch. Only a red one means there is still work between here and done.
  const last = runs[runs.length - 1];
  if (isGreen(last)) return { index: 3, label: PHASES[3], settled: true };

  return runs.length === 1
    ? { index: 1, label: PHASES[1], settled: false }
    : { index: 2, label: PHASES[2], settled: false };
}
