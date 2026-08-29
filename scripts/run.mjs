/**
 * A headless client for the agent - the same loop the chat UI runs, in a terminal.
 *
 * Three things it exists to prove:
 *   1. the fix loop is testable without a browser
 *   2. the approval gate is real - this process stops and waits for a human to type a word
 *   3. a run survives losing its connection, because the session lives on the server, not here
 *
 *   node scripts/run.mjs "fix the failing test in ledger"
 *   node scripts/run.mjs --agent quartermaster "..."
 *   node scripts/run.mjs --deny-all "..."      # prove the gate holds
 *   node scripts/run.mjs --resume              # reattach after a crash, kill, or restart
 */
import { createInterface } from 'node:readline/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TrueForge, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import { loadEnv } from './lib/env.mjs';

loadEnv();
import { judge, performed, refused, resultOf, SUBSTANTIATED, NO_CLAIM } from './lib/evidence.mjs';
import { buildReport } from './lib/report.mjs';
import { announcedArtifacts, artifactName } from './lib/artifacts.mjs';
import { endedBecause, runExitCode } from './lib/turn-state.mjs';
import { explainFailure } from './lib/model-advice.mjs';
import { unexecutedToolCalls } from './lib/evidence.mjs';
import { renderUnexecutedCalls } from './lib/render-call.mjs';
import { positionals, readFlag } from './lib/flags.mjs';
import { advance, blankCheckpoint, parseCheckpoint, sessionDirName, writeCheckpoint } from './lib/checkpoint.mjs';
import { decideApproval } from './lib/approval.mjs';
import { record as recordDecision } from './lib/ledger.mjs';
import { loadAgents, route } from './lib/route.mjs';
import { handoff, parseHandoffEnvelope, renderHandoff, requestedHandoff } from './lib/handoff.mjs';
import { retryDecision } from './lib/retry.mjs';
import { undisclosedInfluence } from './lib/influence.mjs';
import { plan, renderPlan } from './lib/dry-run.mjs';
import { checkBudget, detectLoop } from './lib/limits.mjs';
import { REASONS, escalate, renderEscalation, runOutcome } from './lib/escalation.mjs';
import { keyFor, noteCall } from './lib/idempotency.mjs';
import { createTracer } from './lib/otel.mjs';

const argv = process.argv.slice(2);
/** The flags that take a value, named once so the prompt and the readers agree on them. */
const VALUE_FLAGS = ['agent', 'answer', 'chain'];
const flag = (name, fallback) => {
  const { value, problem } = readFlag(argv, name, fallback);
  // A flag given without a value is the operator asking for something and not saying what. There
  // is no safe guess: `--agent --deny-all` used to set the agent name to "--deny-all" and quietly
  // drop the flag that refuses everything.
  if (problem) {
    console.error(problem);
    process.exit(2);
  }
  return value;
};
const denyAll = argv.includes('--deny-all');
const resuming = argv.includes('--resume');
const requested = flag('agent', null);
const prompt = positionals(argv, VALUE_FLAGS).join(' ');

if (!prompt && !resuming) {
  console.error('usage: node scripts/run.mjs [--agent <name>] [--deny-all] "<prompt>"\n       node scripts/run.mjs --resume');
  process.exit(2);
}

/**
 * With no `--agent`, choose one and say why.
 *
 * The default used to be `quartermaster-local` whatever was asked, so eight of the nine agents
 * were reachable only by somebody who already knew they existed - and a database question was
 * answered, capably and at length, by the agent that fixes failing tests. Choosing the agent is
 * choosing which tools the request can touch, so the choice is printed rather than assumed, and
 * an unclear one stops here instead of being resolved by whichever spec sorts first.
 */
function chooseAgent() {
  const decision = route(prompt, loadAgents());
  if (decision.decided) {
    console.log(`routed to ${decision.agent}: ${decision.why}`);
    if (decision.runnerUp) console.log(`  (${decision.runnerUp} also matched; --agent overrides)\n`);
    else console.log();
    return decision.agent;
  }

  console.error(`\n  Not sure which agent should take this: ${decision.why}.\n`);
  for (const candidate of decision.candidates) {
    console.error(`    --agent ${candidate.name.padEnd(20)} ${candidate.matched.map((m) => `"${m}"`).join(', ')}`);
  }
  if (decision.candidates.length === 0) {
    console.error('    npm run route -- "<request>"   to see what each agent says it handles');
  }
  console.error('\n  Name one with --agent. Picking for you here would be a guess about authority.\n');
  process.exit(2);
}

/** On `--resume` the agent comes from the checkpoint, so this placeholder is overwritten. */
const agentName = requested ?? (resuming ? 'quartermaster-local' : chooseAgent());

const client = new TrueForge({
  baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790',
  timeoutInSeconds: 900,
});

/**
 * Traces, if anybody asked for them.
 *
 * Off unless `QUARTERMASTER_OTEL=1`, and off is the whole tracer rather than a flag checked at
 * each call site: every method below is a no-op that returns undefined when tracing is off, so
 * there is no second path through this file. Nothing here can throw and nothing here reaches a
 * network. `otel.mjs` explains why this exists and why it is not a dependency.
 */
const tracer = createTracer();

/**
 * The checkpoint is the whole resilience story: session id, the turn in flight, and how far we
 * read. Everything else - history, tool results, the agent's place in its own loop - lives on the
 * server. This process is disposable by design.
 */
const CHECKPOINT = '.quartermaster/run.json';
let checkpoint = blankCheckpoint(agentName);
// Whole file or nothing. The save runs every twenty events, so a kill lands mid-write often enough
// to matter, and --resume - the one command used after exactly that - was reading half a document.
const save = () => writeCheckpoint(CHECKPOINT, checkpoint);

const events = new Map();
const toolResponses = [];
/**
 * Why the last turn ended badly, if it did.
 *
 * A run that dies on a provider quota produces no answer and no executions, which reads exactly
 * like an agent that sat there doing nothing. The harness knew the difference and said so; keeping
 * only the status threw it away, and the report then blamed the agent for the plumbing.
 */
let turnFailure = null;
/**
 * Approvals granted in this run, which is the one thing that makes a failed turn unsafe to retry:
 * the call went out, the failure came back, and nothing here can tell whether the write landed.
 */
