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
import { readFlag } from './lib/flags.mjs';
import { settledWithin } from './lib/settle.mjs';

loadEnv();

const BASE = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';
const argv = process.argv.slice(2);
/** A flag given as the final argument has no value; that must be an error, not a silent NaN. */
function flagValue(name) {
  const { value, problem } = readFlag(argv, name);
  if (problem) {
    console.error(problem);
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
 * How long a cancelled turn gets to stop streaming before the case is judged anyway.
 *
 * Bounded rather than open-ended: waiting for a reader that will never end turns one stuck case
 * into a suite that never returns, which is the failure the budget above exists to prevent.
 */
const CANCEL_GRACE_MS = 5000;

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
    /** The case reads a firing alert, so it needs a desk nobody has remediated on yet. */
    freshFixture: { port: 8795, name: 'ops-desk' },
  },
  {
    agent: 'desk-assistant',
    what: 'reads the front desk',
    prompt: 'List the projects on the front desk and tell me the key of the checkout project.',
    // Likewise: `convention` appears on a real project and never in a not-found payload's id list.
    expect: /"convention"[\s\S]*CHK|CHK[\s\S]*"convention"/,
  },
  {
    agent: 'code-reviewer',
    what: 'reads a pull request',
    /**
     * Points at this repository's own review history, which is public and does not move. A smoke
     * case whose fixture is somebody else's open pull request passes until they merge it.
     *
     * Read-only by construction: every tool that writes to a repository is gated for this agent,
     * so a smoke run cannot post anything even if the model decides it wants to.
     */
    prompt:
      'Read pull request 19 of manumishra12/quartermaster and tell me its title and whether it is open or merged. Do not comment on it.',
    // The title is the fixture. A not-found payload cannot contain it.
    expect: /both halves of its own proof/i,
    /** Needs the GitHub connector, like gate-demo and quartermaster. */
    needsConnector: 'github',
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
      if (isEventDelta(event)) {
        /**
         * The answer arrives in pieces, and only in pieces.
         *
         * Skipping every delta left `said` empty, so a call the model printed as text was never
         * recognised - the runner had the evidence streaming past it and threw each fragment away,
         * then reported that nothing had happened. The settled `model.message` does not carry the
         * content; the deltas are the content.
         */
        if (event.type === 'model.message.delta') said += event.content ?? '';
        continue;
      }
      if (event.type === 'tool.response') recorded.push(resultOf(event));
      if (event.type === 'model.message') said += event.content ?? '';
      if (event.type === 'turn.done') status = event.state?.status;
    }
  };

  /**
   * The reader is held, not abandoned.
   *
   * `Promise.race([drain(), timeout])` looks like a budget and is not one: the race settles, the
   * stream does not stop. On a timeout it went on appending to `recorded` and `said` while the
   * judgement below was being read off them, so what a case reported depended on where the stream
   * happened to be. Worse, a failure arriving after the race had been decided was an unhandled
   * rejection, which ends the whole process - one slow agent taking down every case after it.
   */
  let readerFailure = null;
  const draining = drain().catch((err) => {
    readerFailure = err ?? new Error('the event stream failed');
  });

  if (!(await settledWithin(draining, BUDGET_MS))) {
    timedOut = true;
    // The turn keeps running on the server after we stop reading, so tell it to stop - and then
    // wait for the reader to notice, so nothing is still being written while it is being judged.
    await client.sessions.cancel(session.id).catch(() => {});
    await settledWithin(draining, CANCEL_GRACE_MS);
  }
  if (readerFailure) return { ...testCase, ok: false, why: `turn failed: ${readerFailure.message}` };

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
      // The most direct no-response failure there is, so it gets the retry the others get.
      noResponse: true,
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
      noResponse: true,
      /**
       * What this establishes and no more. It was worded "the wiring is fine, the emission is
       * not" - but a printed call proves only that nothing was invoked on this attempt. If the
       * connector were also broken this would look identical, and clearing the wiring would send
       * somebody away from a real fault.
       */
      why: `the model printed the ${printed.map((c) => c.name).join(', ')} call as text instead of making it - nothing was invoked, so this attempt says nothing either way about the connector`,
    };
  }

  if (recorded.length === 0) {
    return {
      ...testCase,
      ok: false,
      seconds,
      noResponse: true,
      why: 'no tool response was recorded - nothing the agent did produced a result',
    };
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

/**
 * Which connectors this harness actually has, so a case that needs one can say it was skipped
 * rather than fail.
 *
 * Most agents here run with no account at all - that is deliberate, and it is why ops-desk and
 * front-desk exist. The two that reach GitHub need a token somebody has to paste in. Reporting
 * "FAILED" for a connector nobody configured says the agent is broken when the truth is that this
 * machine was never given a key, and those are different problems with different fixes.
 */
async function configuredConnectors() {
  try {
    const res = await fetch(`${BASE}/api/v1/settings/mcp-servers`);
    if (!res.ok) return null;
    const body = await res.json();
    const list = Array.isArray(body) ? body : (body.data ?? body.servers ?? []);
    return new Set(list.map((s) => s?.name ?? s?.manifest?.name).filter(Boolean));
  } catch {
    // Unknown is not the same as none. A case is only skipped when we positively know the
    // connector is absent; otherwise it runs and fails honestly.
    return null;
  }
}

/**
 * Whether a fixture server has been written to since it started.
 *
 * Read from its own journal rather than inferred from the data: both servers report what they have
 * done, and a count above zero is the fixture saying so itself.
 */
async function staleFixture({ port, name }) {
  try {
    const res = await fetch(`http://localhost:${port}/health`);
    if (!res.ok) return null;
    const health = await res.json();
    const written = health.actions ?? 0;
    if (written > 0) {
      return `${name} has ${written} recorded action(s) - restart it (npm run ${name}) so the fixture is the one the case expects`;
    }
    return null;
  } catch {
    // Unreachable is a different failure, and the case itself will report it properly.
    return null;
  }
}

const connectors = await configuredConnectors();
const selected = only ? CASES.filter((c) => c.agent === only) : CASES;
if (!selected.length) {
  console.error(`No smoke case for "${only}". Known: ${CASES.map((c) => c.agent).join(', ')}`);
  process.exit(2);
}

console.log(`\nSmoke testing ${selected.length} agent(s) against ${BASE}\n`);
const results = [];
for (const testCase of selected) {
  process.stdout.write(`  ${testCase.agent.padEnd(20)} ${testCase.what} ... `);

  /**
   * A fixture somebody has already used is not an agent that failed.
   *
   * ops-desk and front-desk hold their state in memory and the write tools genuinely mutate it -
   * that is deliberate, because a gate in front of an operation that does nothing proves nothing.
   * It also means a demo, or one curl, leaves the fixture changed, and the next smoke run then
   * reports that the agent could not find an alert that somebody resolved twenty minutes ago.
   *
   * Blaming the agent for that sends whoever is debugging to the spec and the connector. So the
   * suite looks first, and says which it is.
   */
  if (testCase.freshFixture) {
    const stale = await staleFixture(testCase.freshFixture);
    if (stale) {
      console.log(`skipped - ${stale}`);
      results.push({ ...testCase, ok: true, skipped: true });
      continue;
    }
  }

  if (testCase.needsConnector && connectors && !connectors.has(testCase.needsConnector)) {
    console.log(`skipped - no ${testCase.needsConnector} connector configured`);
    results.push({ ...testCase, ok: true, skipped: true });
    continue;
  }

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
  /**
   * Retried on facts from the event stream, not on what the model said.
   *
   * The two retryable causes are "the sandbox was not ready" and "no tool response was recorded" -
   * both read from recorded events. A printed call is *why* the second happened and it is worth
   * reporting, but it must not be what decides whether the suite tries again, or the outcome would
   * turn on parsing transcript text.
   *
   * Never retried for a wrong answer: a suite that re-runs until it agrees with itself is worthless.
   */
  if (!result.ok && (result.sandbox || result.noResponse)) {
    console.log(result.sandbox ? 'sandbox not ready, retrying once' : 'no tool response, retrying once');
    process.stdout.write(`  ${testCase.agent.padEnd(20)} ${testCase.what} ... `);
    result = await runCase(testCase);
    result.retried = true;
  }
  results.push(result);
  console.log(result.ok ? `ok (${result.seconds}s)${result.retried ? ' after one retry' : ''}` : 'FAILED');
  if (!result.ok) console.log(`  ${' '.repeat(20)} ${result.why}`);
}

const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped);
const ran = results.length - skipped.length;
console.log(`\n  ${ran - failed.length}/${ran} agents reached their tools\n`);
// Named rather than folded into the total. A suite that counts a skip as a pass and says nothing
// reports coverage it did not have.
if (skipped.length) {
  console.log(`  ${skipped.length} skipped for want of a connector: ${skipped.map((r) => r.agent).join(', ')}\n`);
}

if (failed.length) {
  console.log('  A failure here is one of three things:');
  console.log('    - the agent is not applied      -> npm run agents:apply');
  console.log('    - its connector is unconfigured -> npm run preflight');
  console.log('    - the model printed the call    -> named as such above; the wiring is fine, the model is not');
  console.log('    - the sandbox was not ready     -> named as such above; it is the harness, not the agent');
  console.log('    - the machine is loaded         -> empty tool responses; raise --budget or free the machine\n');
  process.exit(1);
}
