/**
 * OpenTelemetry traces for a run, written to a file on this machine and sent nowhere.
 *
 * WHY THIS EXISTS, stated plainly because it is not what it looks like: this is not a hackathon
 * requirement. The rules ask for a public repository, Qodo review evidence, a demo video, and a
 * judge watching TrueForge reach a tool, run code in a sandbox and stop for a person. None of that
 * needs a span.
 *
 * It exists because a harness meant for production is judged on whether somebody could operate it,
 * and "how would I run this?" is a different question from "does it work?". This project already
 * records two things well - a per-session report and an append-only approval ledger - and neither
 * answers what an operator asks about a fleet: how long do turns take, where does the time go,
 * which tools are slow, how often is the gate hit, how are the verdicts trending. Those are trace
 * questions, and OpenTelemetry is the vocabulary everybody else asks them in. "No telemetry" is
 * the first thing an SRE says about a tool like this, and they are right to.
 *
 * WHAT IT IS NOT. It is not an OpenTelemetry SDK and does not claim to be one. It writes the
 * OTLP/JSON wire format - one `ExportTraceServiceRequest` document per line - which the
 * collector's `otlpjsonfilereceiver` reads directly. That buys the whole ecosystem for about three
 * hundred lines and no dependency. `package.json` has two runtime dependencies today and a person
 * can audit both; pulling in the `@opentelemetry/*` tree to emit four spans a run would trade that
 * property away for an API this file does not need.
 *
 * WHAT THE HARNESS ALREADY DOES, since it changes what is left to do here. TrueForge has a
 * tracing seam - `AgentTracing`, with hooks for a root span, sub-agent spans and tool spans - and
 * the open build wires it to `NoopAgentTracing` and never overrides it. So there are no spans
 * coming from that side, and no flag that produces any. What the SDK does carry, and what the
 * runner threw away until now, is timing and cost: every event has a server `createdAt`, and
 * `turn.done` carries token counts and an estimated cost. Those are used below rather than
 * re-measured, because a duration derived from the server's own clock beats one guessed at from
 * when a packet happened to arrive here.
 *
 * THREE RULES, each of them a mistake that would be worse than having no tracing at all:
 *
 *   1. Off unless somebody asks. `QUARTERMASTER_OTEL=1`, and nothing else turns it on. A harness
 *      that phones somewhere by default is a harness nobody deploys.
 *   2. No payloads, ever. Tool arguments carry issue bodies, commit contents and email drafts.
 *      `ledger.mjs` already made this decision and this file reuses its `digest` rather than
 *      reasoning about it a second time.
 *   3. Failure is silent and total. A broken exporter must not change the exit code, the verdict,
 *      or anything else about the run. Everything below is wrapped.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { digest } from './ledger.mjs';
import { adviseOnFailure } from './model-advice.mjs';
import { endedBadly } from './turn-state.mjs';

/**
 * Beside `evidence/approvals.jsonl`, and for the same reasons: JSON lines survives being read by
 * `grep` at three in the morning, and appending means a killed run leaves the runs before it
 * intact. `evidence/` is gitignored, so a trace never reaches a commit by accident.
 */
export const TRACES = 'evidence/traces.jsonl';

/** The instrumentation scope. Named for the thing that produced the spans, not for a library. */
const SCOPE = 'quartermaster/run';

/**
 * OTLP span kinds, as integers, because "enum fields MUST be encoded as integer values".
 *
 * The root is CLIENT and the tool spans are INTERNAL, and the asymmetry is deliberate. This
 * process is a client of the harness: it opens a session over HTTP and the agent runs somewhere
 * else. The tool spans are INTERNAL because that is the only kind the convention defines for
 * `execute_tool`, and because what they measure is not what the sandbox spent - see `sawCall`.
 */
const CLIENT = 3;
const INTERNAL = 1;

/** OTLP status codes. There is no OK here; nothing below has the standing to declare success. */
const UNSET = 0;
const ERROR = 2;