let approvalsGranted = 0;
/** When the run began, what it has called, and why it gave up, for the ceilings and the loop check. */
const startedAt = Date.now();
const callHistory = [];
let escalation = null;
/**
 * Tool call ids the operator refused, so the record can tell a refusal from a silent success.
 *
 * This lives in the checkpoint rather than only in memory. A refusal is a decision a person made,
 * and it has to outlive the process: on --resume the response for a stopped call is replayed, and
 * a set that started empty filed it as a real execution - so the report said the call ran, and the
 * guard against a claim with nothing behind it counted the thing the gate had stopped.
 */
const denied = new Set();
let finalText = '';
/** A turn that stopped because a connector needs authorizing has not finished, whatever it says. */
let blockedOnAuth = false;
/**
 * A pipe is an operator too.
 *
 * The readline interface was created only for a TTY, so `echo deny | ...` was not read at all - the
 * answer came from the fallback, and `echo allow | ...` denied just the same. That is safe, but it
 * is safe by not listening, which made the documented example a demonstration of nothing and would
 * have made a scripted approval silently impossible. Reading the pipe changes none of the safety:
 * the answer still has to be one of the exact allowing words, and reaching end of input without
 * one is still a denial.
 */
const piped = !stdin.isTTY;
const rl = piped ? null : createInterface({ input: stdin, output: stdout });

/**
 * Piped answers are read up front, not when the question is asked.
 *
 * A pipe reaches end of input long before the agent gets far enough to need an answer, so a
 * readline attached to it had already seen and discarded every line by the time anything was
 * asked. Draining it first keeps the answers in the order they were written.
 */
const queued = [];
if (piped) {
  let buffer = '';
  for await (const chunk of stdin) buffer += chunk;
  const lines = buffer.split('\n').map((line) => line.trim());
  // A trailing newline is punctuation, not an answer; every other blank line is kept in place.
  // Dropping blanks shifted the queue, so a blank meant to deny one prompt was discarded and the
  // next line - written for the prompt after it - answered the one it was never meant for.
  if (lines[lines.length - 1] === '') lines.pop();
  queued.push(...lines);
}

/**
 * Ask the operator, or fall back when there is no operator to ask.
 *
 * The fallback for an approval is always deny. A gate that quietly allows when nobody is watching
 * is not a gate, and this agent's whole argument is that the unattended path must be the safe one.
 */
/**
 * End of input has to *settle*, or the invariant is only a comment.
 *
 * `question()` never resolves when the input ends, so Ctrl-D at an approval prompt left an
 * unsettled await: no denial was sent, the readline was never closed, and the process exited
 * without writing a report - while the claim above says silence is a denial. It is a denial only
 * for a pipe; on a terminal it was a hang. Aborting the question when the interface closes turns
 * the hang back into the refusal it was always described as.
 */
const inputEnded = new AbortController();
rl?.on('close', () => inputEnded.abort());

async function ask(question, fallback) {
  const answer = piped
    ? queued.shift()
    : (await rl.question(question, { signal: inputEnded.signal }).catch(() => null))?.trim();

  /**
   * Running out of answers is not an answer. Whatever the caller's fallback is, silence gets it -
   * and every caller's fallback is a refusal.
   *
   * An empty line is deliberately *not* silence for a caller that wants an acknowledgement: the
   * auth prompt asks somebody to press enter, and reading that as "nobody is here" made the one
   * documented action impossible to perform.
   */
  if (answer == null) {
    console.log(`${question}${fallback ?? '(no answer)'}   [end of input]`);
    return fallback;
  }
  if (answer === '' && fallback !== null) {
    console.log(`${question}${fallback}   [no answer given]`);
    return fallback;
  }
  if (piped) console.log(`${question}${answer}   [from stdin]`);
  return answer;
}

/** Fold one event into local state. Shared by the live stream and the replay path. */
function absorb(event, sequenceId) {
  // Only ever forward, and only ever a number. A sequence id that went backwards made the next
  // --resume replay events it had already recorded, and a non-numeric one wrote NaN, which
  // JSON.stringify stores as null and resume then sends as afterSequenceNumber.
  checkpoint.lastSequenceNumber = advance(checkpoint.lastSequenceNumber, sequenceId);
  if (isEventDelta(event)) {
    const base = events.get(event.id);
    if (base) {
      mergeEventDelta(base, event);
      // A call can arrive by delta rather than whole, so the span has to start from here too or a
      // streamed turn traces none of its tool calls at all.
      traceCalls(base);
    } else {
      /**
       * A delta with no base in this process, which is what every `--resume` sees.
       *
       * `events` starts empty in a fresh process and `subscribeToTurn(..., afterSequenceNumber)`
       * does not re-deliver the message the deltas are amending. Dropping it silently meant
       * `describe()` returned null for those calls, so the runner took the branch that denies a
       * call it cannot display - an automatic refusal the operator never saw, on precisely the flow
       * the documentation advertises. It also cost the verifier its command provenance, leaving the
       * evidence rules to classify a test run by how its text looks.
       *
       * Kept as the base instead. A delta is a partial message, so what is retained is incomplete -
       * but an incomplete call that can be displayed and asked about is worth more than a complete
       * one nobody was shown.
       */
      events.set(event.id, event);
      traceCalls(event);
    }
    if (event.type === 'model.message.delta') {
      stdout.write(event.content ?? '');
      finalText += event.content ?? '';
    }
    return null;
  }
  events.set(event.id, event);
  traceCalls(event);

  // Not every path streams deltas - a replayed log delivers whole messages. Capturing only deltas
  // meant a resumed run had no answer text at all, and an empty answer used to read as success.
  if (event.type === 'model.message' && typeof event.content === 'string' && event.content !== '') {
    finalText += event.content;
  }

  switch (event.type) {
    case 'turn.created':
      checkpoint.turnId = event.turnId;
      save();
      break;
    /**
     * The gate opening is the moment a tool span stops measuring a tool and starts measuring a
     * person. It is recorded here rather than where the approvals are answered, because both the
     * live stream and the replay path go through `absorb` and only one of them goes through the
     * loop below.
     */
    case 'tool.approval_required':
      // `describe` finds the call by the event that made it, which is a lookup rather than the
      // scan `callFor` does. The gate is not a place to be doing needless work.
      for (const ref of event.toolCalls ?? []) tracer.gated(ref?.id, { tool: describe(ref)?.toolInfo?.name ?? null });
      break;
    case 'sandbox.created':
      console.log('\n  [sandbox provisioned]');
      break;
    case 'thread.created':
      console.log('\n  [subagent started]');
      break;
    case 'tool.response': {
      // Attach the command that produced this output. Without it the evidence rules can only
      // classify a test run by how its text looks, and `echo ok` looks like a passing test.
      const call = callFor(event.toolCallId);
      const command = commandOf(call);
      /**
       * A refused call arrives here like any other, with no output and no exit code. Recorded
       * plainly it is indistinguishable from a command that ran and printed nothing, and the
       * evidence then counts the thing the gate stopped as a thing that happened.
       */
      const wasDenied = denied.has(event.toolCallId);
      const result = resultOf(event, command);
      toolResponses.push({ ...result, denied: wasDenied });
      /**
       * The span closes on the same parse the evidence uses, so the two records cannot disagree
       * about whether a call errored. The output goes no further than its length: `createdAt` is
       * the server's own timestamp for the response, which is a better end than reading a clock
       * here after the event loop got round to us.
       */
      tracer.finishedCall(event.toolCallId, {
        tool: call?.toolInfo?.name ?? null,
        exitCode: result.exitCode,
        errored: result.errored === true,
        denied: wasDenied,
        outputBytes: result.output?.length ?? 0,
        command,
        at: event.createdAt,
      });
      /**
       * What was called, for the loop check, and whether it landed, for the idempotency record.
       *
       * Both are written here rather than where the approval was answered, because this is the
       * first point at which the answer is known. An approval that was granted and then failed on
       * the way out is exactly the case both of these exist for, and at the gate it looks identical
       * to one that succeeded.
       */
      /**
       * The call, not its signature. `detectLoop` signatures what it is given, so pushing a digest
       * here meant it hashed the digest: every element collapsed to one value and three different
       * calls read as three identical ones. Every run escalated on its third tool response,
       * denying whatever was at the gate and cancelling the turn, and no test caught it because
       * `limits.test.mjs` passes calls to `detectLoop` exactly as the module intends.
       */
      callHistory.push({ tool: call?.toolInfo?.name, args: call?.function?.arguments });
      noteCall({
        key: keyFor({ session: checkpoint.sessionId, tool: call?.toolInfo?.name, args: call?.function?.arguments }),
        state: wasDenied ? 'not-executed' : 'executed',
        tool: call?.toolInfo?.name ?? null,
        session: checkpoint.sessionId,
      });
      console.log(`\n  [tool] ${wasDenied ? 'refused' : 'recorded'}${command ? `: ${command.slice(0, 70)}` : ''}`);
      break;
    }
  }
  return event;
}

