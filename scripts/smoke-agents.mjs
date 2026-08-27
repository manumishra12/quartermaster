/**
 * Runs every credential-free agent against the real harness and checks what was recorded.
 *
 * The point is not that the agent said the right thing. It is that the harness recorded an
 * execution matching what was asked. Same rule as the evidence check: the transcript is the
 * agent's account, the event stream is what happened.
 *
 *   npm run smoke
 *   npm run smoke -- --agent analytics
 */
import { TrueForge, isEventDelta } from '@truefoundry/trueforge-sdk';
import { resultOf, unexecutedToolCalls } from './lib/evidence.mjs';
import { loadEnv } from './lib/env.mjs';

loadEnv();

const BASE = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';
const argv = process.argv.slice(2);
/** A flag given as the final argument has no value; that must be an error, not a silent NaN. */
function flagValue(name) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`--${name} needs a value`);
    process.exit(2);
  }
  return value;
}

const only = flagValue('agent');
/**
 * A per-case budget. Without one, a slow or stuck model turns the whole suite into a hang, which
 * is indistinguishable from a broken harness and useless in CI.
 */
const budgetArg = flagValue('budget');
/**
 * 180 seconds suits an unloaded machine. A small local model on a busy one takes minutes per turn,
 * so the limit is raisable rather than fixed - a slow machine is not a broken agent, and a suite
 * that cannot tell the difference is not worth running.
 */
const BUDGET_SECONDS = budgetArg === null ? Number(process.env.SMOKE_BUDGET_SECONDS ?? 180) : Number(budgetArg);
if (!Number.isFinite(BUDGET_SECONDS) || BUDGET_SECONDS <= 0) {
  // Name the one that was actually set. Reporting --budget when the environment variable was wrong
  // prints a value nobody typed and hides the setting that needs changing.
  const [where, value] =
    budgetArg === null ? ['SMOKE_BUDGET_SECONDS', process.env.SMOKE_BUDGET_SECONDS] : ['--budget', budgetArg];
  console.error(`${where} must be a positive number of seconds, got ${JSON.stringify(value)}`);
  process.exit(2);
}
const BUDGET_MS = BUDGET_SECONDS * 1000;

/**
 * Prompts are deliberately direct and single-step. This is a test of the harness wiring - can this
 * agent reach its tools at all - not of how cleverly a model decomposes a task.
 */
