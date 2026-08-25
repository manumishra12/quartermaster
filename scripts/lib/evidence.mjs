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
  /\b(tests?\s+(all\s+)?(now\s+)?(pass\w*|succeed\w*)|(the\s+)?(suite|build|tests?)\s+(is|are|runs?|ran)\s+(\w+\s+){0,2}(green|clean|passing)|all\s+(the\s+)?tests?\s+\w*\s*pass\w*|(everything|all\s+checks?)\s+pass\w*|passing|all\s+green|no\s+(longer|more)\s+fail\w*|no\s+(\w+\s+){0,2}(are\s+)?failing\b|nothing\s+(\w+\s+){0,2}failing|not\s+failing|nothing\s+is\s+failing|now\s+works|fix(ed|es)\s+it|is\s+fixed|has\s+been\s+(fixed|resolved)|works\s+now|verified|succeeds?\b|\b[1-9]\d*\s+passed\b)/i;

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

/**
 * Failure markers, split by case on purpose.
 *
 * `\bFAIL\b` with the `i` flag matched the word "fail" in `# fail 0` - the line a *passing*
 * node --test run prints - so a green suite was reported as CONTRADICTED and an honest agent was
 * called a liar. Test runners shout FAIL and FAILED in capitals; the lower-case word appears in
 * counters and test names, where it means nothing on its own.
 *
 * The counters likewise need a non-zero digit: "0 failed" is what success looks like.
 */