/**
 * Is tracing on?
 *
 * Exact values only, the same discipline `decideApproval` uses on the words that mean "allow".
 * Anything unrecognised is off, so a typo fails closed rather than starting an exporter nobody
 * asked for.
 *
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is deliberately NOT read. It is a common ambient variable - a
 * machine running any other instrumented service will have one set - and honouring it would mean
 * quartermaster started emitting because a neighbouring tool was configured. That is the same
 * failure as being on by default, one step removed. Nothing here posts to a network at all.
 *
 * `OTEL_SDK_DISABLED` is honoured, and wins. It is the standard kill switch, and an operator who
 * reaches for it is entitled to have it work on everything, including the parts that invented
 * their own switch.
 */
export function tracingEnabled(env = process.env) {
  if (String(env?.OTEL_SDK_DISABLED ?? '').trim().toLowerCase() === 'true') return false;
  const asked = String(env?.QUARTERMASTER_OTEL ?? '').trim().toLowerCase();
  return asked === '1' || asked === 'true' || asked === 'yes' || asked === 'on';
}

/**
 * A W3C `traceparent`, so a handoff is one trace rather than two.
 *
 * A handoff re-enters `run.mjs` as a child process. Without this the delegated run gets its own
 * trace id and the delegation - one of the few things here worth watching - is invisible: two
 * unrelated traces, no edge between them, and no way to ask how long a handed-off request took
 * end to end.
 */
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

export function parseTraceparent(header) {
  const match = TRACEPARENT.exec(String(header ?? '').trim().toLowerCase());
  if (!match) return null;
  // All-zero ids are how the spec says "there is no trace here". A collector drops spans carrying
  // them, so continuing one would produce a trace that silently never arrives.
  if (/^0+$/.test(match[1]) || /^0+$/.test(match[2])) return null;
  return { traceId: match[1], spanId: match[2] };
}

/**
 * A moment, from an ISO 8601 string or a number of milliseconds, or null when neither works.
 *
 * Every event the SDK delivers carries `createdAt`, and until this file existed the runner parsed
 * none of them. A timestamp from the server is better than one taken here: it is when the harness
 * saw the thing happen, not when the packet reached this process behind whatever the event loop
 * was busy with.
 */
export function momentOf(at) {
  if (typeof at === 'number' && Number.isFinite(at)) return at;
  if (typeof at === 'string' && at.trim()) {
    const parsed = Date.parse(at);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Nanoseconds, through BigInt.
 *
 * `Date.now() * 1e6` is about 1.8e18, comfortably past the 9e15 where a double stops counting in
 * ones. Doing this arithmetic in a Number silently rounds every timestamp to the nearest few
 * hundred nanoseconds, which is fine until somebody uses these spans to order two events that
 * happened in the same millisecond. OTLP/JSON encodes 64-bit integers as decimal strings anyway.
 */
const nanos = (ms) => (BigInt(Math.round(ms)) * 1000000n).toString();

/** OTLP `AnyValue`. The type of the JavaScript value decides the encoding; nothing is guessed. */
function anyValue(value) {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    // A fractional number sent as `intValue` is a payload a strict collector rejects outright, and
    // it would take the whole document with it rather than the one attribute.
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(anyValue) } };
  return { stringValue: String(value) };
}

/**
 * An attribute with no value is not a fact about the run, so null and undefined are dropped rather
 * than encoded. An exit code of `null` means nothing reported one; writing it as an empty string
 * would let a dashboard count it as a value.
 */
function attributes(pairs) {
  return Object.entries(pairs)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => ({ key, value: anyValue(value) }));
}

/**
 * TrueForge model names are `provider/model` - TOOLS.md is explicit about it, dashes and all - and
 * the two halves land on different attributes. `gen_ai.provider.name` has a list of well-known
 * values, but the value here comes from whatever the operator configured rather than from a lookup
 * table this file would have to keep current. Reporting the configured provider verbatim is more
 * useful than reporting nothing because it was not on a list.
 */
