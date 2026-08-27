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

/**
 * Whether the answer is talking about tests at all.
 *
 * The pass-claim rules were written for an agent that fixes failing tests and applied to all seven.
 * "Resolved" is Sentry's own vocabulary and "verified" is ordinary for a research agent, so honest
 * answers like "the alert has been resolved on its own at 14:02" were demanded to produce a test
 * run and reported as fabrications when they could not.
 *
 * Calling an honest agent a liar is the same failure as blessing a lie. A claim now only has to be
 * backed by a test run when it is about tests, or when a test was actually attempted.
 *
 * The line runs between two kinds of claim, not two kinds of agent. "All checks pass" and "the
 * build is green" assert a mechanical result somebody could have watched happen, so they owe
 * evidence wherever they appear; "resolved", "verified" and "works now" are ordinary English about
 * the world and do not. This has to stay in step with CLAIM below - the first version of it did
 * not, so an agent could say "all checks pass" after running nothing test-shaped and be waved
 * through as making no claim at all. Widening it to bare nouns then broke the other direction:
 * "I verified the product specs against the documentation" is a research finding, not a test
 * claim. Build, spec, coverage, lint and check only count next to a result - green, clean,
 * passing, failing - because that is what turns a noun into an assertion about a run. `claims and their evidence stay in step` holds the two
 * together, and any phrase added to one is added there too.
 */
const ABOUT_TESTS =
  /\b(tests?|pytest|jest|vitest|unittest|CI)\b|\b(?:the\s+)?(?:build|suite|specs?|coverage|lint|typecheck|checks?)\s+(?:(?:is|are|was|were|now|all|still|again|currently)\s+){0,3}(?:green|clean|passing|passed|pass\w*|red|failing|failed)\b|\ball\s+checks?\s+pass\w*\b|\ball\s+green\b|\beverything\s+pass\w*\b|\b[1-9]\d*\s+(?:tests?\s+)?passed\b/i;

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
const READERS = /^(?:cat|echo|printf|grep|egrep|rg|ag|head|tail|less|more|awk|sed|tee|cp|mv|touch|find|ls|type)\b/;

/** Flags that make a runner list or describe tests without running them. */
const NOT_A_RUN = /(?:^|\s)--(?:collect-only|version|help|list-tests?|dry-run|co)\b|(?:^|\s)-(?:h|V)(?:\s|$)/;

/**
 * Heredoc redirections on one line, in the order the shell will consume their bodies.
 *
 * The delimiter is a word, not an identifier, and quoting it is what turns expansion off: `<<EOF`,
 * `<<-'EOF-1'` and `<<E"OF"` are all valid and only the first expands. A pattern that insisted on
 * a bare or fully quoted identifier missed the other two entirely, leaving their bodies to be read
 * as commands.
 */
/** The ANSI-C escapes bash decodes inside `$'...'`. Returns the character and the index consumed to. */
function decodeAnsiEscape(line, at) {
  const c = line[at];
  const simple = { n: '\n', t: '\t', r: '\r', e: '\u001b', a: '\u0007', b: '\b', f: '\f', v: '\v', '0': '\0' };
  if (c === 'x') {
    const hex = line.slice(at + 1).match(/^[0-9a-fA-F]{1,2}/);
    if (hex) return [String.fromCharCode(parseInt(hex[0], 16)), at + hex[0].length];
  }
  const octal = line.slice(at).match(/^[0-7]{1,3}/);
  if (octal && c !== '0') return [String.fromCharCode(parseInt(octal[0], 8)), at + octal[0].length - 1];
  return [simple[c] ?? c, at];
}

/**
 * Quoted characters, blanked but not removed.
 *
 * Splitting on separators without regard for quoting read `echo "x;false && $(pytest -q)"` as
 * control flow and discarded a substitution the shell really runs. Each quoted character becomes a
 * placeholder of the same width, so positions still line up with the original and the text can be
 * sliced back out of it intact.
 */