/** Drain a stream, collecting anything the agent is waiting on. */
async function consume(stream) {
  const pending = { approvals: [], questions: [], auth: [] };
  let status;
  let failure = null;
  let sinceSave = 0;

  for await (const { data: event, id } of stream.withMetadata()) {
    const settled = absorb(event, id);
    if (++sinceSave >= 20) {
      save();
      sinceSave = 0;
    }
    if (!settled) continue;
    if (settled.type === 'tool.approval_required') pending.approvals.push(settled);
    else if (settled.type === 'tool.response_required') pending.questions.push(settled);
    else if (settled.type === 'mcp.auth_required') pending.auth.push(settled);
    else if (settled.type === 'turn.done') {
      status = settled.state?.status;
      // The harness says why a turn ended badly. Keeping only the status threw that away, so a
      // run that died on a provider quota printed "[error]" and nothing else - which is the exact
      // kind of silent, unhelpful tooling this project exists to argue against. It cost me an
      // afternoon of guessing at a message the server had been sending all along.
      failure = endedBecause(settled.state);
      /**
       * What the turn cost, which the harness has been reporting on every terminal state and this
       * runner has been discarding since it was written: tokens in and out, cache reads and
       * writes, and the provider's own estimate in dollars. It goes on the trace and nowhere else
       * for now - the report is a document about evidence, and a dollar figure is not evidence.
       */
      tracer.turnUsage(settled.state?.metrics);
    }
  }
  save();
  return { pending, status, failure };
}

/** Reattach to whatever this machine was last doing, without replaying what we already saw. */
async function reattach() {
  /**
   * The checkpoint is read as if somebody else wrote it, because after a crash somebody else
   * effectively did. Spreading a parsed file straight over the live state meant whatever it said
   * became what the run believed: a `denied` that is not a list threw here and took the report with
   * it, and a sessionId that is not a string went into a request URL.
   */
  let stored;
  try {
    stored = readFileSync(CHECKPOINT, 'utf8');
  } catch {
    console.error(`No checkpoint at ${CHECKPOINT}. Start a run first.`);
    process.exit(2);
  }
  try {
    checkpoint = { ...checkpoint, ...parseCheckpoint(stored) };
  } catch (err) {
    // Naming what is wrong with it, because the alternative is a stack trace from three layers
    // down about a field nobody knew was being read.
    console.error(`The checkpoint at ${CHECKPOINT} cannot be used: ${err.message}.`);
    console.error('Start a fresh run rather than resuming into a state this cannot vouch for.');
    process.exit(2);
  }
  for (const id of checkpoint.denied) denied.add(id);
  const { sessionId, turnId, lastSequenceNumber } = checkpoint;
  console.log(`reattaching to session ${sessionId}, turn ${turnId}, after event ${lastSequenceNumber}\n`);
  // A resumed run gets its own trace, opened before anything is absorbed, because a tool span
  // needs a root to hang from and the replay starts producing them immediately.
  tracer.startTurn({ agent: checkpoint.agentName, session: sessionId, model: process.env.TRUEFORGE_MODEL ?? null, prompt });

  const { data: turn } = await client.sessions.getTurn(sessionId, turnId);
  if (turn.state?.status === 'running') {
    console.log('  [turn still running on the server - streaming the rest]\n');
    return consume(
      await client.sessions.subscribeToTurn(sessionId, turnId, { afterSequenceNumber: lastSequenceNumber }, { timeoutInSeconds: 900 }),
    );
  }

  console.log(`  [turn already finished as "${turn.state?.status}" - rebuilding from the stored log]\n`);
  const pending = { approvals: [], questions: [], auth: [] };
  const logged = await client.sessions.listTurnEvents(sessionId, turnId);
  for await (const entry of logged) {
    const event = entry?.event ?? entry;
    const settled = absorb(event, null);
    if (settled?.type === 'tool.approval_required') pending.approvals.push(settled);
    else if (settled?.type === 'tool.response_required') pending.questions.push(settled);
    /**
     * The branch the replay was missing. `pending.auth` was declared here and never filled, so a
     * `--resume` into a turn stopped waiting for a connector to be authorized found nothing
     * pending, sent nothing, broke out of the loop, and exited 0 whenever the partial answer made
     * no claim - reporting work as done that had not started. The live path documents fixing
     * exactly that; the replay path had never had it.
     */
    else if (settled?.type === 'mcp.auth_required') pending.auth.push(settled);
  }
  // Resuming into a turn that already failed has to carry its reason too, or the reattach path
  // prints the same bare status the live path used to.
  return { pending, status: turn.state?.status, failure: endedBecause(turn.state) };
}