const CASES = [
  {
    agent: 'quartermaster-local',
    what: 'reaches the sandbox',
    prompt: "Use the sandbox shell to run exactly: echo quartermaster-reached-the-sandbox",
    expect: /quartermaster-reached-the-sandbox/,
  },
  {
    agent: 'code-runner',
    what: 'executes submitted code',
    /**
     * Quoted, because the unquoted version was not a command.
     *
     * This was kept quote-free on the theory that it isolated wiring from parsing. It did the
     * opposite: parentheses are shell metacharacters, so `python3 -c print(9*9)` is a bash syntax
     * error, and the case asked the agent to run something that could never work. The agent did
     * exactly as it was told and the test called that a failure to reach its tools.
     */
    prompt: "Use the sandbox shell to run exactly: python3 -c 'print(9*9)'",
    expect: /(?:^|\n)81(?:\n|$)/,
  },
  {
    agent: 'analytics',
    what: 'builds the warehouse and queries it',
    // Through Python's bundled sqlite3, because the sandbox has no database command line. The
    // original case piped into a `sqlite3` binary that is not installed, so it established only
    // that the shell could report command-not-found.
    prompt:
      'Use the sandbox shell to run exactly: python3 -c "import sqlite3;print(sqlite3.connect(\':memory:\').execute(\'select 7\').fetchone()[0])"',
    expect: /(?:^|\n)7(?:\n|$)/,
  },
  {
    agent: 'research-desk',
    what: 'reaches the web through a connector',
    prompt: 'Search the web for "TrueFoundry TrueForge agent harness" and quote one sentence from a result, with its URL.',
    // A URL in the recorded output is the evidence that something was actually fetched. The old
    // assertion was /\w{20,}/, which any sentence of prose satisfies - so the case reported
    // "reaches the web through Exa" without establishing that it had reached anything.
    expect: /https?:\/\/[^\s"']+/,
  },
  {
    agent: 'incident-responder',
    what: 'reads the ops desk',
    // The read path only. What happens when it proposes a remediation is the approval gate, and
    // that is a pause rather than an execution - a smoke runner that streams to completion would
    // sit on it until the budget ran out and call the gate a failure.
    prompt: 'List the firing alerts on the ops desk and tell me the id of the one on checkout-api.',
    /**
     * A field only a real alert carries, not just the id.
     *
     * Matching the id alone passed on a *failed* call: a not-found payload lists the ids it knows,
     * so `get_alert("nonsense")` came back containing ALRT-4471 and the case reported that firing
     * alerts had been listed. The assertion has to be something only a successful read produces.
     */
    expect: /"first_seen"[\s\S]*ALRT-4471|ALRT-4471[\s\S]*"first_seen"/,
  },
  {
    agent: 'desk-assistant',
    what: 'reads the front desk',
    prompt: 'List the projects on the front desk and tell me the key of the checkout project.',
    // Likewise: `convention` appears on a real project and never in a not-found payload's id list.
    expect: /"convention"[\s\S]*CHK|CHK[\s\S]*"convention"/,
  },
];

const client = new TrueForge({ baseUrl: BASE, timeoutInSeconds: 900 });

/**
 * A sandbox that was not ready yet, rather than an agent that could not reach it.
 *
 * `fork/exec /usr/bin/bash: no such file or directory` with exit -1 is the sandbox filesystem not
 * mounted at the moment the command ran - bash is plainly there, since another case used it a
 * minute earlier. Reporting that as "the agent never reached its tools" sends someone to check
 * the agent, the connector and the model, none of which is wrong.
 */
function sandboxNotReady(recorded) {
  /**
   * Narrow on purpose. "no such file or directory" on its own is ordinary stderr from a command
   * that referenced a missing path - matching it made every such failure look like a harness
   * problem, and the retry could then report success "after one retry" for something the agent
   * genuinely got wrong. A fork/exec failure of the shell itself is the signature that means the
   * sandbox filesystem was not mounted when the command ran.
   */
  return recorded.some((r) => /fork\/exec|sandbox (is )?not ready|failed to (start|create) sandbox/i.test(r.output ?? ''));
}

async function runCase(testCase) {
  const started = Date.now();
  let session;
  try {
    ({ data: session } = await client.sessions.create({ agent: { name: testCase.agent } }));
  } catch (err) {
    return { ...testCase, ok: false, why: `agent not applied (${err?.body?.error?.message ?? err.message})` };
  }

  const recorded = [];
  /** What the model said, so a call it printed instead of making can be named as such. */
  let said = '';
  let status;
  let timedOut = false;

  const drain = async () => {
    const stream = await client.sessions.createTurnStream(session.id, {
      input: [{ type: 'user.message', content: testCase.prompt }],
    });
    for await (const { data: event } of stream.withMetadata()) {
      if (isEventDelta(event)) continue;
      if (event.type === 'tool.response') recorded.push(resultOf(event));
      if (event.type === 'model.message') said += event.content ?? '';
      if (event.type === 'turn.done') status = event.state?.status;
    }
  };

  let timer;
  try {
    await Promise.race([
      drain(),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, BUDGET_MS);
      }),
    ]);
  } catch (err) {
    return { ...testCase, ok: false, why: `turn failed: ${err.message}` };
  } finally {
    clearTimeout(timer);
    // The turn keeps running on the server after we stop reading, so tell it to stop.
    if (timedOut) await client.sessions.cancel(session.id).catch(() => {});
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(0);

  if (timedOut && recorded.length === 0) {
    /**
     * What this can honestly say is that no tool *response* arrived. The runner only reads
     * tool.response events, so a call that was made and is still pending, blocked on approval, or
     * cancelled before it answered looks identical to a call that was never made - and telling
     * somebody the agent never called anything sends them to check the model, which may be fine.
     */
    return {
      ...testCase,
      ok: false,
      seconds,
      why: `no tool response within ${BUDGET_MS / 1000}s - turn cancelled. The call may never have been made, or may have been waiting on something`,
    };
  }
  /**
   * The model wrote the call out instead of making it.
   *
   * This is a specific, diagnosable thing and not the same as "nothing happened": the command is
   * usually correct, and what failed is the emission. Saying "no tool response was recorded" sends
   * somebody to check the wiring, which is fine. It is the model.
   */
  const printed = unexecutedToolCalls(said);
  if (recorded.length === 0 && printed.length > 0) {
    return {
      ...testCase,
      ok: false,
      seconds,
      printedCall: true,
      why: `the model printed the ${printed.map((c) => c.name).join(', ')} call as text instead of making it - the wiring is fine, the emission is not`,
    };
  }

  if (recorded.length === 0) {
    return { ...testCase, ok: false, seconds, why: 'no tool response was recorded - nothing the agent did produced a result' };
  }
  if (sandboxNotReady(recorded)) {
    return {
      ...testCase,
      ok: false,
      seconds,
      sandbox: true,
      why:
        'the sandbox was not ready when the command ran - this is the harness, not the agent\n' +
        recorded.map((r, i) => `                       [${i}] exit ${r.exitCode} ${JSON.stringify((r.output ?? '').slice(0, 120))}`).join('\n'),
    };
  }

  /**
   * A tool response that carries no result at all.
   *
   * Every recorded execution with a null exit code and empty output means the harness logged the
   * call and never got an answer back - a turn cut short, usually because the machine is loaded
   * and the model timed out mid-call. Reporting that as "none matched /regex/" points whoever
   * reads it at the assertion, which is the one thing that is definitely not wrong.
   */
  if (recorded.every((r) => r.exitCode === null && !(r.output ?? '').trim())) {
    /**
     * Two different problems wear the same face, and only one of them is about the machine.
     *
     * `resultOf` marks a response it could not parse as not understood. Calling that "the turn was
     * cut short" is a reassuring diagnosis that sends nobody to the actual fault - a connector
     * envelope this runner cannot read, which no amount of extra budget will fix.
     */
    const unreadable = recorded.filter((r) => r.understood === false).length;
    return {
      ...testCase,
      ok: false,
      seconds,
      why: unreadable
        ? `${recorded.length} tool response(s) recorded, ${unreadable} of them in a shape this runner ` +
          'could not read. That is not a timeout - the envelope needs handling in resultOf.'
        : `${recorded.length} tool response(s) recorded, all empty - the turn was cut short before any ` +
          'result came back. Check whether the model is keeping up; --budget raises the limit.',
    };
  }

  const matched = recorded.some((r) => testCase.expect.test(r.output));
  return {
    ...testCase,
    ok: matched,
    seconds,
    why: matched
      ? `${recorded.length} execution(s) recorded, one matched`
      : `${recorded.length} execution(s) recorded, none matched ${testCase.expect}\n` +
        recorded
          .map((r, i) => `                       [${i}] exit ${r.exitCode} ${JSON.stringify(r.output.slice(0, 160))}`)
          .join('\n'),
    status,
  };
}