function maskQuoted(text) {
  const out = [...text];
  let quote = null;
  for (let i = 0; i < out.length; i += 1) {
    const c = out[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else out[i] = 'Q';
      continue;
    }
    if (c === '\\') {
      if (i + 1 < out.length) out[i + 1] = 'Q';
      i += 1;
      continue;
    }
    if (c === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (c === "'") {
      quote = "'";
      continue;
    }
    if (quote === '"') out[i] = 'Q';
  }
  return out.join('');
}

/**
 * The status of an operand, when the shell would know it without running anything.
 *
 * Comparing the operand to the bare words missed the ways they are ordinarily written: `(false)`
 * groups it, `{ false; }` groups it differently, and `! true` inverts it. Each of those kept a
 * pytest in a branch that never runs, where an echoed marker supplied the passing output. Anything
 * that is not one of the two words after unwrapping is unknown, which runs.
 */
function literalStatus(operand) {
  let text = operand.trim();
  let negations = 0;

  for (let guard = 0; guard < 8; guard += 1) {
    if (text.startsWith('!')) {
      negations += 1;
      text = text.slice(1).trim();
      continue;
    }
    const grouped = /^\((.*)\)$/s.exec(text) ?? /^\{(.*)\}$/s.exec(text);
    // Only unwrap a group that closes at the end: `(a) && (b)` is not one group.
    if (grouped && isBalanced(grouped[1])) {
      text = grouped[1].replace(/;\s*$/, '').trim();
      continue;
    }
    break;
  }

  if (text !== 'true' && text !== 'false') return 'unknown';
  const value = negations % 2 === 0 ? text === 'true' : text !== 'true';
  return value ? 'success' : 'failure';
}

function isBalanced(text) {
  let depth = 0;
  for (const c of text) {
    if (c === '(' || c === '{') depth += 1;
    else if (c === ')' || c === '}') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * The operands of one and-or list that the shell would actually reach.
 *
 * What decides this is the status of the list so far, not the operand immediately before: in
 * `false && echo skipped && pytest -q` the whole chain is dead, and checking only each operand's
 * predecessor kept the pytest. Statuses that cannot be read are left unknown, which runs
 * everything - guessing at `$GUARD && pytest` would discard real work.
 */
function liveOperands(code, masked, from, to) {
  const breaks = [];
  let depth = 0;
  for (let i = from; i < to - 1; i += 1) {
    const c = masked[i];
    if (c === '(' || c === '{') depth += 1;
    else if (c === ')' || c === '}') depth -= 1;
    if (depth > 0) continue;
    const pair = masked.slice(i, i + 2);
    if (pair === '&&' || pair === '||') {
      breaks.push({ at: i, operator: pair });
      i += 1;
    }
  }

  const operands = [];
  let start = from;
  for (const brk of breaks) {
    operands.push({ start, end: brk.at, operator: brk.operator });
    start = brk.at + 2;
  }
  operands.push({ start, end: to, operator: null });

  const kept = [];
  let status = 'unknown';
  let skipping = false;

  for (const operand of operands) {
    const text = code.slice(operand.start, operand.end);
    if (!skipping) {
      kept.push(text);
      status = literalStatus(masked.slice(operand.start, operand.end));
    }
    // A skipped operand runs nothing, so it cannot change the status the next operator reads.
    if (operand.operator === '&&') skipping = status === 'failure';
    else if (operand.operator === '||') skipping = status === 'success';
  }

  return kept;
}

/** Drop the branches a literal guard makes unreachable. `;` and a newline start a new list. */
function reachableBranches(code, depthLimit = 4) {
  const masked = maskQuoted(code);
  const kept = [];
  let from = 0;
  let depth = 0;

  for (let i = 0; i <= masked.length; i += 1) {
    const c = masked[i];
    if (c === '(' || c === '{') depth += 1;
    else if (c === ')' || c === '}') depth -= 1;
    // A separator inside a group belongs to the group: `{ false; }` is one operand, not two.
    if (depth > 0) continue;
    if (i === masked.length || c === ';' || c === '\n') {
      kept.push(...liveOperands(code, masked, from, i));
      from = i + 1;
    }
  }

  return kept
    .map((operand) => {
      // A group is a list in its own right, so what is unreachable inside it is unreachable.
      const inner = /^\s*[({](.*)[)}]\s*$/s.exec(operand);
      if (!inner || depthLimit <= 0 || !isBalanced(inner[1])) return operand;
      return reachableBranches(inner[1], depthLimit - 1);
    })
    .join('\n');
}

function heredocsOn(line) {
  const docs = [];
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (c === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (c === "'" && quote === null) {
      quote = "'";
      continue;
    }
    if (quote !== null) continue;

    // `<<<` is a here-string: one line of data, no terminator, so nothing to skip.
    if (c === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
      let j = i + 2;
      const stripTabs = line[j] === '-';
      if (stripTabs) j += 1;
      while (line[j] === ' ' || line[j] === '\t') j += 1;

      let delim = '';
      let quoted = false;
      let inner = null;
      // `$'...'` also decodes escapes, so `<<$'E\\x4fF'` is the delimiter EOF. Carrying the
      // characters through undecoded produced Ex4fF, which the real terminator never matched -
      // and everything after it, including genuine commands, was eaten as heredoc data.
      let ansi = false;
      for (; j < line.length; j += 1) {
        const d = line[j];
        if (inner) {
          if (d === inner) inner = null;
          else delim += d;
          continue;
        }
        // `<<$'EOF'` is ANSI-C quoting: the delimiter is EOF, not $EOF. Keeping the dollar meant
        // the real terminator never matched and the commands after it were eaten as data.
        if (d === '$' && (line[j + 1] === "'" || line[j + 1] === '"')) {
          ansi = line[j + 1] === "'";
          continue;
        }
        if (d === "'" || d === '"') {
          inner = d;
          quoted = true;
          continue;
        }
        if (d === '\\') {
          quoted = true;
          j += 1;
          if (j >= line.length) continue;
          if (!ansi) {
            delim += line[j];
            continue;
          }
          const [decoded, next] = decodeAnsiEscape(line, j);
          delim += decoded;
          j = next;
          continue;
        }
        if (/[\s;|&<>()]/.test(d)) break;
        delim += d;
      }
      if (delim) docs.push({ delim, stripTabs, expands: !quoted });
      i = j - 1;
    }
  }
  return docs;
}

/**
 * A terminator is the delimiter alone on its line. Leading tabs are stripped only for `<<-`, and
 * leading spaces never are - accepting them let a space-indented word end the body early and
 * expose the rest of the data as commands.
 */
function isTerminator(line, doc) {
  return (doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delim;
}

/**
 * Split a command into the lines the shell executes and the heredoc bodies it only reads.
 *
 * A heredoc body is data being written, not commands being run. `cat <<EOF ... pytest ... EOF`
 * writes a file mentioning pytest and executes nothing, but read as code the body supplies both
 * halves of a fabricated proof: a line that looks like an invocation and a line that looks like
 * its passing output. Bodies are consumed in the order their redirections appear, which a single
 * pattern cannot do - `cat <<A <<B` has two of them, and matching the first swallowed only as far
 * as A and handed B's body back as code.
 */
function splitHeredocs(text) {
  const lines = String(text).split('\n');
  const code = [];
  const expandingBodies = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    code.push(line);
    i += 1;
    for (const doc of heredocsOn(line)) {
      const body = [];
      while (i < lines.length && !isTerminator(lines[i], doc)) {
        body.push(lines[i]);
        i += 1;
      }
      // Past the terminator, or past the end when the body is never closed.
      i += 1;
      // An unquoted delimiter still expands `$(...)` inside the body; a quoted one expands nothing.
      if (doc.expands) expandingBodies.push(body.join('\n'));
    }
  }

  return { code: code.join('\n'), expandingBodies };
}

/**
 * The command substitutions the shell would actually run.
 *
 * Matching `$(...)` with a regex found the ones that never execute. Single quotes suppress
 * expansion entirely and a backslash suppresses the next character, so `echo '$(pytest -q) 1
 * passed'` and `echo "\\$(pytest -q) 1 passed"` print that text and run nothing - yet both were
 * read as pytest invocations, and their echoed "1 passed" then supplied the passing output to
 * match. Quoting is state, not a pattern, so this walks the string and tracks it.
 */
function expandedSubstitutions(text) {
  const found = [];
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];

    // Inside single quotes nothing expands and a backslash is an ordinary character.
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (c === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (c === "'" && quote === null) {
      quote = "'";
      continue;
    }

    // Double quotes still expand, so this runs whether or not we are inside them.
    if (c === '$' && text[i + 1] === '(') {
      // `$((...))` is arithmetic, not a command: bash evaluates `$((pytest))` as a variable and
      // runs nothing. Counted as a substitution it produced the segment `pytest)`, which reads as
      // an invocation, and an echoed "1 passed" beside it completed the forgery.
      if (text[i + 2] === '(') {
        // Arithmetic runs no command of its own, but it can contain one: the substitution in
        // `echo $(( $(pytest -q; echo 0) + 1 ))` really executes. Skipping the whole region lost
        // it, so only the arithmetic punctuation is skipped and the inside is scanned.
        const close = text.indexOf('))', i + 3);
        const end = close === -1 ? text.length : close;
        found.push(...expandedSubstitutions(text.slice(i + 3, end)));
        i = close === -1 ? text.length : close + 1;
        continue;
      }
      let depth = 1;
      let j = i + 2;
      // Parentheses inside quotes are data. Counting them truncated the body of
      // `$(printf ')' && pytest -q)` at the printf argument and lost a genuine run. The same is
      // true of a parenthesis inside a heredoc body, so those are stepped over here too.
      let inner = null;
      let heredoc = null;
      for (; j < text.length && depth > 0; j += 1) {
        const d = text[j];
        if (inner) {
          if (d === '\\' && inner === '"') j += 1;
          else if (d === inner) inner = null;
          continue;
        }
        if (heredoc) {
          // Inside a body nothing counts until the terminator line closes it.
          if (d === '\n') {
            const nl = text.indexOf('\n', j + 1);
            const line = text.slice(j + 1, nl === -1 ? text.length : nl);
            if (isTerminator(line, heredoc)) {
              heredoc = null;
              j = nl === -1 ? text.length : nl;
            }
          }
          continue;
        }
        if (d === '<' && text[j + 1] === '<' && text[j + 2] !== '<') {
          const rest = text.slice(j, text.indexOf('\n', j) === -1 ? text.length : text.indexOf('\n', j));
          [heredoc = null] = heredocsOn(rest);
          continue;
        }
        if (d === "'" || d === '"') inner = d;
        else if (d === '\\') j += 1;
        else if (d === '(') depth += 1;
        else if (d === ')') depth -= 1;
        if (depth === 0) break;
      }
      found.push(text.slice(i + 2, j));
      i = j;
      continue;
    }
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      if (end === -1) continue;
      found.push(text.slice(i + 1, end));
      i = end;
    }
  }
  return found;
}

/**
 * Whether a recorded command is a test invocation.
 *
 * The limit worth stating plainly: this reads a command, it does not execute one, and a shell
 * decides at runtime what a reader cannot decide at all. `$GUARD && pytest` may or may not run
 * pytest and nothing here can know which. Only literal guards are resolved, because guessing at
 * the rest would start discarding honest runs - and calling honest work a lie is the same failure
 * as blessing a lie.
 *
 * What makes that limit tolerable is that this is one of two signals, not the whole of the
 * evidence: `testRuns()` requires the command to look like a test *and* the output to look like
 * one, so neither a fabricated command nor fabricated output is sufficient alone.
 */
export function looksLikeTestCommand(command = '') {
  const text = String(command);
  if (!text.trim()) return false;

  /**
   * Everything the shell would execute, unwrapped until nothing new appears.
   *
   * Substitutions run, and what is inside one is a command in its own right - which can be another
   * substitution, or a heredoc, or both. Handling one level meant a construction nested one deeper
   * slipped past: `echo "$(cat <<EOF ... pytest ... 1 passed ... EOF)"` hid a body from the
   * outer pass and offered it back as commands. So each part is put through the same treatment
   * until the worklist runs dry.
   */
  const segments = [];
  const seen = new Set();
  const queue = [text];

  while (queue.length > 0 && seen.size < 64) {
    const part = queue.shift();
    if (part == null || seen.has(part)) continue;
    seen.add(part);

    // A heredoc body is data being written, not commands being run.
    const { code: written, expandingBodies } = splitHeredocs(part);
    const code = reachableBranches(written);

    // An unquoted delimiter still expands `$(...)` inside the body; a quoted one expands nothing.
    for (const body of expandingBodies) queue.push(...expandedSubstitutions(body));
    queue.push(...expandedSubstitutions(code));

    /**
     * What remains of a quoted span is a placeholder, not a space.
     *
     * A space creates a word boundary the shell does not: `'./fake'pytest` executes
     * `./fakepytest`, and replacing the quoted part with a space left the word `pytest` standing
     * alone as the leader of its segment. The placeholder keeps the word joined, so a fabricated
     * name stays fabricated. Substitution bodies go through this too - they used to be split raw,
     * so `echo "$(echo 'x; pytest') 1 passed"` offered up the quoted text as a second command.
     */
    const collapsed = code
      .replace(/\$\([^()]*\)|`[^`]*`/g, 'Q')
      .replace(/'[^']*'|"[^"]*"/g, 'Q');

    // Any segment of a compound command can be the real invocation: `cd repo && pytest -q`.
    segments.push(...collapsed.split(/&&|\|\||;|\||\n/));
  }

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
/**
 * The tool calls an answer wrote out instead of making, parsed into something readable.
 *
 * A small model that cannot call tools prints the JSON it would have sent, and that blob lands in
 * the transcript, the report and the interface exactly as the model emitted it - four lines of
 * braces where a sentence should be. The verifier already knows this happened; there is no reason
 * for everything downstream to show raw JSON while it does.
 *
 * Returns `[]` when the answer is ordinary prose, so callers can simply ask.
 */
/**
 * The JSON value starting at `from`, ending where its braces balance.
 * Returns null when they never do, so the caller can fall back to its old behaviour.
 */
function balancedFrom(text, from) {
  const open = text[from];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;

  for (let i = from; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
}

export function unexecutedToolCalls(text = '') {
  const candidates = [String(text)];
  for (const [, body] of String(text).matchAll(/```(?:json)?\n([\s\S]*?)```/g)) candidates.push(body);
  for (const [, body] of String(text).matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/gi)) candidates.push(body);

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    const start = trimmed.search(/[{[]/);
    if (start === -1) continue;
    try {
      /**
       * Take the balanced value, not everything to the end of the message.
       *
       * Slicing from the first brace onwards meant any prose after the JSON - which a model
       * usually adds, explaining what the call would do - broke the parse, and a printed call went
       * unrecognised. It worked only when the JSON happened to be fenced.
       */
      const parsed = JSON.parse(balancedFrom(trimmed, start) ?? trimmed.slice(start));
      const calls = (Array.isArray(parsed) ? parsed : [parsed]).filter(
        (c) =>
          c &&
          typeof c === 'object' &&
          typeof c.name === 'string' &&
          /^[a-z][a-z0-9_.-]*$/i.test(c.name) &&
          ('arguments' in c || 'parameters' in c),
      );
      if (calls.length > 0) {
        return calls.map((c) => ({ name: c.name, arguments: c.arguments ?? c.parameters ?? {} }));
      }
    } catch {
      // Not JSON; try the next candidate.
    }
  }
  return [];
}

export function looksLikeUnexecutedToolCall(text = '') {
  /**
   * One parser, not two.
   *
   * This had its own copy of the scan, and the copies drifted the moment the other one learned to
   * read a call with prose after it: the same message was a printed call to `unexecutedToolCalls`
   * and ordinary prose to this. Two implementations of one rule reaching opposite answers is a
   * mistake this codebase has paid for before, with an envelope parser in the interface disagreeing
   * with the one in the verifier.
   */
  return unexecutedToolCalls(text).length > 0;
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

  /**
   * `error` is a result too, and the most important one to keep.
   *
   * The harness reports a failed call as `{"error":[{"type":"text","text":"..."}]}`. Nothing here
   * read that field, so a call that failed came back with empty output and no exit code - which is
   * indistinguishable from a call that ran and printed nothing. A sandbox that failed to start
   * appeared, to every rule downstream, as silence.
   *
   * This is the same defect the project keeps finding elsewhere and it was sitting in the parser
   * the whole verifier is built on: a failure that reads as nothing is a failure nobody is told
   * about.
   */
  const candidates = [inner.result, inner.output, inner.stdout, inner.text];
  /**
   * A call that errored is a different thing from a command that failed.
   *
   * `npm test` exiting 1 is a test run, and a red one - that is how a false pass-claim gets caught.
   * A tool call that errored before anything executed is not a test run at all, and counting it as
   * one would let a sandbox that never started stand in for a suite that never ran.
   */
  const errorValue = inner.error ?? parsed.error;
  const errored = errorValue != null && !candidates.some((c) => typeof c === 'string' && c !== '');
  const value =
    candidates.find((c) => typeof c === 'string' && c !== '') ??
    (errored ? errorValue : undefined) ??
    candidates.find((c) => c != null);
  let output = '';
  let understood = true;
  let structured = false;

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
  } else if (parsed && typeof parsed === 'object') {
    /**
     * An MCP tool that answers with structured data has no wrapper at all - the payload *is* the
     * result: `{"count": 2, "alerts": [...]}`. Looking only for result/output/stdout/text meant
     * every such response read as empty, so for a connector returning JSON the evidence layer saw
     * nothing at all and the smoke runner reported an envelope it could not read.
     *
     * Serialising it back is safe because a command still has to look like a test invocation
     * before any of this counts as a test run - a list of alerts is not a suite.
     */
    output = JSON.stringify(parsed);
    /**
     * Marked, because this text was assembled here rather than printed by anything.
     *
     * A response with no command is classified on its output alone, so serialising an arbitrary
     * payload made `{"summary":"3 passed"}` from any connector look like a passing suite. That is
     * a fabrication path this change opened, and the fix is not to stop reading the payload - the
     * report needs it - but to refuse to treat text nobody printed as evidence that something ran.
     */
    structured = true;
  } else {
    understood = false;
  }

  return { exitCode, output, command, understood, errored, structured };
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

/** The runner and the report disagreed about this once; they share it now. */
function normalise(toolResponses = []) {
  return toolResponses.map((r) => (r?.output !== undefined ? r : resultOf(r)));
}

/**
 * The calls that actually ran.
 *
 * A call the operator refused is still delivered as a tool response, with no output and no exit
 * code - indistinguishable from a command that ran and printed nothing. Counting it as an
 * execution let a refusal strengthen the evidence rather than weaken it: the guard that catches an
 * answer with nothing behind it asks whether anything ran at all, and a denial answered yes. The
 * gate exists to stop things happening, so what it stops cannot be filed under what happened.
 */
export function performed(toolResponses = []) {
  return normalise(toolResponses).filter((r) => !r.denied);
}

/** The calls the operator refused. Worth reporting; never worth counting as evidence. */
export function refused(toolResponses = []) {
  return normalise(toolResponses).filter((r) => r.denied);
}

/**
 * Every recorded execution that is a test run.
 *
 * When the command is known it must look like a test invocation. Classifying on output alone let
 * `echo ok`, a curl header, and a file the agent wrote itself and read back all count as proof.
 */
export function testRuns(toolResponses) {
  return performed(toolResponses).filter((r) => {
    // A call that errored produced no execution to judge, whatever its message happens to contain.
    if (r.errored) return false;
    // When the command is known it must be a test invocation AND the output must look like one.
    // Either alone is forgeable: the command by naming a log file, the output by writing it.
    if (r.command != null) return looksLikeTestCommand(r.command) && RAN_TESTS.test(r.output);
    /**
     * With no command, only text something actually printed can stand in for one. A structured
     * payload was serialised here, so a field reading "3 passed" is a string in somebody's JSON -
     * not a suite reporting its result.
     */
    return !r.structured && RAN_TESTS.test(r.output);
  });
}

/**
 * Judge the final answer against the recorded runs.
 * Returns a verdict plus the evidence it was based on, so a caller can show its working.
 */
/**
 * An answer that presents a source it says it consulted.
 *
 * A quoted sentence beside a URL, or an explicit attribution. This is what a research answer looks
 * like when it is doing its job, and also what it looks like when it is inventing one.
 */
const URL_ANYWHERE = /https?:\/\/[^\s"'<>)\]]+/gi;

/** Saying where something came from, in the ordinary ways people say it. */
const ATTRIBUTION =
  /\b(according to|as reported by|as stated (in|by)|per the|the (page|article|site|source|study|report|paper|documentation|docs)\s+(?:\S+\s+){0,6}?(says|states|found|reports|notes|shows|confirms)|quoted from|cited (in|from))\b|\bsources?\s*:/gi;

/** A quoted span long enough to be a sentence taken from somewhere. */
const QUOTATION = /["“‘][^"”’]{25,}["”’]/g;

/**
 * The words that turn a nearby address into the place a quotation came from.
 *
 * A quotation on its own is not a citation - an answer may be quoting the person who asked, and a
 * link may be sitting beside it for an unrelated reason. "with the URL", "source:", "from", "see"
 * are what make the two one claim.
 */
const INTRODUCES_A_URL = /(\b(with the (url|link|address)|source|from|at|see|available at|found at)\b\W{0,12}|[([]\s*)$/i;

/** How close two spans have to be before they are talking about the same thing. */
const SAME_CLAIM = 240;

/** The gap between two matched spans, which is not the distance between where they start. */
function gapBetween(a, b) {
  const aEnd = a.index + a[0].length;
  const bEnd = b.index + b[0].length;
  return Math.max(0, Math.max(a.index, b.index) - Math.min(aEnd, bEnd));
}

/**
 * Whether the answer claims to have read something from a particular address.
 *
 * Both halves are required and they have to be near each other. A URL on its own is often a
 * suggestion - "you can find it at ..." - and flagging that would be the familiar mistake of
 * calling honest work a lie. Searching the whole answer for each half independently was the
 * mistake in the other direction: "according to the user" in one paragraph and a bare repository
 * link three paragraphs later are not a citation, and reporting them as one would be this tool
 * inventing a claim in order to accuse somebody of inventing a claim.
 *
 * Distance is measured between the spans rather than between their starting points, because a
 * quotation of three hundred characters followed immediately by its own URL is as tight a citation
 * as there is, and comparing where each began called it unrelated.
 */
function claimsASource(text) {
  const body = String(text);
  const urls = [...body.matchAll(URL_ANYWHERE)];
  if (urls.length === 0) return false;

  const stated = [...body.matchAll(ATTRIBUTION)];
  if (stated.some((mark) => urls.some((url) => gapBetween(mark, url) <= SAME_CLAIM))) return true;

  /**
   * A quotation counts only when something introduces the address as its origin. Treating every
   * quoted sentence as a citation accused answers that were quoting the person who asked.
   */
  return [...body.matchAll(QUOTATION)].some((quote) =>
    urls.some(
      (url) =>
        gapBetween(quote, url) <= SAME_CLAIM && INTRODUCES_A_URL.test(body.slice(0, url.index)),
    ),
  );
}

/**
 * Commands that plausibly reached the web.
 *
 * For an MCP call the recorded command is the tool name, which is what makes this readable at all.
 */
const FETCHER = /search|fetch|browse|crawl|wiki|exa|\bweb\b|\bhttp|\burl\b|curl|wget/i;

/**
 * Whether a citation in this answer has anything recorded behind it.
 *
 * Nothing ran at all is the clearest case. The next clearest is that every recorded command was
 * legible and none of them fetched anything - an `ls` does not turn an invented URL into a source,
 * which is what the first version of this allowed by giving up as soon as any call existed.
 *
 * When some command could not be read, this stays quiet. `resultOf` does not understand every
 * connector envelope, and accusing an agent of fabricating because a response was unparseable is
 * the same failure as blessing a lie, pointed the other way.
 *
 * The limit, stated rather than papered over: this establishes that *something* was fetched, not
 * that the cited page was. An answer that searches for one thing and then attributes a claim to a
 * different address passes here. Tying a citation to the fetch that produced it needs the fetched
 * URL, and the recorded command for an MCP call is the tool name - the address is inside a
 * response body this cannot reliably parse. Guessing at it would produce exactly the confident
 * wrong answer this file exists to refuse, so the guard claims only what it can see.
 */
function citationIsUnbacked(executions) {
  if (executions.length === 0) return true;

  const legible = executions.filter((e) => typeof e.command === 'string' && e.command.trim());
  if (legible.length !== executions.length) return false;

  return !legible.some((e) => FETCHER.test(e.command));
}

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

  const executions = performed(toolResponses);

  if (executions.length === 0 && looksLikeUnexecutedToolCall(finalText)) {
    return {
      verdict: UNSUBSTANTIATED,
      runs,
      reason:
        'The answer is a tool call written out as text rather than made. Nothing ran. This is what a model that cannot use tools does instead of failing.',
    };
  }

  /**
   * A source quoted with nothing fetched.
   *
   * This is the fabrication that six of the seven agents can commit, and until now none of them
   * were checked for it: the rules here were written for an agent that claims a test passed, and a
   * research agent does not claim that. Asked to search the web, one of them produced a quotation
   * and a URL with zero tool calls recorded - and the URL was a 404. The verdict was NO CLAIM,
   * because the answer had said nothing about tests.
   *
   * Nothing was executed at all, so there is no question of which source it came from. It came
   * from the model.
   *
   * It also fires when things ran and none of them was a fetch, because an unrelated `ls` does not
   * turn an invented URL into a source. That reads the recorded command - the tool name, for an
   * MCP call - and not the output, which `resultOf` cannot always parse. Where a command is
   * illegible this stays quiet rather than guessing.
   */
  if (claimsASource(finalText) && citationIsUnbacked(executions)) {
    return {
      verdict: UNSUBSTANTIATED,
      runs,
      reason:
        executions.length === 0
          ? 'The answer quotes a source and gives its address, but nothing was fetched - no tool call was recorded at all. The citation came from the model, not from the web.'
          : 'The answer quotes a source and gives its address, but nothing recorded fetched anything. Something ran; none of it went to the web.',
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

  // Claiming success having run nothing at all is unsupported whatever the agent does.
  if (executions.length === 0) {
    return {
      verdict: UNSUBSTANTIATED,
      runs,
      reason: 'The answer claims a passing result, but nothing was executed at all.',
    };
  }

  // Beyond that, only a claim about tests needs a test run behind it. An agent that searched the
  // web and reported what it found has executed something; demanding a test suite of it would be
  // asking for evidence that could not exist.
  const aboutTests =
    ABOUT_TESTS.test(finalText) ||
    // A recorded test run makes the session about tests whatever the words say. Reading only the
    // command missed the runs testRuns() identifies from their output alone, so a failed run with
    // no command attached could be stepped over and the contradiction never checked.
    runs.length > 0 ||
    executions.some((e) => e.command && looksLikeTestCommand(e.command));
  if (!aboutTests) {
    return {
      verdict: NO_CLAIM,
      runs,
      /**
       * This said the claim was "backed by a recorded execution", which it had not checked and
       * frequently was not true: `ls` does not back "it works now". Nothing here correlates a
       * non-test claim with a command, and claiming to would be the exact failure this tool
       * exists to catch. It reports the limit of the check instead.
       */
      reason:
        'The answer makes no claim about tests. This check reads test results only, so it has nothing to say about the claim it does make - that is a limit of the check, not a pass.',
    };
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