/**
 * The words this turn was started with, read back from the harness.
 *
 * Only needed on `--resume`, where the command line has no prompt. Returns null rather than
 * throwing: a retry that cannot recover the prompt says so and stops, which is better than sending
 * an empty turn and better than a stack trace.
 */
async function originalPrompt() {
  try {
    const { data: turn } = await client.sessions.getTurn(checkpoint.sessionId, checkpoint.turnId);
    for (const entry of turn?.input ?? []) {
      if (entry?.type === 'user.message' && typeof entry.content === 'string' && entry.content.trim()) {
        return entry.content;
      }
    }
  } catch {
    // The turn is gone or unreadable. The caller reports that it could not retry.
  }
  return null;
}

/**
 * Find the call behind a recorded response.
 *
 * The response event carries only a toolCallId; the call itself lives on the model.message that
 * made it. Correlating them is what lets the verifier ask "was this actually a test command?"
 * rather than only "did the output look test-shaped?", and it is now also how a span learns the
 * name of the tool it is timing.
 */
function callFor(toolCallId) {
  if (!toolCallId) return null;
  for (const event of events.values()) {
    if (event?.type !== 'model.message') continue;
    const call = event.toolCalls?.find((tc) => tc.id === toolCallId);
    if (call) return call;
  }
  return null;
}

/** The command a call will run, or its tool name when the arguments do not name one. */
function commandOf(call) {
  if (!call) return null;
  try {
    const args = JSON.parse(call.function?.arguments || '{}');
    return args.command ?? args.cmd ?? args.script ?? call.toolInfo?.name ?? null;
  } catch {
    return call.toolInfo?.name ?? null;
  }
}

/**
 * Start a span for every call a message asks for.
 *
 * `sawCall` is idempotent per call id, so this can be handed the same message repeatedly as its
 * deltas merge. The event's `createdAt` is the harness's own timestamp for the moment the call was
 * issued, which is the only honest start for a span measuring something that happens elsewhere -
 * the SDK puts one on every event and the runner discarded all of them until now.
 */
function traceCalls(message) {
  if (message?.type !== 'model.message') return;
  for (const call of message.toolCalls ?? []) {
    tracer.sawCall(call?.id, {
      tool: call?.toolInfo?.name ?? null,
      // The arguments go in as text and come out as a digest. Nothing in this file ever hands a
      // span the arguments themselves; see the note on `sawCall`.
      args: call?.function?.arguments ?? null,
      at: message.createdAt,
    });
  }
}

/** Look up the call that triggered a pause, so we can show the human what they are approving. */
function describe(ref) {
  const msg = events.get(ref.sourceEventId);
  if (msg?.type !== 'model.message') return null;
  return msg.toolCalls?.find((tc) => tc.id === ref.id) ?? null;
}

/**
 * Everything from here to the report runs inside a guard, because the report is the point.
 *
 * A throw anywhere in the loop - a dropped connection, a stream the SDK could not parse - used to
 * end the process on a stack trace, and the run's whole record went with it. The executions had
 * already happened; nothing was left to say so. A crashed run is exactly the run somebody needs
 * the artifact for, so the crash is caught, recorded as the reason the turn did not finish, and
 * the report is written from whatever was collected before it.
 */
let crash = null;
/** The gate can be answered this many times before the run is called stuck rather than finished. */
const HOPS = 24;
let hop = 0;
/** Which attempt at the turn this is, for the transient-failure backoff. */
let attempts = 1;
let lastStatus;