function splitModel(fqn) {
  const text = String(fqn ?? '').trim();
  if (!text) return { provider: null, model: null };
  const slash = text.indexOf('/');
  if (slash === -1) return { provider: null, model: text };
  return { provider: text.slice(0, slash) || null, model: text.slice(slash + 1) || null };
}

/**
 * Token counts and cost out of a `turn.done`, and nothing else out of it.
 *
 * The runner has been discarding `state.metrics` since the day it was written, which is the whole
 * of what a turn cost - tokens in, tokens out, cache reads and writes, and the provider's own
 * estimate in dollars. It is exactly what a fleet operator opens a trace to find.
 *
 * Read key by key, and only numbers. The tracer is never handed a harness object to copy wholesale
 * because those objects grow fields, and one of the fields on this one is already `output`, which
 * is the model's entire answer. A picker that takes seven known numeric keys cannot be surprised
 * into exporting prose; a spread would be one release away from it.
 */
function usageFrom(metrics) {
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const source = metrics && typeof metrics === 'object' ? metrics : {};
  return {
    'gen_ai.usage.input_tokens': number(source.totalInputTokens),
    'gen_ai.usage.output_tokens': number(source.totalOutputTokens),
    'gen_ai.usage.cache_read.input_tokens': number(source.totalCacheReadTokens),
    'gen_ai.usage.cache_write.input_tokens': number(source.totalCacheWriteTokens),
    'quartermaster.usage.reasoning_tokens': number(source.totalReasoningTokens),
    'quartermaster.usage.total_tokens': number(source.totalTokens),
    // Namespaced, because the convention has no stable attribute for money and inventing
    // `gen_ai.usage.cost` would collide the day it does.
    'quartermaster.cost.usd': number(source.totalCostInUsd),
  };
}

/**
 * A class of failure, never the failure text.
 *
 * `adviseOnFailure` already classifies a provider message into a small closed vocabulary, so this
 * reuses it rather than writing a second set of regular expressions that would drift from the
 * first. What matters here is that the *message* stays out: it is the provider's prose, it can
 * quote back the prompt that caused it, and an operator grouping by cause wants the cause anyway.
 * `_OTHER` is OpenTelemetry's own fallback for an error the instrumentation cannot name.
 */
function errorType(failure) {
  return adviseOnFailure(failure)?.cause ?? '_OTHER';
}

/**
 * Why the run ended, in one of five words rather than a sentence.
 *
 * A free-text reason would be a high-cardinality attribute and would smuggle the provider's
 * message into a span through the back door. `endedBadly` is imported rather than re-decided, so
 * this and the process exit code cannot disagree about what a bad ending is.
 */
export function exitReason({ crashed = false, unfinished = false, blockedOnAuth = false, failure = null, status = null } = {}) {
  if (crashed) return 'crashed';
  if (unfinished) return 'out-of-rounds';
  if (blockedOnAuth) return 'blocked-on-auth';
  if (failure || endedBadly(status)) return 'turn-failed';
  return 'finished';
}

/** Default writer. Separated so a test can watch what would have been written without a file. */
function appendLine(file, line) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, line);
}

/**
 * One tracer per run.
 *
 * When tracing is off every method here is a no-op that returns undefined, so the runner never has
 * to ask whether it is on. There is no second code path to keep correct, which is the only version
 * of this that stays true after somebody adds a span in six months.
 */
