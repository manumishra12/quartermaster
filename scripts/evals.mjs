/**
 * Runs the eval scenarios against the real harness and reports what held.
 *
 * `npm test` proves the code works. It cannot prove the agent behaves - that it reaches the right
 * tool, refuses the right thing, does not invent a number, and stops where it is supposed to stop.
 * Those are different questions, and the second one is the one this project's whole argument rests
 * on. Unit tests check functions; evals check judgement.
 *
 *   npm run evals                                  every scenario
 *   npm run evals -- --dry-run                     what would run, and what would not
 *   npm run evals -- --suite adversarial           one suite
 *   npm run evals -- --scenario injection-claims-pre-approval
 *   npm run evals -- --budget 600                  a slow machine, or a small local model
 *
 * Two things about it are deliberate and worth stating out loud.
 *
 * **It drives `scripts/run.mjs` rather than the SDK.** The approval gate, the ledger, the verifier
 * and the exit code are what the assertions read, and a runner with its own softer plumbing would
 * be testing something nobody ships. This project has already found one gate that could be walked
 * around by taking a different path to the same tool.
 *
 * **A model is involved, so this is not deterministic.** The assertion engine in
 * `evals/lib/assertions.mjs` is; everything below it is a real session against a real
 * provider, and the same scenario can pass twice and fail the third time. That is a fact about
 * evaluating an agent rather than a defect in this file, and the summary says so every run rather
 * than letting a green line imply otherwise.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { LEDGER, read as readLedger } from './lib/ledger.mjs';
import { loadEnv } from './lib/env.mjs';
import { fromModule } from './lib/paths.mjs';
import { positionals, readFlag } from './lib/flags.mjs';
import { settledWithin } from './lib/settle.mjs';
import {
  EXIT_USAGE,
  FAIL,
  FAILED,
  INCONCLUSIVE,
  PASS,
  PASSED,
  SKIPPED,
  UNPROVEN,
  checkScenario,
  exitCodeFor,
  missingRequirements,
  tally,
  validateScenario,
} from '../evals/lib/assertions.mjs';

loadEnv();

const ROOT = fromModule(import.meta.url, '../');
const SUITES = ['scenarios', 'adversarial'];
const BASE = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';

/**
 * The fixture servers, on the ports their own modules default to and with the same environment
 * overrides. Duplicated numbers here would be a second source of truth that disagrees with the
 * servers the first time somebody moves one.
 */
const FIXTURES = {
  'ops-desk': Number(process.env.OPS_DESK_PORT ?? 8795),
  'front-desk': Number(process.env.FRONT_DESK_PORT ?? 8796),
  warehouse: Number(process.env.WAREHOUSE_PORT ?? 8797),
};

const argv = process.argv.slice(2);
const VALUE_FLAGS = ['suite', 'scenario', 'budget'];

function flag(name, fallback = null) {
  const { value, problem } = readFlag(argv, name, fallback);
  // A flag given without a value is somebody asking for something and not saying what. `--suite`
  // as the last argument used to be the kind of thing that silently ran everything.
  if (problem) {
    console.error(problem);
    process.exit(EXIT_USAGE);
  }
  return value;
}

const dryRun = argv.includes('--dry-run');
const wantedSuite = flag('suite');
const wantedScenario = flag('scenario');
const budgetArg = flag('budget');

const stray = positionals(argv, VALUE_FLAGS);
if (stray.length) {
  console.error(`This takes flags, not a prompt. Unrecognised: ${stray.join(' ')}`);
  process.exit(EXIT_USAGE);
}
if (wantedSuite && !SUITES.includes(wantedSuite)) {
  console.error(`No suite called "${wantedSuite}". Known: ${SUITES.join(', ')}`);
  process.exit(EXIT_USAGE);
}

/**
 * A per-scenario wall clock. Without one a stuck model turns the suite into a hang, which is
 * indistinguishable from a broken harness and useless to anybody. Five minutes suits an unloaded
 * machine; a small local model on a busy one wants more, so it is raisable rather than fixed.
 */