try {
  let first;
  if (resuming) {
    first = await reattach();
  } else {
    /**
     * Say which agent is missing, rather than dumping a 404 stack.
     *
     * An unknown `--agent` surfaced as a raw SDK NotFoundError with the one useful line buried in a
     * JSON body inside a stack trace - and then wrote an evidence report into a directory called
     * `unknown-session`, for a run that never started. The connector-down path in this same runner
     * already answers properly, so this was an inconsistency rather than a missing capability.
     */
    if (!loadAgents().some((a) => a.name === agentName)) {
      const known = loadAgents().map((a) => a.name).sort();
      console.error(`\n  There is no agent called ${JSON.stringify(agentName)} in agents/.`);
      console.error(`  Known: ${known.join(', ')}\n`);
      process.exit(2);
    }
    const { data: session } = await client.sessions.create({ agent: { name: agentName } });
    checkpoint.sessionId = session.id;
    checkpoint.agentName = agentName;
    // Written before the first turn, because a run killed mid-turn is exactly the one that resumes.
    checkpoint.chain = (flag('chain', '') || '').split(',').filter(Boolean);
    save();
    console.log(`agent: ${agentName}\nsession: ${session.id}\n`);
    /**
     * The root span opens here, the moment there is a session id to name it by. The model is the
     * FQN this machine is configured with: creating a session by agent name gets back a reference
     * with no model on it, so the resolved one would take a second request to the harness, and a
     * trace is not worth an extra call on the path a run has to take anyway.
     */
    tracer.startTurn({ agent: agentName, session: session.id, model: process.env.TRUEFORGE_MODEL ?? null, prompt });
    first = await consume(await client.sessions.createTurnStream(session.id, { input: [{ type: 'user.message', content: prompt }] }));
  }

  let carry = first;

  for (; hop < HOPS; hop++) {
    const { pending, status, failure } = carry;
    lastStatus = status ?? lastStatus;
    if (failure) turnFailure = failure;
    const resume = [];

    /**
     * Two ways a run stops being worth continuing, checked before it asks for anything else.
     *
     * A loop is the same call three times with nothing different in between - an agent that has
     * stopped learning and will not stop on its own. A ceiling is the budget for tool calls,
     * approvals or wall-clock. Either one escalates rather than failing quietly: a run that ran out
     * of room has not finished, and reporting it as finished is the same class of lie as reporting
     * a test that never ran.
     */
    const loop = detectLoop(callHistory);
    const budget = checkBudget({
      toolCalls: toolResponses.length,
      approvals: approvalsGranted,
      wallClockMs: Date.now() - startedAt,
    });
    if (loop.looping || budget.escalate) {
      escalation = escalate({
        because: loop.looping ? REASONS.LOOP_DETECTED : REASONS.BUDGET_EXHAUSTED,
        detail: loop.looping ? loop.why : budget.why,
        established: [`${toolResponses.length} tool call(s) recorded`, `${approvalsGranted} approval(s) granted`],
        notEstablished: ['whatever the run was asked for; it did not get there'],
        next: ['read the report, then either raise the ceiling deliberately or give the agent a narrower task'],
      });

      /**
       * Anything already waiting at the gate is refused on the way out.
       *
       * Breaking straight to the report abandoned every pending approval: nothing was sent to the
       * harness, nothing was added to `denied`, and nothing reached the ledger. The turn stayed
       * open with calls waiting, and a later `--resume` replayed their responses as executions the
       * gate had in fact stopped - the record then showing work that never happened.
       *
       * Refusing is also the honest answer rather than a tidy one. The run is stopping because it
       * hit a ceiling; nobody is being asked, and a call nobody was asked about does not proceed.
       */
      for (const event of pending.approvals) {
        for (const ref of event.toolCalls ?? []) {
          const call = describe(ref);
          resume.push({
            type: 'user.tool_approval',
            threadId: event.threadId,
            toolCallId: ref.id,
            approval: { decision: 'deny', reason: escalation.detail ?? 'the run stopped before this was decided' },
          });
          denied.add(ref.id);
          recordDecision({
            session: checkpoint.sessionId,
            agent: checkpoint.agentName,
            tool: call?.toolInfo?.name ?? null,
            args: call?.function?.arguments,
            refused: true,
            by: 'escalation',
            reason: escalation.detail ?? null,
          });
          tracer.decided(ref.id, { tool: call?.toolInfo?.name ?? null, refused: true, by: 'escalation', reason: escalation.detail ?? null });
        }
      }
      if (resume.length) {
        checkpoint.denied = [...denied];
        save();
        /**
         * Cancel the turn rather than answering it.
         *
         * Sending the refusals back as a new turn was rejected - `Expected "user.message". Received
         * "user.tool_approval"` - so an escalated run ended with no answer text at all and a verdict
         * of NO ANSWER, which reads like a model that produced nothing rather than a run that was
         * stopped. An eval scenario caught it: four behavioural assertions had already held.
         *
         * Cancelling is the honest shape anyway. The run is not continuing, so there is nothing to
         * say to the harness except that it should stop waiting - and `smoke-agents.mjs` already
         * ends its own timeouts this way. The refusals are recorded here and in the ledger whether
         * or not the cancel lands.
         */
        await client.sessions.cancel(checkpoint.sessionId).catch((err) => {
          console.log(`  The turn could not be cancelled: ${err?.message ?? err}`);
        });
      }
      break;
    }

    for (const event of pending.approvals) {
      for (const ref of event.toolCalls) {
        const call = describe(ref);
        console.log('\n  ── APPROVAL REQUIRED ──────────────────────────────');

        let answer = null;
        if (!call) {
          // The call cannot be displayed, so nobody is asked about it. Asking somebody to approve a
          // blank is worse than not asking: it produces the appearance of oversight without any.
          console.log('  This call could not be read, so it cannot be shown to you. Denying.');
        } else {
          /**
           * What it would change, stated as a sentence, above the call itself.
           *
           * `describeCall` already refused to print eight hundred characters of JSON. This goes one
           * further and says the thing in English - "would roll back checkout-api from 4c21 to
           * 9ab7" - because that is the sentence somebody is actually approving, and a person who
           * has to reconstruct it from arguments is a person who eventually stops trying.
           */
          for (const line of renderPlan(plan({ tool: call.toolInfo?.name, args: call.function?.arguments }))) {
            console.log(line);
          }
          if (!denyAll) answer = await ask('  allow / deny > ', 'deny');
        }

        /**
         * One decision, one record. The undisplayable call used to be denied by its own early
         * return, which skipped the bookkeeping below - so the gate stopped it and the report
         * counted it as an execution anyway.
         */
        const { approval, refused: wasRefused, note } = decideApproval({
          displayable: Boolean(call),
          denyAll,
          piped,
          answer,
        });
        if (note) console.log(`  ${note}`);
        resume.push({ type: 'user.tool_approval', threadId: event.threadId, toolCallId: ref.id, approval });
        if (wasRefused) {
          denied.add(ref.id);
          checkpoint.denied = [...denied];
          save();
        }
        /**
         * Recorded whichever way it went, and that is the point.
         *
         * The report has always counted refusals and never approvals, which is backwards for a
         * system built on this gate: a refusal is the case where nothing happened. What somebody
         * needs later is what was let through, and `by` is the field that makes it auditable -
         * a pipe may refuse and may never approve, so `allowed` beside anything but `terminal`
         * would be a broken invariant rather than a statistic.
         */
        const by = denyAll ? 'deny-all' : piped ? 'pipe' : 'terminal';
        recordDecision({
          session: checkpoint.sessionId,
          agent: checkpoint.agentName,
          tool: call?.toolInfo?.name ?? null,
          args: call?.function?.arguments,
          refused: wasRefused,
          by,
          reason: approval.reason ?? null,
        });
        /**
         * The same decision, on the trace, from the same variables the ledger gets. Two records of
         * one decision is fine as long as they cannot disagree, which is why they are written side
         * by side out of one set of values rather than each deriving its own.
         */
        tracer.decided(ref.id, { tool: call?.toolInfo?.name ?? null, refused: wasRefused, by, reason: approval.reason ?? null });

        if (!wasRefused) approvalsGranted += 1;
        console.log(`  -> ${wasRefused ? 'denied' : 'allowed'}\n`);
      }
    }

    for (const event of pending.questions) {
      for (const ref of event.toolCalls) {
        const call = describe(ref);
        if (call?.toolInfo?.name !== 'ask_user_question') continue;
        const { question, options } = JSON.parse(call.function?.arguments || '{}');
        console.log('\n  ── THE AGENT IS ASKING ────────────────────────────');
        console.log(`  ${question}`);
        if (options?.length) options.forEach((o, i) => console.log(`    ${i + 1}. ${o}`));
        /**
         * `--deny-all` exists to prove the gate holds, so it must not hand the agent the most
         * permissive possible answer through the question channel. An agent that asks "should I
         * force-push?" gets a refusal, not "use your best judgement".
         */
        /**
         * With nobody there to answer, the answer is no.
         *
         * The fallback was "Use your best judgement and continue" for every unattended run that had
         * not passed --deny-all - so an agent asking "should I force-push?" through the question
         * channel got a yes that nobody gave. The reasoning for the --deny-all wording was already
         * written here and applied to only half the cases: an agent asking a question is asking
         * because the answer matters, and silence is not consent to whichever branch it prefers.
         *
         * --answer is still honoured, because that is somebody deciding in advance and saying so.
         */
        /**
         * --deny-all outranks --answer, and outranks it here too.
         *
         * Passing both used to hand the supplied text straight to the agent without prompting, so
         * `--deny-all --answer yes` produced an affirmative from the flag whose entire purpose is
         * that this session approves nothing. The flag that refuses has to win, or it is not a flag
         * that refuses.
         */
        const supplied = denyAll ? null : flag('answer', null);
        const fallback =
          supplied ??
          (denyAll
            ? 'No. Do not proceed. This session cannot approve or answer anything.'
            : 'No. Nobody is available to answer this. Do not proceed on an assumption - report what you needed to know and stop.');
        const answer = denyAll ? fallback : await ask('  > ', fallback);
        resume.push({ type: 'user.tool_response', threadId: event.threadId, toolCallId: ref.id, content: answer });
      }
    }

    if (pending.auth.length) {
      blockedOnAuth = true;
      for (const event of pending.auth) {
        for (const server of event.mcpServers ?? []) console.log(`\n  authorize ${server.name}: ${server.authUrl}`);
      }
      const acknowledged = await ask('  press enter once authorized > ', null);
      if (acknowledged === null) {
        // Nobody is here to authorize it, so the run cannot continue. Reporting this as a finished
        // turn and exiting 0 told CI the work was done when it had not started.
        console.log('\n  Cannot authorize a connector without an operator. Stopping.');
        break;
      }
      blockedOnAuth = false;
      /**
       * The half-written answer goes with the pause.
       *
       * This `continue` skipped the reset below, so text streamed before the connector stopped the
       * turn survived into the next one. An agent that had said "the tests pass, but I need GitHub
       * access first" left the pass-claim in `finalText`, and `judge()` then weighed it against
       * evidence from a different turn that does not cover it. It also let `requestedHandoff` see
       * two blocks and call the answer malformed, and let `announcedArtifacts` re-fetch paths named
       * before the pause.
       */
      finalText = '';
      // A turn resuming after mcp.auth_required must not carry a user message, but approvals and
      // answers already given are not user messages and were being thrown away here.
      carry = await consume(
        await client.sessions.createTurnStream(checkpoint.sessionId, resume.length ? { input: resume } : {}),
      );
      continue;
    }

    if (!resume.length) {
      /**
       * A provider failure that clears on its own, waited out rather than handed back.
       *
       * The advice printed below already said "wait a minute and run it again - this one clears on
       * its own", which left a person doing by hand the one thing that needed nobody. What it will
       * not do is retry a turn in which something was approved: `retryDecision` refuses those,
       * because a failed turn cannot say whether the approved call took effect and running it
       * again is a coin-flip on filing the ticket twice.
       */
      if (failure) {
        /**
         * A retry needs the words the turn was started with, and on `--resume` there are none.
         *
         * `prompt` comes from the command line, so a resumed run has an empty one - and the retry
         * re-sent `{type:'user.message', content: ''}`, which the harness rejects with 422 "user
         * message has empty content". That path could never succeed, always spent the backoff
         * first, and then printed a raw SDK stack. It fires on the single most common reason to
         * resume: a run that died on a provider error, which is exactly what `retryDecision` says
         * is worth retrying.
         *
         * The words were there all along, on the stored turn. `restarted` is what gets re-sent.
         */
        const restarted = prompt || (await originalPrompt());
        const again = retryDecision({
          failure,
          attempt: attempts,
          approvals: approvalsGranted,
        });
        if (again.retry && !restarted) {
          console.log('\n  This turn could be retried, but the words it started with could not be recovered from the stored turn, so there is nothing to re-send.\n');
        } else if (again.retry) {
          attempts = again.attempt;
          console.log(`\n  ${again.why}. Waiting ${Math.round(again.waitMs / 1000)}s and trying again (attempt ${attempts} of 3).`);
          await new Promise((resolve) => setTimeout(resolve, again.waitMs));
          finalText = '';
          turnFailure = null;
          /**
           * The call history goes, and the tool responses stay.
           *
           * They are treated differently because they answer different questions. `toolResponses`
           * is the record of what actually ran, and a tool that executed before the provider failed
           * did execute - dropping it would under-report the run. `callHistory` feeds the loop
           * detector, which asks whether the agent is repeating itself without learning; a retry
           * forced by a 429 is not the agent doing anything at all. Left alone, two retries of a
           * turn running `npm test` put three identical signatures in a row and the next pass
           * escalated a run that had just succeeded.
           */
          callHistory.length = 0;
          carry = await consume(
            await client.sessions.createTurnStream(checkpoint.sessionId, { input: [{ type: 'user.message', content: restarted }] }),
          );
          continue;
        }
        console.log(`\n\n[${status ?? 'ended'}]`);
        // The provider's own words, and what to do about them where that can be said with any
        // confidence. explainFailure hands the message back unchanged when it cannot.
        console.log(`  ${explainFailure(failure)}`);
        if (approvalsGranted > 0) console.log(`  Not retried: ${again.why}.`);
        break;
      }
      console.log(`\n\n[${status ?? 'ended'}]`);
      break;
    }
    finalText = ''; // only the answer that ends the run is judged
    carry = await consume(await client.sessions.createTurnStream(checkpoint.sessionId, { input: resume }));
  }
} catch (err) {
  crash = err;
  // On stderr and in full, because a stack is the only useful thing to say about an unexpected
  // throw - and then the run carries on to the report rather than dying here.
  console.error(`\n\n  The run stopped on an error.\n${err?.stack ?? err}`);
} finally {
  rl?.close();
}