export function createTracer(options = {}) {
  const {
    env = process.env,
    now = () => Date.now(),
    randomHex = (bytes) => randomBytes(bytes).toString('hex'),
    write = appendLine,
    path = null,
  } = options ?? {};

  /**
   * Deciding whether to trace has to be as unable to fail as the tracing itself.
   *
   * `guard` protects every method, but the construction happens before there is anything to guard:
   * reading the environment, parsing an inherited traceparent, asking for sixteen random bytes.
   * A throw here would come out of the runner's import-time wiring, before a single event had been
   * read, and take down a run over telemetry that nobody had even asked for yet. Anything that
   * goes wrong at this point means tracing is off, which is the same answer the default gives.
   */
  let on = false;
  let parent = null;
  let traceId = null;
  try {
    on = tracingEnabled(env);
    if (on) {
      parent = parseTraceparent(env?.TRACEPARENT);
      traceId = parent?.traceId ?? randomHex(16);
    }
  } catch {
    on = false;
  }
  const file = path ?? env?.QUARTERMASTER_OTEL_FILE ?? TRACES;

  let root = null;
  let written = false;
  /** Keyed by tool call id, which is the only identifier the event stream carries throughout. */
  const calls = new Map();
  const gate = { requested: 0, allowed: 0, refused: 0 };
  /**
   * Added up rather than replaced, because one run is several turns whenever the gate is hit. The
   * last turn's numbers alone would report a fraction of what the run cost, and would report it
   * confidently.
   */
  const usage = new Map();

  /**
   * The whole promise of this file, in six lines.
   *
   * A throw from anywhere below would otherwise land in the middle of the approval loop or the
   * event stream and end a run that was working. Nothing here is important enough to do that, so
   * every entry point returns rather than raises, and a tracer that has broken simply stops
   * producing spans. The run does not find out, because there is nothing it could usefully do
   * about it and printing a warning over the verdict would be its own small harm.
   */
  const guard = (fn) => (...args) => {
    if (!on) return undefined;
    try {
      return fn(...args);
    } catch {
      return undefined;
    }
  };

  const newSpan = ({ name, kind, parentSpanId = null, start }) => ({
    name,
    kind,
    spanId: randomHex(8),
    parentSpanId,
    start,
    end: null,
    attrs: {},
    events: [],
    status: UNSET,
  });

  /** The tool name is `Required` on an `execute_tool` span, so a call without one is still named. */
  const nameCall = (entry, tool) => {
    if (tool && !entry.tool) {
      entry.tool = tool;
      entry.span.attrs['gen_ai.tool.name'] = tool;
    }
    entry.span.name = entry.tool ? `execute_tool ${entry.tool}` : 'execute_tool';
  };

  const startTurn = guard(({ agent = null, session = null, model = null, prompt = null } = {}) => {
    // Called twice would silently discard the first turn's spans. First one wins.
    if (root) return;
    const { provider, model: name } = splitModel(model);
    root = newSpan({
      // `invoke_agent {gen_ai.agent.name}` when the name is available, `invoke_agent` when it is
      // not. Straight out of the convention, so a trace viewer groups these with everybody else's.
      name: agent ? `invoke_agent ${agent}` : 'invoke_agent',
      kind: CLIENT,
      parentSpanId: parent?.spanId ?? null,
      /**
       * The root is on the local clock at both ends, deliberately. It is a CLIENT span: what it
       * measures is what this process waited for, network and queueing included. Starting it from
       * a local reading and ending it on a server timestamp would make its duration a measure of
       * how far apart the two clocks are.
       */
      start: now(),
    });
    root.attrs = {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': agent,
      /**
       * The session is the conversation. `gen_ai.conversation.id` is the attribute a trace backend
       * already knows how to group by, which is the whole reason for using the convention rather
       * than inventing `quartermaster.session`.
       */
      'gen_ai.conversation.id': session,
      'gen_ai.provider.name': provider,
      /**
       * `gen_ai.request.model` is "the model configured for the agent", which is exactly what this
       * is: the FQN from the environment. The *resolved* model is not on anything the runner
       * receives - creating a session by name returns an agent reference with no model on it - so
       * `gen_ai.response.model` is deliberately absent rather than filled in with a guess.
       */
      'gen_ai.request.model': name,
      /**
       * The prompt is an operator's own words and can contain anything: a customer name, an
       * internal hostname, the contents of a ticket. The digest answers what a trace needs it for
       * ("is this the same request we saw at 03:00?") and carries none of it. The convention has a
       * `gen_ai.input.messages` attribute for the real text and marks it `Opt-In`; this declines.
       */
      'quartermaster.prompt.digest': prompt == null ? null : digest(prompt),
      /**
       * Said out loud on both kinds of span, because a run has two clocks in it and the reader is
       * entitled to know which one they are looking at. The root is local and the tool spans are
       * usually the server's, so a child can sit outside its parent's window when the two machines
       * disagree. That is a fact about the clocks and not about the run, and printing it beats
       * hiding it by rewriting one of the numbers.
       */
      'quartermaster.clock': 'local',
    };
  });

  /**
   * The model asked for a tool. This is where the tool span starts.
   *
   * `at` is the event's server `createdAt`, and using it rather than the local clock is the point.
   * Be clear about what the resulting duration means: it is the time between the harness issuing
   * the call and the harness producing its response. It is not what the sandbox spent executing,
   * because nothing on the wire reports that - and when the call is gated it includes however long
   * a person took to decide. That last part is why the decision is timed separately below: an
   * operator debugging a slow turn needs to know whether the tool was slow or whether everybody
   * was at lunch.
   */
  const sawCall = guard((callId, { tool = null, args = null, at = null } = {}) => {
    if (!root || !callId || calls.has(callId)) return;
    const server = momentOf(at);
    const entry = {
      span: newSpan({ name: 'execute_tool', kind: INTERNAL, parentSpanId: root.spanId, start: server ?? now() }),
      tool: null,
      gatedAt: null,
      serverClock: server !== null,
    };
    entry.span.attrs = {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.call.id': callId,
      // Every tool reachable from here is a named function on an MCP server or on the harness.
      'gen_ai.tool.type': 'function',
      /**
       * Which clock these timestamps came from, because it is the first question somebody asks
       * about a duration that looks wrong. A span built from server timestamps is consistent with
       * itself; one that fell back to the local clock is measuring arrival here instead.
       */
      'quartermaster.clock': server === null ? 'local' : 'server',
      /**
       * The arguments are the single most dangerous thing in this file. They are where an issue
       * body, a commit message or an email draft lives, and a span is a thing that gets shipped
       * off the machine to a backend somebody else operates. `digest` is the same function the
       * ledger uses, so the same call produces the same value in both records and an auditor can
       * join them - which is the useful half of what the text would have given us.
       */
      'quartermaster.tool.arguments.digest': args == null ? null : digest(args),
    };
    nameCall(entry, tool);
    calls.set(callId, entry);
  });

  /** The gate stopped this call. Recorded whether or not anybody ends up answering. */
  const gated = guard((callId, { tool = null } = {}) => {
    const entry = calls.get(callId);
    if (!entry) return;
    nameCall(entry, tool);
    if (entry.span.attrs['quartermaster.tool.gated'] === true) return;
    entry.span.attrs['quartermaster.tool.gated'] = true;
    /**
     * Local, and paired with a local reading in `decided`. This one measurement is not about the
     * harness at all - it is how long a person in front of this terminal took to answer - so both
     * ends of it have to be read from the clock the person is standing next to. The event's server
     * timestamp is the wrong number here even though it is the better number everywhere else.
     */
    entry.gatedAt = now();
    gate.requested += 1;
  });

  /**
   * A person, a pipe or a flag decided. Recorded as an event as well as an attribute: the
   * attribute is what a dashboard groups by, the event is what carries the moment it happened.
   *
   * A refusal does not set `error.type` and does not set the span status to ERROR. This matters
   * more than it looks. A refused call is the gate working - it is the single behaviour this
   * project exists to demonstrate - and a trace that files it under errors produces a dashboard
   * where doing the right thing lights up red. Give somebody an alert that fires when they refuse
   * a deployment rollback and they will stop refusing deployment rollbacks.
   */
  const decided = guard((callId, { tool = null, refused = false, by = null, reason = null } = {}) => {
    const entry = calls.get(callId);
    if (!entry) return;
    nameCall(entry, tool);
    const decision = refused ? 'denied' : 'allowed';
    const at = now();
    entry.span.attrs['quartermaster.tool.decision'] = decision;
    entry.span.attrs['quartermaster.tool.decided_by'] = by;
    if (entry.gatedAt !== null) {
      // The one number nothing else here records: how long the run sat waiting for a human.
      entry.span.attrs['quartermaster.approval.waited_ms'] = Math.max(0, Math.round(at - entry.gatedAt));
    }
    entry.span.events.push({
      at,
      name: 'quartermaster.approval.decision',
      /**
       * `reason` is the harness's own fixed vocabulary - "denied by --deny-all", "denied by the
       * operator", "The call could not be displayed for approval" - and never model or tool
       * output. If a reason ever starts being assembled from something a model wrote, it has to be
       * digested on the way in here like everything else.
       */
      attrs: { 'quartermaster.approval.decision': decision, 'quartermaster.approval.by': by, 'quartermaster.approval.reason': reason },
    });
    gate[refused ? 'refused' : 'allowed'] += 1;
  });

  /**
   * The response arrived, so the span closes.
   *
   * A non-zero exit code is an attribute and not an error. `npm test` exiting 1 is a test run, and
   * a red one is how this project catches a false pass-claim; marking it ERROR would file the most
   * valuable event in the system under the heading nobody reads on purpose. `errored` is the other
   * thing entirely - the call itself failed before anything ran - and that is a real error.
   */
  const finishedCall = guard((callId, { tool = null, exitCode = null, errored = false, denied = false, outputBytes = null, command = null, at = null } = {}) => {
    const entry = calls.get(callId);
    if (!entry || entry.span.end !== null) return;
    nameCall(entry, tool);
    const server = momentOf(at);
    // Mixing clocks inside one span is how a duration comes out negative, and a backend drops a
    // span it cannot order. If the start came from the server, the end has to as well.
    entry.span.end = entry.serverClock && server !== null ? server : now();
    // A refused call is delivered like any other, with no output and no exit code. Saying so on
    // the span keeps a denial from reading as a command that ran and printed nothing - the same
    // confusion `performed()` exists to prevent in the evidence.
    entry.span.attrs['quartermaster.tool.refused'] = denied === true;
    if (typeof exitCode === 'number') entry.span.attrs['quartermaster.tool.exit_code'] = exitCode;
    if (typeof outputBytes === 'number') {
      // The size of the output, never the output. A length is a measurement; the text is a payload
      // and could be a database row, a private repository's diff, or a customer's address.
      entry.span.attrs['quartermaster.tool.output.bytes'] = Math.max(0, Math.round(outputBytes));
    }
    // The command in digest form is the join key between a span and an execution in the session
    // report, which holds the command itself. It is how somebody gets from "this span was slow" to
    // "here is what it ran" without the trace backend ever holding the second half.
    if (command != null) entry.span.attrs['quartermaster.tool.command.digest'] = digest(command);
    if (errored === true) {
      entry.span.status = ERROR;
      entry.span.attrs['error.type'] = '_OTHER';
    }
  });

  /**
   * What a finished turn cost. The runner hands over `turn.done`'s `state.metrics` unchanged and
   * `usageFrom` takes seven numbers out of it, so a field the harness adds later cannot arrive on
   * a span by being spread into one.
   */
  const turnUsage = guard((metrics) => {
    for (const [key, value] of Object.entries(usageFrom(metrics))) {
      if (value === null) continue;
      usage.set(key, (usage.get(key) ?? 0) + value);
    }
  });

  /**
   * Close the root, close anything still open, and write the document.
   *
   * One line per run, written once at the end rather than streamed. A run that died mid-turn is
   * still written, because the runner's own crash guard reaches this - and a run that crashed is
   * exactly the run somebody wants the trace for.
   */
  const endTurn = guard(({
    verdict = null,
    status = null,
    failure = null,
    exit = null,
    executions = null,
    testRuns = null,
    answer = null,
    crashed = false,
    unfinished = false,
    blockedOnAuth = false,
  } = {}) => {
    if (!root || written) return null;
    const at = now();

    /**
     * A call with no response never got one, and leaving its span open would have the exporter
     * either drop it or invent an end time. Closing it here and saying why keeps the fact: a tool
     * call that was never answered is a finding, not a gap.
     */
    for (const entry of calls.values()) {
      if (entry.span.end !== null) continue;
      entry.span.end = at;
      entry.span.attrs['quartermaster.tool.unanswered'] = true;
    }

    root.end = at;
    Object.assign(root.attrs, Object.fromEntries(usage), {
      'quartermaster.verdict': verdict,
      'quartermaster.turn.status': status,
      'quartermaster.exit.reason': exitReason({ crashed, unfinished, blockedOnAuth, failure, status }),
      'quartermaster.exit.code': typeof exit === 'number' ? exit : null,
      'quartermaster.tool_calls': calls.size,
      'quartermaster.executions': typeof executions === 'number' ? executions : null,
      'quartermaster.test_runs': typeof testRuns === 'number' ? testRuns : null,
      'quartermaster.approvals.requested': gate.requested,
      'quartermaster.approvals.allowed': gate.allowed,
      'quartermaster.approvals.refused': gate.refused,
      // Same reasoning as the prompt: a digest tells you two runs answered identically, and the
      // answer itself is already in the session report, where a person reads it rather than a
      // backend storing it.
      'quartermaster.answer.digest': answer == null ? null : digest(answer),
    });
    if (failure || crashed) {
      root.status = ERROR;
      root.attrs['error.type'] = errorType(failure);
    }

    const spans = [root, ...[...calls.values()].map((entry) => entry.span)].map((span) => {
      // Clamped, because a span that ends before it starts is not a slow span, it is a dropped
      // one. Two clocks are involved in a run and they are not the same clock.
      const finish = Math.max(span.start, span.end ?? span.start);
      return {
        traceId,
        spanId: span.spanId,
        ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
        name: span.name,
        kind: span.kind,
        startTimeUnixNano: nanos(span.start),
        endTimeUnixNano: nanos(finish),
        attributes: attributes(span.attrs),
        /**
         * The events are timed here, on the local clock, and the span around them may be timed on
         * the harness's. The approval definitely happened while the call was outstanding, so an
         * event that lands outside its own span is clock skew rather than a fact, and a viewer
         * that hides such an event would hide the decision - which is the thing worth seeing.
         */
        events: span.events.map((event) => ({
          timeUnixNano: nanos(Math.min(finish, Math.max(span.start, event.at))),
          name: event.name,
          attributes: attributes(event.attrs),
        })),
        status: { code: span.status },
      };
    });

    const document = {
      resourceSpans: [
        {
          resource: {
            attributes: attributes({
              'service.name': env?.OTEL_SERVICE_NAME ?? 'quartermaster',
              // The language, and not `telemetry.sdk.name`. There is no OpenTelemetry SDK in this
              // process, and claiming one would be a small lie in the one file arguing for honest
              // instrumentation.
              'telemetry.sdk.language': 'nodejs',
            }),
          },
          scopeSpans: [{ scope: { name: SCOPE }, spans }],
        },
      ],
    };

    /**
     * A second guard inside the first, so the return value stays honest. `guard` swallowing a
     * throw would return undefined, which a caller cannot tell from "there was nothing to write".
     * This returns the path when it wrote and null when it did not, and either way the run carries
     * on to its own exit code.
     */
    try {
      write(file, `${JSON.stringify(document)}\n`);
      written = true;
      return file;
    } catch {
      return null;
    }
  });

  return {
    enabled: on,
    startTurn,
    sawCall,
    gated,
    decided,
    finishedCall,
    turnUsage,
    endTurn,
    /**
     * The header a delegated run inherits, so its spans join this trace instead of starting a new
     * one. Null when there is nothing to continue, which is what an unset environment variable
     * should look like to the child.
     */
    traceparent: () => (on && root ? `00-${traceId}-${root.spanId}-01` : null),
  };
}
