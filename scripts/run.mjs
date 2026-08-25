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
import { TrueForge, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import { loadEnv } from './lib/env.mjs';

loadEnv();
import { judge, performed, refused, resultOf, SUBSTANTIATED, NO_CLAIM } from './lib/evidence.mjs';
import { buildReport } from './lib/report.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const denyAll = argv.includes('--deny-all');
const resuming = argv.includes('--resume');
const agentName = flag('agent', 'quartermaster-local');
const prompt = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--agent' && argv[i - 1] !== '--answer').join(' ');

if (!prompt && !resuming) {
  console.error('usage: node scripts/run.mjs [--agent <name>] [--deny-all] "<prompt>"\n       node scripts/run.mjs --resume');
  process.exit(2);
}

const client = new TrueForge({
  baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790',
  timeoutInSeconds: 900,
});

/**
 * The checkpoint is the whole resilience story: session id, the turn in flight, and how far we
 * read. Everything else - history, tool results, the agent's place in its own loop - lives on the
 * server. This process is disposable by design.
 */
const CHECKPOINT = '.quartermaster/run.json';
let checkpoint = { sessionId: null, turnId: null, lastSequenceNumber: 0, agentName, denied: [] };
const save = () => {
  mkdirSync('.quartermaster', { recursive: true });
  writeFileSync(CHECKPOINT, JSON.stringify(checkpoint, null, 2));
};

const events = new Map();
const toolResponses = [];
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
const interactive = stdin.isTTY;
const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;

/**
 * Ask the operator, or fall back when there is no operator to ask.
 *
 * The fallback for an approval is always deny. A gate that quietly allows when nobody is watching
 * is not a gate, and this agent's whole argument is that the unattended path must be the safe one.
 */
async function ask(question, fallback) {
  if (!rl) {
    console.log(`${question}${fallback}   [non-interactive]`);
    return fallback;
  }
  return (await rl.question(question)).trim();
}

/** Fold one event into local state. Shared by the live stream and the replay path. */
function absorb(event, sequenceId) {
  // A non-numeric id would write NaN, which JSON.stringify stores as null and resume then sends
  // as afterSequenceNumber. Corrupt, and invisible in the checkpoint file.
  const sequence = Number(sequenceId);
  if (sequenceId != null && Number.isFinite(sequence)) checkpoint.lastSequenceNumber = sequence;
  if (isEventDelta(event)) {
    const base = events.get(event.id);
    if (base) mergeEventDelta(base, event);
    if (event.type === 'model.message.delta') {
      stdout.write(event.content ?? '');
      finalText += event.content ?? '';
    }
    return null;
  }
  events.set(event.id, event);

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
    case 'sandbox.created':
      console.log('\n  [sandbox provisioned]');
      break;
    case 'thread.created':
      console.log('\n  [subagent started]');
      break;
    case 'tool.response': {
      // Attach the command that produced this output. Without it the evidence rules can only
      // classify a test run by how its text looks, and `echo ok` looks like a passing test.
      const command = commandFor(event.toolCallId);
      /**
       * A refused call arrives here like any other, with no output and no exit code. Recorded
       * plainly it is indistinguishable from a command that ran and printed nothing, and the
       * evidence then counts the thing the gate stopped as a thing that happened.
       */
      const wasDenied = denied.has(event.toolCallId);
      toolResponses.push({ ...resultOf(event, command), denied: wasDenied });
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
    else if (settled.type === 'turn.done') status = settled.state?.status;
  }
  save();
  return { pending, status };
}

/** Reattach to whatever this machine was last doing, without replaying what we already saw. */
async function reattach() {
  try {
    checkpoint = { ...checkpoint, ...JSON.parse(readFileSync(CHECKPOINT, 'utf8')) };
  for (const id of checkpoint.denied ?? []) denied.add(id);
  } catch {
    console.error(`No checkpoint at ${CHECKPOINT}. Start a run first.`);
    process.exit(2);
  }
  const { sessionId, turnId, lastSequenceNumber } = checkpoint;
  console.log(`reattaching to session ${sessionId}, turn ${turnId}, after event ${lastSequenceNumber}\n`);

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
  }
  return { pending, status: turn.state?.status };
}

/**
 * Find the command behind a recorded response.
 *
 * The response event carries only a toolCallId; the command lives on the model.message that made
 * the call. Correlating them is what lets the verifier ask "was this actually a test command?"
 * rather than only "did the output look test-shaped?".
 */