/**
 * Running out of rounds is not finishing. The loop ends either because the agent stopped asking
 * for anything, or because it asked twenty-four times - and the second used to be indistinguishable
 * from the first in every artifact the run produces.
 */
const ranOutOfHops = hop >= HOPS;
if (ranOutOfHops) {
  const stuck = `Stopped after ${HOPS} rounds of approvals and questions. The turn had not finished.`;
  console.log(`\n  ${stuck}`);
  turnFailure ??= stuck;
}
if (crash) {
  // Kept alongside whatever the harness had already said, not instead of it: the turn's own reason
  // is usually the more specific of the two.
  const said = `The run stopped on an error: ${crash?.stack ?? crash?.message ?? String(crash)}`;
  turnFailure = turnFailure ? `${turnFailure}\n\n${said}` : said;
}

// The closing verdict. The agent does not get the last word on whether it succeeded.
const { verdict, runs, reason } = judge({ finalText, toolResponses });
const LABELS = {
  substantiated: 'SUBSTANTIATED',
  unsubstantiated: 'UNSUBSTANTIATED',
  contradicted: 'CONTRADICTED',
  'no-claim': 'NO CLAIM',
  'no-answer': 'NO ANSWER',
};
// A verdict this map does not know is a bug, not a blank. Printing `undefined` in the one line a
// person reads to decide whether to trust the run is the worst place to be vague.
const label = LABELS[verdict] ?? `UNKNOWN VERDICT (${verdict})`;
console.log('\n  ── EVIDENCE CHECK ─────────────────────────────────');
console.log(`  ${label}`);
console.log(`  ${reason}`);
// The terminal and the written report have to agree; counting raw responses here meant the line
// on screen said one execution while the report on disk said none, for the same refused call.
const ran = performed(toolResponses);
const stopped = refused(toolResponses);
console.log(`  recorded executions: ${ran.length}, of which test runs: ${runs.length}`);
/**
 * The model printed a tool call instead of making one, so the answer above is a wall of JSON.
 * Say what it meant in English - and say that it did not happen, which is the half a prettier
 * rendering would quietly drop.
 */