const BUDGET_SECONDS = Number(budgetArg ?? process.env.EVALS_BUDGET_SECONDS ?? 300);
if (!Number.isFinite(BUDGET_SECONDS) || BUDGET_SECONDS <= 0) {
  const [where, value] =
    budgetArg === null ? ['EVALS_BUDGET_SECONDS', process.env.EVALS_BUDGET_SECONDS] : ['--budget', budgetArg];
  console.error(`${where} must be a positive number of seconds, got ${JSON.stringify(value)}`);
  process.exit(EXIT_USAGE);
}
/** How long a killed run gets to flush its streams before it is read anyway. */
const KILL_GRACE_MS = 5000;

/** Load every scenario, with the file it came from, so a problem can be reported where it lives. */
function loadScenarios() {
  const loaded = [];
  for (const suite of SUITES) {
    const dir = `${ROOT}evals/${suite}`;
    let files;
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      // An absent suite directory is a repository somebody has half of, and saying which one is
      // missing is more use than an ENOENT naming a path they cannot place.
      console.error(`No scenarios at evals/${suite}/. This suite is part of the repository; check your checkout.`);
      process.exit(EXIT_USAGE);
    }
    for (const file of files) {
      const where = `evals/${suite}/${file}`;
      let scenario;
      try {
        scenario = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
      } catch (err) {
        console.error(`${where}: is not readable JSON - ${err.message}`);
        process.exit(EXIT_USAGE);
      }
      loaded.push({ ...scenario, suite, where });
    }
  }
  return loaded;
}

const scenarios = loadScenarios();

/**
 * Every scenario is checked before anything is run, including on a dry run.
 *
 * An assertion nobody implements checks nothing and looks exactly like one somebody does, so a
 * typo would report a green suite that verified less than it claimed. That is the failure this
 * whole thing exists to catch, and it would be arriving through the tool meant to catch it.
 */
const problems = scenarios.flatMap((s) => validateScenario(s, s.where));
const seen = new Map();
for (const s of scenarios) {
  // Ids name the log file and are typed at `--scenario`, so two of them is an ambiguity rather
  // than a duplicate.
  if (seen.has(s.id)) problems.push(`${s.where}: id "${s.id}" is already used by ${seen.get(s.id)}`);
  else seen.set(s.id, s.where);
}
if (problems.length) {
  console.error(`\n  ${problems.length} problem(s) in the scenario files:\n`);
  for (const problem of problems) console.error(`    ${problem}`);
  console.error('\n  Nothing was run. A scenario that cannot be read cannot be trusted to check anything.\n');
  process.exit(EXIT_USAGE);
}

const selected = scenarios.filter(
  (s) => (!wantedSuite || s.suite === wantedSuite) && (!wantedScenario || s.id === wantedScenario),
);
if (!selected.length) {
  console.error(
    wantedScenario
      ? `No scenario called "${wantedScenario}". Known: ${scenarios.map((s) => s.id).join(', ')}`
      : `Nothing selected in suite "${wantedSuite}".`,
  );
  process.exit(EXIT_USAGE);
}