function commandFor(toolCallId) {
  if (!toolCallId) return null;
  for (const event of events.values()) {
    if (event?.type !== 'model.message') continue;
    const call = event.toolCalls?.find((tc) => tc.id === toolCallId);
    if (!call) continue;
    try {
      const args = JSON.parse(call.function?.arguments || '{}');
      return args.command ?? args.cmd ?? args.script ?? call.toolInfo?.name ?? null;
    } catch {
      return call.toolInfo?.name ?? null;
    }
  }
  return null;
}

/** Look up the call that triggered a pause, so we can show the human what they are approving. */
function describe(ref) {
  const msg = events.get(ref.sourceEventId);
  if (msg?.type !== 'model.message') return null;
  return msg.toolCalls?.find((tc) => tc.id === ref.id) ?? null;
}

let first;
if (resuming) {
  first = await reattach();
} else {
  const { data: session } = await client.sessions.create({ agent: { name: agentName } });
  checkpoint.sessionId = session.id;
  checkpoint.agentName = agentName;
  save();
  console.log(`agent: ${agentName}\nsession: ${session.id}\n`);
  first = await consume(await client.sessions.createTurnStream(session.id, { input: [{ type: 'user.message', content: prompt }] }));
}

let carry = first;

for (let hop = 0; hop < 24; hop++) {
  const { pending, status } = carry;
  const resume = [];

  for (const event of pending.approvals) {
    for (const ref of event.toolCalls) {
      const call = describe(ref);
      console.log('\n  ── APPROVAL REQUIRED ──────────────────────────────');
      console.log(`  tool: ${call?.toolInfo?.name ?? 'unknown tool'}`);
      console.log(`  args: ${(call?.function?.arguments ?? '').slice(0, 800)}`);
      const answer = denyAll ? 'deny' : (await ask('  allow / deny > ', 'deny')).toLowerCase().trim();
      /**
       * Exact words only. This used to accept anything starting with "a", so `abort` - the word an
       * operator reaches for when they have just realised they do not want this - approved the
       * call. Anything unrecognised is a denial.
       */
      const allowed = !denyAll && ['allow', 'yes', 'y', 'approve'].includes(answer);
      resume.push({
        type: 'user.tool_approval',
        threadId: event.threadId,
        toolCallId: ref.id,
        approval: allowed
          ? { status: 'allow' }
          : { status: 'deny', reason: denyAll ? 'denied by --deny-all' : 'denied by the operator' },
      });
      if (!allowed) {
        denied.add(ref.id);
        checkpoint.denied = [...denied];
        save();
      }
      console.log(`  -> ${allowed ? 'allowed' : 'denied'}\n`);
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
      const fallback = denyAll
        ? 'No. Do not proceed. This session cannot approve anything.'
        : (flag('answer', null) ?? 'Use your best judgement and continue.');
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
    // A turn resuming after mcp.auth_required must not carry a user message, but approvals and
    // answers already given are not user messages and were being thrown away here.
    carry = await consume(
      await client.sessions.createTurnStream(checkpoint.sessionId, resume.length ? { input: resume } : {}),
    );
    continue;
  }

  if (!resume.length) {
    console.log(`\n\n[${status ?? 'ended'}]`);
    break;
  }
  finalText = ''; // only the answer that ends the run is judged
  carry = await consume(await client.sessions.createTurnStream(checkpoint.sessionId, { input: resume }));
}

rl?.close();

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
if (stopped.length) {
  console.log(`  refused at the gate: ${stopped.length} (not counted as evidence)`);
}

// The terminal scrolls. The artifact does not - and a reviewer needs the executions themselves,
// not a summary of them.
const report = buildReport({
  agent: checkpoint.agentName,
  prompt,
  sessionId: checkpoint.sessionId,
  finalText,
  toolResponses,
  at: new Date().toISOString(),
});
const dir = `evidence/${checkpoint.sessionId}`;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/report.json`, JSON.stringify(report.json, null, 2));
writeFileSync(`${dir}/report.md`, report.markdown);
console.log(`  written: ${dir}/report.md\n`);

if (blockedOnAuth) {
  console.log('  This run stopped waiting for a connector to be authorized. It did not finish.\n');
  process.exit(1);
}

process.exit(verdict === SUBSTANTIATED || verdict === NO_CLAIM ? 0 : 1);