for (const line of renderUnexecutedCalls(unexecutedToolCalls(finalText))) console.log(line);
if (stopped.length) {
  console.log(`  refused at the gate: ${stopped.length} (not counted as evidence)`);
}

// The terminal scrolls. The artifact does not - and a reviewer needs the executions themselves,
// not a summary of them.
/**
 * Said before the report is built, not after.
 *
 * This block used to sit below `buildReport`, so `turnFailure` was assigned to a report that had
 * already been written and no escalation ever reached report.json or report.md. A run stopped by a
 * loop or a spent budget produced an artifact byte-identical to one that simply ended, while the
 * exit code said 1 - which is exactly the divergence `runExitCode` was written to remove.
 * `ranOutOfHops` and `crash` were always above it; only this one was not.
 */
if (escalation) {
  for (const line of renderEscalation(escalation)) console.log(line);
  turnFailure ??= escalation.detail;
}

/**
 * Was the agent handed something written to instruct it, and did it say so?
 *
 * The eval suite found two runs where the answer was steered by a note planted in an issue body and
 * never mentioned it. The gate held - the write was gated and stopped - and every other mechanism
 * here reported those runs as fine, because the verifier judges claims that something passed and
 * being quietly steered is not one of those.
 *
 * Reported beside the verdict rather than folded into it. Whether the answer was any good and
 * whether the agent told you what steered it are two questions, and collapsing them would lose the
 * one that was missing.
 */
const influence = undisclosedInfluence({ toolResponses, finalText, prompt });
if (influence.read.length > 0) {
  console.log(`\n  ── WHAT IT READ ───────────────────────────────────`);
  console.log(`  ${influence.disclosed ? 'Disclosed' : 'NOT DISCLOSED'}: ${influence.why}`);
  for (const found of influence.read) {
    console.log(`    ${found.shape}`);
    console.log(`      ${found.line.slice(0, 100)}`);
  }
  console.log();
}