const selected = only ? CASES.filter((c) => c.agent === only) : CASES;
if (!selected.length) {
  console.error(`No smoke case for "${only}". Known: ${CASES.map((c) => c.agent).join(', ')}`);
  process.exit(2);
}

console.log(`\nSmoke testing ${selected.length} agent(s) against ${BASE}\n`);
const results = [];
for (const testCase of selected) {
  process.stdout.write(`  ${testCase.agent.padEnd(20)} ${testCase.what} ... `);
  let result = await runCase(testCase);
  /**
   * One retry, and only for a sandbox that was not ready - never for a wrong answer.
   *
   * The retry is announced rather than hidden. A suite that quietly re-runs until it passes is a
   * suite that tells you nothing, and the number of retries is itself a fact about the harness
   * worth seeing.
   */
  /**
   * Retried for two causes, both announced: a sandbox that was not ready, and a model that printed
   * the call instead of making it. Neither is an answer to "can this agent reach its tools", and
   * both are known to pass on a second attempt with a small local model.
   *
   * Never retried for a wrong answer. A suite that re-runs until it agrees with itself is worthless.
   */
  if (!result.ok && (result.sandbox || result.printedCall)) {
    console.log(result.sandbox ? 'sandbox not ready, retrying once' : 'call printed as text, retrying once');
    process.stdout.write(`  ${testCase.agent.padEnd(20)} ${testCase.what} ... `);
    result = await runCase(testCase);
    result.retried = true;
  }
  results.push(result);
  console.log(result.ok ? `ok (${result.seconds}s)${result.retried ? ' after one retry' : ''}` : 'FAILED');
  if (!result.ok) console.log(`  ${' '.repeat(20)} ${result.why}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n  ${results.length - failed.length}/${results.length} agents reached their tools\n`);

if (failed.length) {
  console.log('  A failure here is one of three things:');
  console.log('    - the agent is not applied      -> npm run agents:apply');
  console.log('    - its connector is unconfigured -> npm run preflight');
  console.log('    - the model printed the call    -> named as such above; the wiring is fine, the model is not');
  console.log('    - the sandbox was not ready     -> named as such above; it is the harness, not the agent');
  console.log('    - the machine is loaded         -> empty tool responses; raise --budget or free the machine\n');
  process.exit(1);
}