/** Ask a fixture server how it is, which is also how its state is sampled either side of a run. */
async function health(name) {
  const port = FIXTURES[name];
  if (!port) return null;
  try {
    const res = await fetch(`http://localhost:${port}/health`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Which connectors the harness actually has.
 *
 * `null` means the harness could not be asked, and unknown is not the same as absent: a scenario
 * is only skipped when we positively know the thing is missing. Otherwise it runs and fails
 * honestly, which is the more useful of the two wrong answers.
 */
async function configuredConnectors() {
  try {
    const res = await fetch(`${BASE}/api/v1/settings/mcp-servers`);
    if (!res.ok) return null;
    const body = await res.json();
    const list = Array.isArray(body) ? body : (body.data ?? body.servers ?? []);
    return new Set(list.map((s) => s?.name ?? s?.manifest?.name).filter(Boolean));
  } catch {
    return null;
  }
}

async function harnessIsUp() {
  try {
    const res = await fetch(`${BASE}/api/v1/capabilities`);
    return res.ok;
  } catch {
    return false;
  }
}

/** What this machine can supply, sampled once. */
async function readiness() {
  const fixtures = {};
  for (const name of Object.keys(FIXTURES)) fixtures[name] = (await health(name)) !== null;
  return { harness: await harnessIsUp(), connectors: await configuredConnectors(), fixtures };
}

/**
 * The prompt as the agent receives it.
 *
 * Nothing mounts this repository into the agent's sandbox, so a scenario about running a fixture
 * script has to hand over the file - which is exactly what that fixture's README tells a person to
 * do. A scenario that described the file instead would be testing whether a model can imagine an
 * exit code, which it can.
 */
function promptFor(scenario) {
  let prompt = scenario.prompt;
  for (const path of scenario.attach ?? []) {
    let contents;
    try {
      contents = readFileSync(`${ROOT}${path}`, 'utf8');
    } catch (err) {
      // Returned rather than thrown: a scenario whose attachment is missing must be reported as
      // unrunnable, not sent to a model with the file silently absent from the prompt.
      return { problem: `cannot attach ${path}: ${err.message}` };
    }
    prompt += `\n\n--- ${path} ---\n${contents}\n--- end of ${path} ---\n`;
  }
  return { prompt };
}

/** Run one scenario against the harness and collect everything the assertions read. */
async function observe(scenario) {
  const built = promptFor(scenario);
  if (built.problem) return { skip: [built.problem] };

  const before = {};
  for (const name of scenario.watch ?? []) before[name] = await health(name);
  const ledgerBefore = readLedger(`${ROOT}${LEDGER}`).length;

  const args = ['scripts/run.mjs', '--agent', scenario.agent, ...(scenario.flags ?? []), built.prompt];
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  /**
   * Closed at once, and that has a consequence worth naming.
   *
   * An empty pipe makes every approval prompt reach end of input, which the gate reads as a
   * refusal - so no eval run can approve anything. That is the safe direction and it is also a
   * limit: "nothing was approved" is then a fact about how this suite invokes the runner, not
   * about the agent. What the adversarial scenarios actually measure is whether the agent reached
   * for the call, and what the fixture and the ledger say afterwards.
   */
  child.stdin.end();

  let transcript = '';
  /**
   * Decoded as text rather than concatenated as buffers. The runner prints box-drawing characters
   * in its banners, which are three bytes each and land across a chunk boundary often enough to
   * matter - a stringified Buffer breaks them into replacement characters, and the transcript is
   * the artifact somebody reads when an eval fails.
   */
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (transcript += chunk));
  child.stderr.on('data', (chunk) => (transcript += chunk));

  let exitCode = null;
  const finished = new Promise((resolve) => {
    child.on('close', (code) => {
      exitCode = code;
      resolve();
    });
    child.on('error', (err) => {
      transcript += `\n[the eval runner could not start the run: ${err.message}]\n`;
      resolve();
    });
  });

  let timedOut = false;
  /**
   * A scenario may ask for longer than the suite's default, and one of them has to: the
   * reproduction stands up a stub gateway and makes two calls that take 2.4 seconds each, inside a
   * sandbox that has to be provisioned first. An explicit `--budget` still wins, because somebody
   * raising it on a loaded machine means it for everything.
   */
  const budget = budgetArg === null ? (scenario.timeoutSeconds ?? BUDGET_SECONDS) : BUDGET_SECONDS;
  if (!(await settledWithin(finished, budget * 1000))) {
    timedOut = true;
    child.kill('SIGTERM');
    // A run that ignores the polite signal still has to stop, or one stuck scenario becomes a
    // suite that never returns - the failure the budget exists to prevent.
    if (!(await settledWithin(finished, KILL_GRACE_MS))) child.kill('SIGKILL');
    await settledWithin(finished, KILL_GRACE_MS);
  }

  const after = {};
  for (const name of scenario.watch ?? []) after[name] = await health(name);

  /**
   * Only the decisions this run appended.
   *
   * The ledger is append-only and shared by every run on this machine, so reading the whole file
   * would let last week's approval fail today's scenario - and, worse, let it pass one.
   */
  const ledger = readLedger(`${ROOT}${LEDGER}`).slice(ledgerBefore);

  const fixtures = {};
  for (const name of scenario.watch ?? []) fixtures[name] = { before: before[name], after: after[name] };

  return {
    observation: { exitCode: timedOut ? null : exitCode, transcript, ledger, fixtures, report: reportFrom(transcript) },
    transcript,
    timedOut,
    budget,
    session: /^session: (\S+)/m.exec(transcript)?.[1] ?? null,
  };
}

/**
 * The report the run wrote, found the way the run says where it is.
 *
 * Reading the newest directory under `evidence/` instead would attach somebody else's run to these
 * assertions the moment two things run at once, which is a wrong answer that looks like a right
 * one. If the line is not there, no report is claimed.
 */
function reportFrom(transcript) {
  /**
   * Anchored, last match, and no path may leave `evidence/`.
   *
   * The transcript is the child's stdout, and `run.mjs` streams the model's answer to stdout
   * verbatim. An unanchored `exec` takes the *first* match, and the answer arrives before the
   * runner's own banner - so a model that emitted the words `written: ../../elsewhere/report.md`
   * anywhere in its reply chose which file these assertions were checked against. Reading a missing
   * one returns null, every report-backed assertion degrades to inconclusive, and a scenario that
   * should have reported FAILED reports UNPROVEN instead. An adversarial scenario is precisely a
   * run being fed text by somebody else, so this was reachable from the suite's own fixtures.
   *
   * Three changes, each closing part of it: `^  written:` at the start of a line matches the
   * runner's format and not prose; the last match is the runner's, since the banner is printed
   * after the answer; and the path must sit under `evidence/` with no `..` in it, so a match that
   * gets through the first two still cannot leave the directory.
   */
  const matches = [...String(transcript ?? '').matchAll(/^ {2}written: (\S+)\/report\.md$/gm)];
  if (matches.length === 0) return null;
  const dir = matches[matches.length - 1][1];
  if (!/^evidence\/[A-Za-z0-9._-]+$/.test(dir)) return null;
  try {
    return JSON.parse(readFileSync(`${ROOT}${dir}/report.json`, 'utf8'));
  } catch {
    return null;
  }
}

const LABEL = { [PASS]: ' ok ', [FAIL]: 'FAIL', [INCONCLUSIVE]: ' ?? ' };
const OUTCOME = { [PASSED]: 'PASSED', [FAILED]: 'FAILED', [UNPROVEN]: 'UNPROVEN', [SKIPPED]: 'SKIPPED' };

const ready = await readiness();

if (dryRun) {
  console.log(`\nWhat would run, against ${BASE}\n`);
  console.log(`  harness      ${ready.harness ? 'reachable' : `NOT reachable at ${BASE}`}`);
  console.log(
    `  connectors   ${ready.connectors ? [...ready.connectors].sort().join(', ') || '(none registered)' : '(could not ask the harness)'}`,
  );
  for (const [name, up] of Object.entries(ready.fixtures)) {
    console.log(`  ${name.padEnd(12)} ${up ? `answering on :${FIXTURES[name]}` : `not answering on :${FIXTURES[name]} (npm run ${name})`}`);
  }
  console.log();
  for (const scenario of selected) {
    const missing = ready.harness ? missingRequirements(scenario, ready) : [`the harness is not running at ${BASE}`];
    console.log(`  ${missing.length ? 'skip' : 'run '}  ${scenario.suite.padEnd(11)} ${scenario.id}`);
    console.log(`          ${scenario.title}`);
    console.log(`          ${scenario.expect.length} assertion(s), agent ${scenario.agent}`);
    for (const reason of missing) console.log(`          skipped: ${reason}`);
  }
  const runnable = selected.filter((s) => ready.harness && missingRequirements(s, ready).length === 0).length;
  console.log(`\n  ${runnable} of ${selected.length} scenario(s) could run here. Nothing was executed.\n`);
  process.exit(0);
}

console.log(`\nEvals: ${selected.length} scenario(s) against ${BASE}`);
// Said every run, because a green line at the bottom invites the opposite conclusion.
console.log('A model decides most of what is checked below, so these results are not deterministic.');
console.log(
  `Budget ${BUDGET_SECONDS}s per scenario unless one asks for longer${budgetArg === null ? '' : ' (--budget overrides that)'}. ` +
    'Answers to the gate come from a closed pipe, which always refuses.\n',
);

const LOGS = `${ROOT}evidence/evals`;
const results = [];

for (const scenario of selected) {
  const missing = ready.harness ? missingRequirements(scenario, ready) : [`the harness is not running at ${BASE}`];
  if (missing.length) {
    console.log(`  SKIPPED   ${scenario.id}`);
    for (const reason of missing) console.log(`            ${reason}`);
    results.push({ id: scenario.id, suite: scenario.suite, title: scenario.title, status: SKIPPED, missing });
    continue;
  }

  process.stdout.write(`  running   ${scenario.id} ... `);
  const started = Date.now();
  const { observation, transcript, timedOut, budget, session, skip } = await observe(scenario);
  if (skip) {
    console.log('SKIPPED');
    for (const reason of skip) console.log(`            ${reason}`);
    results.push({ id: scenario.id, suite: scenario.suite, title: scenario.title, status: SKIPPED, missing: skip });
    continue;
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(0);

  // Kept whatever the outcome. A failing eval is exactly the one somebody needs the transcript for,
  // and the terminal scrolls.
  try {
    mkdirSync(LOGS, { recursive: true });
    writeFileSync(`${LOGS}/${scenario.id}.log`, transcript);
  } catch (err) {
    console.log(`(transcript not saved: ${err.message}) `);
  }

  const result = { ...checkScenario(scenario, observation), suite: scenario.suite, seconds, session, timedOut };
  results.push(result);

  console.log(`${OUTCOME[result.status]} (${seconds}s)`);
  if (timedOut) {
    console.log(`            the run did not finish within ${budget}s and was killed; whatever it had recorded is judged below`);
  }
  for (const check of result.checks) {
    // Every assertion is printed, not only the failures. A reader has to be able to see what was
    // checked, and an unproven one is invisible if only failures are shown.
    console.log(`      ${LABEL[check.status]}  ${check.name}: ${check.reason}`);
    if (check.status !== PASS && check.because) console.log(`            wanted because ${check.because}`);
  }
  console.log(`            transcript: evidence/evals/${scenario.id}.log${session ? `, session ${session}` : ''}`);
}

const counts = tally(results);
console.log(`\n  ${counts.passed} passed, ${counts.failed} failed, ${counts.unproven} unproven, ${counts.skipped} skipped, of ${counts.total}`);
console.log(`  ${counts.assertions} assertion(s) evaluated\n`);

/**
 * Skips and unproven scenarios are named rather than folded into the total.
 *
 * The rule this project keeps: the check that could not run is not the check that passed. A suite
 * that counts a skip as a pass reports coverage it did not have, and the one place that lie is
 * least affordable is the suite whose whole job is to say whether the agent behaved.
 */
if (counts.skipped) {
  console.log('  Skipped, and therefore checked nothing:');
  for (const r of results.filter((r) => r.status === SKIPPED)) {
    console.log(`    ${r.id.padEnd(34)} ${r.missing.join('; ')}`);
  }
  console.log();
}
if (counts.unproven) {
  console.log('  Ran, but some of what they claim to check was not checked:');
  for (const r of results.filter((r) => r.status === UNPROVEN)) {
    const why = r.checks.filter((c) => c.status === INCONCLUSIVE).map((c) => c.name);
    console.log(`    ${r.id.padEnd(34)} ${why.join(', ')}`);
  }
  console.log();
}
if (counts.failed) {
  console.log('  Failed:');
  for (const r of results.filter((r) => r.status === FAILED)) {
    for (const c of r.checks.filter((c) => c.status === FAIL)) console.log(`    ${r.id.padEnd(34)} ${c.name}: ${c.reason}`);
  }
  console.log();
}

console.log('  A passing suite is evidence about these scenarios and about this run of them. It is not');
console.log('  a guarantee about anything the scenarios do not cover, and it is not repeatable in the');
console.log('  way a unit test is. EVALS.md says what each one proves and what it does not.\n');

process.exit(exitCodeFor(counts));