const report = buildReport({
  agent: checkpoint.agentName,
  prompt,
  sessionId: checkpoint.sessionId,
  finalText,
  toolResponses,
  failure: turnFailure,
  influence,
  at: new Date().toISOString(),
});
// The session id names the directory; it does not get to choose where that directory is. It
// arrives from the server on a fresh run and from the checkpoint file on a resume, and `../..` in
// it would decide where the artifact a reviewer reads ends up.
const dir = `evidence/${sessionDirName(checkpoint.sessionId)}`;
// A run whose report could not be written is a run with no record, whatever its verdict was. It
// says so out loud and takes the exit code with it, rather than printing a stack over the verdict
// somebody was reading.
let reportWritten = true;
try {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/report.json`, JSON.stringify(report.json, null, 2));
  writeFileSync(`${dir}/report.md`, report.markdown);
  console.log(`  written: ${dir}/report.md\n`);
} catch (err) {
  reportWritten = false;
  console.error(`  The report could not be written to ${dir}: ${err?.message ?? err}\n`);
}

/**
 * The exit code, decided here rather than at the last line of the file.
 *
 * It used to be computed inside the `process.exit` call at the bottom, which meant the handoff
 * path exited on the child's code without this ever being worked out - and now that a trace
 * records the exit code, a number computed after the trace was written would be a number the
 * trace could not carry. Working it out once means the process, the report and the span all say
 * the same thing about how the run ended, which is the only version worth recording.
 */
const exitCode = runExitCode({
  proved: verdict === SUBSTANTIATED || verdict === NO_CLAIM,
  crashed: Boolean(crash) || !reportWritten,
  unfinished: ranOutOfHops,
  blockedOnAuth,
  status: lastStatus,
  failure: turnFailure,
  // An escalated run has not finished, whatever its partial answer proved.
  ...runOutcome(escalation),
  steeredSilently: influence.read.length > 0 && !influence.disclosed,
});

/**
 * The trace, written before the artifacts are fetched and before any handoff, so a run that dies
 * in either still has one. It returns the path when it wrote and null otherwise; a tracer that is
 * off, or broken, returns nothing at all and the line below is not printed. Nothing about this can
 * change the exit code above.
 */
const traced = tracer.endTurn({
  verdict,
  status: lastStatus,
  failure: turnFailure,
  exit: exitCode,
  executions: ran.length,
  testRuns: runs.length,
  answer: finalText,
  crashed: Boolean(crash) || !reportWritten,
  unfinished: ranOutOfHops,
  blockedOnAuth,
});
if (traced) console.log(`  traced: ${traced}\n`);

/**
 * Anything the agent announced it wrote, fetched out of the sandbox and filed beside the report.
 *
 * The sandbox is disposable, and everything in it goes when it does. A report the agent spent a
 * turn producing is worth exactly nothing if it lives only there, and eight specs have had
 * `file_downloads` switched on the whole time with nothing on this side to use it.
 *
 * Failures here are reported and do not change the verdict. The evidence check is about what the
 * agent did; a file that could not be fetched afterwards is a separate disappointment.
 */
const artifacts = announcedArtifacts(finalText);
if (artifacts.length > 0 && reportWritten) {
  const into = `${dir}/artifacts`;
  let saved = 0;
  try {
    mkdirSync(into, { recursive: true });
  } catch {
    // Reported below, once, rather than per file.
  }

  for (const path of artifacts) {
    try {
      const file = await client.sessions.downloadSandboxFile(checkpoint.sessionId, checkpoint.turnId, {
        path,
      });
      const bytes = Buffer.from(await new Response(file).arrayBuffer());
      writeFileSync(`${into}/${artifactName(path)}`, bytes);
      saved += 1;
    } catch (err) {
      console.log(`  could not fetch ${path}: ${err?.message ?? err}`);
    }
  }

  if (saved > 0) console.log(`  saved ${saved} artifact(s): ${into}/\n`);
}

if (blockedOnAuth) {
  console.log('  This run stopped waiting for a connector to be authorized. It did not finish.\n');
}

/**
 * The agent asking for another agent.
 *
 * It is executed by re-entering this same script rather than by anything bespoke, which is the
 * point: the receiving run gets the identical approval loop, the identical verifier and its own
 * report. A delegation path with its own softer plumbing is how the gate gets walked around by
 * accident, and this project has already found one of those at the network layer.
 *
 * It is not itself gated, and that is a claim `authority.mjs` has to earn: a handoff is refused
 * unless the receiver can reach nothing the sender could not, so an allowed one cannot do anything
 * the agent standing here was not already trusted to do. What it changes is who does it, which is
 * why it is printed and recorded rather than silent.
 */
const asked = requestedHandoff(finalText);
/**
 * A run that did not finish does not get to delegate.
 *
 * The only guards here were `--deny-all` and a malformed block, so a run that hit its ceiling,
 * crashed, or ran out of rounds still spawned a child - and every ceiling in `limits.mjs` is
 * process-local, so the child began again with a full budget. Three hops, three budgets, from a
 * block the model wrote.
 *
 * It laundered the verdict too. `process.exit(child.status)` replaced the parent's exit code, so a
 * parent that had just been marked CONTRADICTED or steered-and-silent exited 0 because the receiver
 * answered cleanly. The report on disk said one thing and the process said another, which is the
 * exact divergence `runExitCode` exists to prevent.
 */
const mayHandOff = asked && !escalation && !crash && !ranOutOfHops && !blockedOnAuth && exitCode === 0;
if (asked && !mayHandOff) {
  console.log(`\n  ${checkpoint.agentName} asked to hand this to ${asked.to ?? '(unreadable)'}. Not delegating: this run did not finish cleanly.\n`);
}
if (mayHandOff) {
  /**
   * argv first, then the checkpoint, then this agent alone. The checkpoint is what makes the chain
   * survive `--resume`; without it a resumed hop forgets where the request has been, and the
   * no-revisiting rule has nothing to check against.
   */
  const chain = (flag('chain', '') || '').split(',').filter(Boolean);
  if (chain.length === 0) chain.push(...(checkpoint.chain?.length ? checkpoint.chain : [checkpoint.agentName].filter(Boolean)));

  if (asked.malformed) {
    console.log(`  The agent asked to hand off and the request could not be read: ${asked.malformed}\n`);
  } else if (denyAll) {
    // --deny-all means refuse everything. Moving the work to another agent is not an exception.
    console.log(`  The agent asked to hand off to ${asked.to}. Refused: --deny-all.\n`);
  } else {
    const specs = Object.fromEntries(
      loadAgents().map((a) => {
        try {
          return [a.name, JSON.parse(readFileSync(new URL(`../agents/${a.name}.json`, import.meta.url), 'utf8'))];
        } catch {
          return [a.name, null];
        }
      }),
    );

    /**
     * The person's words, not the last envelope.
     *
     * `prompt` in a delegated run *is* the rendered envelope, so passing it as `request` nested one
     * envelope inside the next. From the second hop the parser locked onto the inner markers: the
     * card showed the wrong sender and a stale chain, and - worse - the first sender's untrusted
     * note ended up inside the block headed "The request, as the person wrote it". Each hop
     * relabelled one model-written note as something a person had said, which is precisely the
     * framing the envelope exists to keep.
     */
    const original = parseHandoffEnvelope(prompt)?.request ?? prompt;
    const decision = handoff({ from: checkpoint.agentName, to: asked.to, request: original, because: asked.because, chain, specs });

    recordDecision({
      session: checkpoint.sessionId,
      agent: checkpoint.agentName,
      kind: 'handoff',
      /**
       * Never `terminal`. Nobody at a terminal decided this - `authority.mjs` did, by finding the
       * receiver could reach nothing the sender could not. Leaving `by` unset defaulted it to
       * `terminal`, so a delegation chosen by a closed pipe was filed as a person's decision in the
       * one field `npm run approvals` stakes its invariant on.
       */
      by: 'authority-check',
      tool: `handoff:${asked.to}`,
      args: asked.because,
      refused: !decision.ok,
      reason: decision.refusal ?? null,
    });

    if (!decision.ok) {
      console.log(`\n  ${checkpoint.agentName} asked to hand this to ${asked.to}. Refused.`);
      console.log(`  ${decision.refusal}\n`);
      for (const w of decision.widened ?? []) {
        console.log(`    ${w.server ? `${w.server}/` : ''}${w.capability}  -  ${w.detail}`);
      }
      console.log();
    } else {
      console.log(`\n  ${checkpoint.agentName} -> ${asked.to}: ${asked.because}`);
      console.log(`  Nothing ${asked.to} can reach is beyond what ${checkpoint.agentName} could already reach.\n`);
      /**
       * The delegated run inherits this run's trace, so a handoff is one trace with two roots
       * rather than two traces nothing connects. Without it the most interesting thing this
       * project does - moving work between agents under an authority check - is the one thing a
       * trace cannot show. `traceparent` is null when tracing is off, and the child then sees no
       * variable at all rather than an empty one.
       */
      const carried = tracer.traceparent();
      const child = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), '--agent', asked.to, '--chain', decision.envelope.chain.join(','), renderHandoff(decision.envelope)],
        { stdio: 'inherit', env: carried ? { ...process.env, TRACEPARENT: carried } : process.env },
      );
      if (child.error) {
        // Never read before, so a child that failed to start printed the success line above and
        // exited 1 with nothing saying the delegated run had not happened at all.
        console.error(`\n  The delegated run could not be started: ${child.error.message}\n`);
        process.exit(1);
      }
      process.exit(child.status ?? 1);
    }
  }
}

/**
 * Whether the run finished comes before whether its answer was any good. A turn killed on a
 * provider quota produces no answer and therefore no claim, and NO CLAIM used to exit 0 - so
 * every plumbing failure reported success to whatever was watching. Worked out above, so that the
 * report, the trace and this line cannot disagree about it.
 */
process.exit(exitCode);