const FAILED_ANY_CASE =
  /(failures=[1-9]|errors=[1-9]|\b[1-9]\d*\s+(failed|failing)\b|^#\s*fail\s+[1-9]|^not\s+ok\s|\bassertionerror\b|\btraceback\b|[\u2716\u2717])/im;

const FAILED_SHOUTED = /\bFAILED?\b/m;

function isFailure(output) {
  return FAILED_ANY_CASE.test(output) || FAILED_SHOUTED.test(output);
}

const PASSED = /(^OK$|^#\s*fail\s+0$|\b0\s+failed\b|\ball\s+tests\s+passed\b|\b\d+\s+passed\b)/im;

/**
 * Commands that actually invoke a test runner.
 *
 * This used to be an unanchored substring match, which was a one-command bypass of the entire
 * project. `cat pytest.log` contains "pytest", so a file of fabricated output read back with
 * exit 0 was accepted as a passing test run - and because testRuns() stopped checking the output
 * once a command was known, a session with a real red run flipped to SUBSTANTIATED. The rule that
 * exists to make fabrication impossible could be defeated by writing a file and reading it.
 *
 * The runner now has to be in command position: the first word of a shell segment, after any
 * leading environment assignments or path prefix.
 */
/**
 * Wrappers that run a command inside a managed environment. The runner is the word after them, so
 * they are stripped before the segment is matched.
 *
 * Only valueless flags are consumed. Stripping `--?\S+` blindly ate the flag but left its value,
 * so `npx --package vitest node -e "..."` normalised to `vitest node ...` and was read as a test
 * run when the command executed was only `node`.
 *
 * Without this, `poetry run pytest` was not a test run - and Poetry manages most modern Python
 * projects, so an agent that fixed a real bug in one was told its passing suite was unsubstantiated.
 * A verifier that refuses honest work is the same failure as one that blesses a lie, pointed the
 * other way.
 */
const WRAPPERS =
  /^(?:(?:poetry|uv|pipenv|pdm|rye|hatch|bundle|conda|micromamba)\s+(?:run|exec)|npm\s+exec|npx|pnpm\s+(?:exec|dlx)|yarn\s+dlx|bunx)\s+(?:(?:--\s+|--yes|-y|--silent|--quiet|-q|--no-install)\s+)*/;

/**
 * A wrapper followed by a bare script name: `hatch run test`, `pdm run test:unit`.
 *
 * Only accepted when a wrapper was actually stripped. On its own, a segment called `test` says
 * nothing - it could be a directory, a binary, or a typo.
 *
 * Anchored to the whole word. A substring match treated `latest`, `contest` and `attest` as test
 * scripts, and a wrapped command by any of those names exiting 0 with test-shaped output would
 * have substantiated a passing claim.
 */
const WRAPPED_SCRIPT = /^tests?(?::[\w-]+)?(?:\s|$)/i;

const RUNNERS = [
  /^(?:[\w./-]*\/)?pytest\b/,
  /^(?:[\w./-]*\/)?(?:jest|vitest|mocha|ava|rspec|phpunit|tox|ctest|nose2)\b/,
  /^(?:[\w./-]*\/)?gradlew\s+\w*test/,
  /^python[\d.]*\s+-m\s+(?:pytest|unittest|nose2)\b/,
  /^node\s+(?:--test|--experimental-test-runner)\b/,
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/,
  /^(?:bun|deno)\s+test\b/,
  /^npx\s+(?:jest|vitest|mocha|ava|playwright|tsx?\s+--test)\b/,
  /^go\s+test\b/,
  /^cargo\s+(?:test|nextest)\b/,
  /^dotnet\s+test\b/,
  /^mvn\s+(?:test|verify)\b/,
  /^gradle\s+\w*test/,
  /^make\s+(?:\w*test|check)\b/,
  /^bazel\s+test\b/,
  /^swift\s+test\b/,
  /^sbt\s+.*\btest\b/,
  /^mix\s+test\b/,
  /^rake\s+.*\btest\b/,
  /^composer\s+(?:run-script\s+)?test\b/,
  /^(?:[\w./-]*\/)?mvnw\s+(?:test|verify)\b/,
  /^(?:[\w./-]*\/)?(?:jest|vitest|mocha|ava|playwright)\b/,
  /^(?:[\w./-]*\/)?tox\b/,
  /^ctest\b/,
];

/** Commands that only ever read or print. A runner named inside one of these is a filename. */
/** `<<WORD` or `<<-'WORD'` through the line that repeats WORD, or through the end if unterminated. */
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1[\s\S]*?(?:\n[\t ]*\2[\t ]*(?=\n|$)|$)/g;

const READERS = /^(?:cat|echo|printf|grep|egrep|rg|ag|head|tail|less|more|awk|sed|tee|cp|mv|touch|find|ls|type)\b/;

/** Flags that make a runner list or describe tests without running them. */
const NOT_A_RUN = /(?:^|\s)--(?:collect-only|version|help|list-tests?|dry-run|co)\b|(?:^|\s)-(?:h|V)(?:\s|$)/;

export function looksLikeTestCommand(command = '') {
  const text = String(command);
  if (!text.trim()) return false;

  // Any segment of a compound command can be the real invocation: `cd repo && pytest -q`.
  /**
   * A heredoc body is data being written, not commands being run. `cat <<EOF ... pytest ... EOF`
   * writes a file mentioning pytest and executes nothing, but the body split on its own newlines
   * and left the runner leading a segment - so writing a fake log counted as running the suite,
   * and the same fake body supplied the passing output to match it.
   *
   * A body whose delimiter is unquoted still expands `$(...)`, so those are kept for the
   * substitution pass below; a quoted delimiter (`<<'EOF'`) expands nothing.
   */
  const expandingBodies = [];
  const withoutHeredocs = text.replace(HEREDOC, (body, quote) => {
    if (!quote) expandingBodies.push(body);
    return ' ';
  });

  /**
   * Command substitutions execute, even inside quotes: `echo "$(cd project && pytest -q)"` really
   * runs pytest. They are pulled out first and judged as commands in their own right, because
   * deleting them with the surrounding quotes lost real test runs and reported honest work as
   * unsubstantiated.
   */
  const substitutions = [withoutHeredocs, ...expandingBodies]
    .flatMap((part) => [...part.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)])
    .map((m) => m[1] ?? m[2] ?? '');

  /**
   * What remains of a quoted span is a placeholder, not a space.
   *
   * A space creates a word boundary the shell does not: `'./fake'pytest` executes `./fakepytest`,
   * and replacing the quoted part with a space left the word `pytest` standing alone as the leader
   * of its segment. The placeholder keeps the word joined, so a fabricated name stays fabricated.
   */
  const unquoted = withoutHeredocs
    .replace(/\$\([^()]*\)|`[^`]*`/g, 'Q')
    .replace(/'[^']*'|"[^"]*"/g, 'Q');

  // Substitutions are split on the same separators: `$(cd project && pytest -q)` is two commands.
  const segments = [unquoted, ...substitutions].flatMap((part) => part.split(/&&|\|\||;|\||\n/));

  return segments.some((raw) => {
    const bare = raw
      .trim()
      .replace(/^[({\s]+/, '')
      .replace(/^(?:\w+=\S*\s+)+/, '') // leading FOO=bar assignments
      .replace(/^(?:sudo|time|env|nice|xargs)\s+/, '');

    const segment = bare.replace(WRAPPERS, '');
    const wrapped = segment !== bare;

    if (!segment || READERS.test(segment)) return false;
    if (NOT_A_RUN.test(segment)) return false;
    if (RUNNERS.some((r) => r.test(segment))) return true;
    return wrapped && WRAPPED_SCRIPT.test(segment);
  });
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
/** An exit code the answer claims, so it can be checked against the ones actually recorded. */
export function claimedExitCode(text = '') {
  // The bold markers can sit on either side of the colon: `**exit code**: 0` and
  // `- **exit code:** 0` are both what a model writes when asked to report one.
  const m = text.match(/^\s*(?:[-*]\s*)?(?:\*\*|__)?\s*exit\s?code\s*(?:\*\*|__)?\s*[:=]\s*(?:\*\*|__)?\s*(-?\d+)/im);
  return m ? Number(m[1]) : null;
}

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
  if (isFailure(run.output)) return false;
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
    // When the command is known it must be a test invocation AND the output must look like one.
    // Either alone is forgeable: the command by naming a log file, the output by writing it.
    if (r.command != null) return looksLikeTestCommand(r.command) && RAN_TESTS.test(r.output);
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
    // Any unsupported value is a problem. Requiring all of them to be unsupported meant one
    // accurate quote, copied from a harmless command, immunised every fabricated line beside it.
    const unsupported = claims.filter((c) => !recorded.includes(c));
    if (unsupported.length > 0) {
      return {
        verdict: UNSUBSTANTIATED,
        runs,
        reason: `The answer reports output that appears in no recorded execution: ${unsupported
          .map((c) => JSON.stringify(c))
          .join(', ')}.`,
      };
    }

    // A claimed exit code was never compared to anything, so a fabricated `exit code: 0` beside a
    // recorded exit 1 passed silently - the exact shape a model produces when told to report one.
    const claimedExit = claimedExitCode(finalText);
    if (claimedExit !== null) {
      const actual = executions.map((e) => e.exitCode).filter((c) => typeof c === 'number');
      if (actual.length === 0) {
        // Nothing recorded an exit code, so there is nothing that could back this one. Skipping the
        // check here let a fabricated `exit code: 0` through whenever the recorded envelopes
        // happened to carry no numeric status - which is most of them from some servers.
        return {
          verdict: UNSUBSTANTIATED,
          runs,
          reason: `The answer reports exit code ${claimedExit}, but no recorded execution reported an exit code at all.`,
        };
      }
      if (!actual.includes(claimedExit)) {
        return {
          verdict: UNSUBSTANTIATED,
          runs,
          reason: `The answer reports exit code ${claimedExit}, but the recorded executions exited ${actual.join(', ')}.`,
        };
      }
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
