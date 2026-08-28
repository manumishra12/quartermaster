import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracer, exitReason, momentOf, parseTraceparent, tracingEnabled } from './otel.mjs';
import { digest } from './ledger.mjs';

/**
 * A tracer with a fixed clock, fixed ids and a writer that keeps the line instead of a file.
 *
 * The writer is the real one from the tracer's point of view - it is called with exactly what
 * would have gone to disk - so the payload tests below scan the bytes that would have left the
 * machine rather than an object assembled for the test's convenience.
 */
function harness({ env = { QUARTERMASTER_OTEL: '1' }, at = 1_000 } = {}) {
  const written = [];
  let clock = at;
  let counter = 0;
  const tracer = createTracer({
    env,
    now: () => clock,
    randomHex: (bytes) => String(++counter).padStart(bytes * 2, '0'),
    write: (file, line) => written.push({ file, line }),
    path: 'test-traces.jsonl',
  });
  return {
    tracer,
    written,
    tick: (ms) => {
      clock += ms;
    },
    /** The one document that would have been written, parsed. */
    document: () => JSON.parse(written.at(-1).line),
    spans: () => JSON.parse(written.at(-1).line).resourceSpans[0].scopeSpans[0].spans,
  };
}

const attr = (span, key) => span.attributes.find((a) => a.key === key)?.value;

test('nothing is traced unless somebody asked for it', () => {
  /**
   * The default has to be that no file appears and nothing leaves the machine. A harness that
   * starts exporting because it was installed is a harness nobody deploys, and this is the one
   * property that cannot be checked by reading the code six months from now.
   */
  const off = harness({ env: {} });
  off.tracer.startTurn({ agent: 'quartermaster-local', session: 's1' });
  off.tracer.sawCall('call-1', { tool: 'shell', args: '{"command":"npm test"}' });
  off.tracer.finishedCall('call-1', { exitCode: 0 });
  assert.equal(off.tracer.enabled, false);
  assert.equal(off.tracer.endTurn({ verdict: 'substantiated' }), undefined);
  assert.deepEqual(off.written, [], 'an off tracer wrote something');
  assert.equal(off.tracer.traceparent(), null);

  // And the ambient OTLP endpoint variable is somebody else's configuration, not consent. A
  // machine running any other instrumented service has one set.
  assert.equal(tracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }), false);
  assert.equal(tracingEnabled({ QUARTERMASTER_OTEL: '0' }), false);
  assert.equal(tracingEnabled({ QUARTERMASTER_OTEL: 'sure' }), false, 'anything unrecognised is off');
  assert.equal(tracingEnabled({ QUARTERMASTER_OTEL: '1' }), true);
  assert.equal(tracingEnabled({ QUARTERMASTER_OTEL: 'true' }), true);
  // The standard kill switch wins over our own, because an operator who reaches for it means it.
  assert.equal(tracingEnabled({ QUARTERMASTER_OTEL: '1', OTEL_SDK_DISABLED: 'true' }), false);
});

test('a turn is one root span with a child for every tool call', () => {
  const h = harness();
  h.tracer.startTurn({ agent: 'quartermaster-local', session: 'sess-7', model: 'anthropic/claude-sonnet-4-6', prompt: 'fix the failing test' });
  h.tracer.sawCall('call-1', { tool: 'shell', args: '{"command":"npm test"}', at: '2026-01-01T00:00:00.000Z' });
  h.tick(50);
  h.tracer.finishedCall('call-1', { tool: 'shell', exitCode: 1, outputBytes: 40, command: 'npm test', at: '2026-01-01T00:00:02.500Z' });
  h.tick(10);
  assert.equal(h.tracer.endTurn({ verdict: 'substantiated', status: 'done', exit: 0, executions: 1, testRuns: 1, answer: 'the test passes' }), 'test-traces.jsonl');

  const doc = h.document();
  // The OTLP envelope, which is the whole reason a collector can read this without an SDK.
  assert.ok(Array.isArray(doc.resourceSpans), 'not an ExportTraceServiceRequest');
  assert.equal(doc.resourceSpans[0].scopeSpans[0].scope.name, 'quartermaster/run');
  const resource = doc.resourceSpans[0].resource.attributes.find((a) => a.key === 'service.name');
  assert.equal(resource.value.stringValue, 'quartermaster');

  const [root, tool] = h.spans();
  assert.equal(root.name, 'invoke_agent quartermaster-local');
  assert.equal(root.kind, 3, 'the root is a CLIENT span: this process is a client of the harness');
  assert.equal(attr(root, 'gen_ai.operation.name').stringValue, 'invoke_agent');
  assert.equal(attr(root, 'gen_ai.agent.name').stringValue, 'quartermaster-local');
  assert.equal(attr(root, 'gen_ai.conversation.id').stringValue, 'sess-7');
  // The FQN is provider/model and the halves land on different attributes.
  assert.equal(attr(root, 'gen_ai.provider.name').stringValue, 'anthropic');
  assert.equal(attr(root, 'gen_ai.request.model').stringValue, 'claude-sonnet-4-6');
  assert.equal(attr(root, 'quartermaster.verdict').stringValue, 'substantiated');
  assert.equal(attr(root, 'quartermaster.exit.reason').stringValue, 'finished');
  assert.equal(attr(root, 'quartermaster.exit.code').intValue, '0');
  // The model never learns what it was: nothing here reports the resolved model, so nothing here
  // claims to.
  assert.equal(attr(root, 'gen_ai.response.model'), undefined);

  assert.equal(tool.name, 'execute_tool shell');
  assert.equal(tool.kind, 1, 'the tool spans are INTERNAL, the only kind the convention defines');
  assert.equal(tool.parentSpanId, root.spanId);
  assert.equal(tool.traceId, root.traceId);
  assert.equal(root.traceId.length, 32);
  assert.equal(root.spanId.length, 16);
  assert.equal(root.parentSpanId, undefined, 'a root with no parent must not carry an empty one');
  assert.equal(attr(tool, 'gen_ai.tool.name').stringValue, 'shell');
  assert.equal(attr(tool, 'gen_ai.tool.call.id').stringValue, 'call-1');
  assert.equal(attr(tool, 'quartermaster.tool.exit_code').intValue, '1');

  /**
   * The tool span is built from the harness's own timestamps rather than from a clock read here,
   * which is the point of reading `createdAt` at all: 2.5 seconds between the call being issued
   * and its response, against the 50ms this process happened to spend between the two lines.
   */
  assert.equal(attr(tool, 'quartermaster.clock').stringValue, 'server');
  const spent = (BigInt(tool.endTimeUnixNano) - BigInt(tool.startTimeUnixNano)) / 1_000_000n;
  assert.equal(spent, 2500n);
  // Nanoseconds as decimal strings, not numbers: a millisecond epoch times a million is past the
  // point where a double still counts in ones.
  assert.equal(typeof root.startTimeUnixNano, 'string');
});

test('no payload text reaches a span', () => {
  /**
   * The test this file exists for. A span is a thing that gets shipped off the machine to a
   * backend somebody else operates, and everything a run touches is somebody's private text: the
   * prompt, the tool arguments, the command, the output, the answer, and the provider's own
   * failure message.
   *
   * The assertion is deliberately made against the serialised line rather than against the
   * attributes this test remembered to name. An attribute added tomorrow that carries a payload
   * fails here without anybody editing the test, which is the only version of this check that
   * keeps working.
   */
  const secrets = {
    prompt: 'close the ticket for ada@example.com about the Ashfield outage',
    args: '{"body":"the customer\'s home address is 14 Pitt Street"}',
    command: 'gh issue close 41 --comment "refunded via card ending 4242"',
    output: 'DB_PASSWORD=hunter2\n3 rows returned',
    answer: 'I emailed ada@example.com and closed the ticket.',
    // The shape of a real one. The provider quotes back enough of the request to identify it,
    // which is exactly why the sentence cannot travel on a span.
    failure: 'Request failed (429): Quota exceeded, requests per minute, for consumer project_number:918273645 on "the Ashfield outage"',
  };

  const h = harness();
  h.tracer.startTurn({ agent: 'desk-assistant', session: 's1', model: 'openai/gpt-5-5', prompt: secrets.prompt });
  h.tracer.sawCall('call-1', { tool: 'close_issue', args: secrets.args });
  h.tracer.gated('call-1');
  h.tracer.decided('call-1', { refused: false, by: 'terminal', reason: null });
  h.tracer.finishedCall('call-1', { exitCode: 0, outputBytes: secrets.output.length, command: secrets.command });
  h.tracer.turnUsage({
    totalInputTokens: 1200,
    totalCostInUsd: 0.0134,
    // A field the harness could grow tomorrow. It must not reach a span by being copied wholesale.
    lastUserMessage: secrets.prompt,
  });
  h.tracer.endTurn({ verdict: 'substantiated', status: 'error', failure: secrets.failure, answer: secrets.answer, exit: 1 });

  const line = h.written.at(-1).line;
  for (const [name, text] of Object.entries(secrets)) {
    assert.ok(!line.includes(text), `the ${name} reached a span verbatim`);
  }
  // And the distinctive fragments of each, in case something ever records a prefix of one.
  for (const fragment of ['ada@example.com', 'Pitt Street', 'hunter2', '4242', 'Ashfield', 'project_number', 'lastUserMessage']) {
    assert.ok(!line.includes(fragment), `"${fragment}" reached a span`);
  }

  /**
   * What is carried instead: the same digest the ledger writes for the same text, so an auditor
   * can join a span to a ledger entry without either record holding the payload.
   */
  const [root, tool] = h.spans();
  assert.equal(attr(root, 'quartermaster.prompt.digest').stringValue, digest(secrets.prompt));
  assert.equal(attr(tool, 'quartermaster.tool.arguments.digest').stringValue, digest(secrets.args));
  assert.equal(attr(tool, 'quartermaster.tool.command.digest').stringValue, digest(secrets.command));
  assert.equal(attr(root, 'quartermaster.answer.digest').stringValue, digest(secrets.answer));
  // The output is not even digested. Its size is a measurement; its text is a payload.
  assert.equal(attr(tool, 'quartermaster.tool.output.bytes').intValue, String(secrets.output.length));
  assert.equal(attr(tool, 'quartermaster.tool.output.digest'), undefined);
  // The failure travels as a class, out of the classifier the runner already uses to advise a
  // person, and never as the provider's sentence.
  assert.equal(attr(root, 'error.type').stringValue, 'rate-limit');
  assert.equal(root.status.code, 2);
  // The numbers out of the metrics object did survive, so this is not passing by recording nothing.
  assert.equal(attr(root, 'gen_ai.usage.input_tokens').intValue, '1200');
  assert.equal(attr(root, 'quartermaster.cost.usd').doubleValue, 0.0134);
});

test('a refused approval is recorded as refused, and is not an error', () => {
  /**
   * Both halves matter. A refusal that is not recorded loses the one thing this project is built
   * to demonstrate; a refusal recorded as an error produces a dashboard where doing the right
   * thing lights up red, and an alert that fires when somebody refuses a rollback is an alert that
   * teaches them to stop refusing rollbacks.
   */
  const h = harness();
  h.tracer.startTurn({ agent: 'incident-responder', session: 's1' });
  h.tracer.sawCall('call-1', { tool: 'rollback_deploy', args: '{"deploy_id":"4c21"}' });
  h.tracer.gated('call-1', { tool: 'rollback_deploy' });
  h.tick(9000); // somebody thought about it for nine seconds
  h.tracer.decided('call-1', { refused: true, by: 'terminal', reason: 'denied by the operator' });
  h.tracer.finishedCall('call-1', { denied: true });
  h.tracer.endTurn({ verdict: 'no-claim', status: 'done', exit: 0 });

  const [root, tool] = h.spans();
  assert.equal(attr(tool, 'quartermaster.tool.gated').boolValue, true);
  assert.equal(attr(tool, 'quartermaster.tool.decision').stringValue, 'denied');
  assert.equal(attr(tool, 'quartermaster.tool.decided_by').stringValue, 'terminal');
  assert.equal(attr(tool, 'quartermaster.tool.refused').boolValue, true);
  assert.equal(tool.status.code, 0, 'a refusal is the gate working, not an error');
  assert.equal(attr(tool, 'error.type'), undefined);

  // The wait is the one number nothing else here records: how long the run sat waiting for a human.
  assert.equal(attr(tool, 'quartermaster.approval.waited_ms').intValue, '9000');

  const [decision] = tool.events;
  assert.equal(decision.name, 'quartermaster.approval.decision');
  assert.equal(decision.attributes.find((a) => a.key === 'quartermaster.approval.decision').value.stringValue, 'denied');
  assert.equal(decision.attributes.find((a) => a.key === 'quartermaster.approval.by').value.stringValue, 'terminal');

  assert.equal(attr(root, 'quartermaster.approvals.requested').intValue, '1');
  assert.equal(attr(root, 'quartermaster.approvals.refused').intValue, '1');
  assert.equal(attr(root, 'quartermaster.approvals.allowed').intValue, '0');
});

test('a red test run is an attribute, not an error', () => {
  /**
   * `npm test` exiting 1 is a test run, and a red one is how this project catches a false
   * pass-claim. Filing it under errors would put the most valuable event in the system beside the
   * broken sandboxes. `errored` is the different thing: the call failed before anything ran.
   */
  const h = harness();
  h.tracer.startTurn({ agent: 'quartermaster-local', session: 's1' });
  h.tracer.sawCall('red', { tool: 'shell' });
  h.tracer.finishedCall('red', { exitCode: 1 });
  h.tracer.sawCall('broken', { tool: 'shell' });
  h.tracer.finishedCall('broken', { errored: true });
  h.tracer.endTurn({ verdict: 'contradicted' });

  const [, red, broken] = h.spans();
  assert.equal(red.status.code, 0);
  assert.equal(attr(red, 'quartermaster.tool.exit_code').intValue, '1');
  assert.equal(attr(red, 'error.type'), undefined);
  assert.equal(broken.status.code, 2);
  assert.equal(attr(broken, 'error.type').stringValue, '_OTHER');
});

test('an exporter that throws does not take the run with it', () => {
  /**
   * A tracing exporter that ends a run is worse than no tracing. The decisions have already been
   * made and the executions have already happened by the time any of this is called; failing here
   * would lose the record and the run, and the run matters more.
   */
  const written = [];
  const tracer = createTracer({
    env: { QUARTERMASTER_OTEL: '1' },
    write: () => {
      throw new Error('the disk is full');
    },
  });
  tracer.startTurn({ agent: 'a', session: 's1' });
  tracer.sawCall('call-1', { tool: 'shell' });
  tracer.finishedCall('call-1', { exitCode: 0 });
  assert.equal(tracer.endTurn({ verdict: 'substantiated' }), null, 'a failed write must say so, not throw');
  assert.deepEqual(written, []);

  // And a throw from inside the tracer itself, rather than from the writer. `digest` is called on
  // whatever the runner hands over, and an object with a hostile toString is the cheapest way in.
  const hostile = createTracer({
    env: { QUARTERMASTER_OTEL: '1' },
    write: (_file, line) => written.push(line),
  });
  const explodes = {
    toString() {
      throw new Error('no');
    },
  };
  hostile.startTurn({ agent: 'a', session: 's1', prompt: explodes });
  hostile.sawCall('call-1', { tool: 'shell', args: explodes });
  hostile.finishedCall('call-1', { command: explodes });
  // Nothing above raised, which is the assertion. Whether a span survived is not the point.
  assert.doesNotThrow(() => hostile.endTurn({ verdict: 'substantiated' }));

  /**
   * And building the tracer at all. This runs at the runner's import-time wiring, before a single
   * event has been read, and there is no `guard` around it yet - so a hostile environment or a
   * broken source of randomness would take the run down over telemetry nobody had asked for.
   */
  assert.doesNotThrow(() => {
    const broken = createTracer({
      env: { QUARTERMASTER_OTEL: '1' },
      randomHex: () => {
        throw new Error('no entropy');
      },
    });
    assert.equal(broken.enabled, false, 'a tracer that could not be built traces nothing');
    broken.startTurn({ agent: 'a', session: 's1' });
    assert.equal(broken.endTurn({}), undefined);
  });
  assert.doesNotThrow(() => createTracer({ env: null }));
});

test('a handoff continues the trace instead of starting a second one', () => {
  /**
   * A handoff re-enters the runner as a child process. Without the traceparent the delegated run
   * gets its own trace id, and the one thing worth watching here - work moving between agents
   * under an authority check - is two unrelated traces with no edge between them.
   */
  const parent = harness();
  parent.tracer.startTurn({ agent: 'triage', session: 's1' });
  const header = parent.tracer.traceparent();
  assert.match(header, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  parent.tracer.endTurn({ verdict: 'no-claim' });

  const child = harness({ env: { QUARTERMASTER_OTEL: '1', TRACEPARENT: header } });
  child.tracer.startTurn({ agent: 'incident-responder', session: 's2' });
  child.tracer.endTurn({ verdict: 'substantiated' });

  const [parentRoot] = parent.spans();
  const [childRoot] = child.spans();
  assert.equal(childRoot.traceId, parentRoot.traceId, 'the delegated run joined the trace');
  assert.equal(childRoot.parentSpanId, parentRoot.spanId, 'and hangs off the run that delegated');

  // A malformed or all-zero header is no header. Continuing an all-zero trace produces spans a
  // collector drops, which is worse than starting a fresh one.
  assert.equal(parseTraceparent('nonsense'), null);
  assert.equal(parseTraceparent(`00-${'0'.repeat(32)}-${'1'.repeat(16)}-01`), null);
  assert.equal(parseTraceparent(null), null);
  assert.deepEqual(parseTraceparent(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`), { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) });
});

test('a call that was never answered is closed and said to be unanswered', () => {
  /**
   * A tool call with no response leaves a span open, and an open span is either dropped by the
   * exporter or given an invented end time. Neither is right: a call that was never answered is a
   * finding, and the smoke runner has a whole table row about telling that case apart.
   */
  const h = harness();
  h.tracer.startTurn({ agent: 'quartermaster-local', session: 's1' });
  h.tracer.sawCall('never', { tool: 'shell' });
  h.tick(100);
  h.tracer.endTurn({ verdict: 'unsubstantiated', status: 'cancelled' });

  const [root, orphan] = h.spans();
  assert.equal(attr(orphan, 'quartermaster.tool.unanswered').boolValue, true);
  assert.equal(orphan.endTimeUnixNano, root.endTimeUnixNano);
  assert.equal(attr(root, 'quartermaster.tool_calls').intValue, '1');
  // A cancelled turn did not finish, whatever it managed along the way.
  assert.equal(attr(root, 'quartermaster.exit.reason').stringValue, 'turn-failed');
});

test('why a run ended is one of five words, never the provider sentence', () => {
  /**
   * A free-text reason would be a high-cardinality attribute and would smuggle the provider's
   * message onto a span through the back door. It is also how the exit code and the trace start
   * disagreeing, which is why `endedBadly` is shared with `runExitCode` rather than copied.
   */
  assert.equal(exitReason({}), 'finished');
  assert.equal(exitReason({ status: 'done' }), 'finished');
  assert.equal(exitReason({ crashed: true, failure: 'anything' }), 'crashed');
  assert.equal(exitReason({ unfinished: true }), 'out-of-rounds');
  assert.equal(exitReason({ blockedOnAuth: true }), 'blocked-on-auth');
  assert.equal(exitReason({ failure: 'Quota exceeded' }), 'turn-failed');
  // A status the harness calls bad is a failed turn even when it left no message behind.
  assert.equal(exitReason({ status: 'cancelled' }), 'turn-failed');
  assert.equal(exitReason({ status: 'error' }), 'turn-failed');
});

test('two clocks cannot produce a span that ends before it starts', () => {
  /**
   * A run reads two clocks: this machine's, and the harness's `createdAt`. They will not agree,
   * and a span whose end precedes its start is not a fast span - it is one a backend drops, taking
   * the record of the call with it. Every span says which clock it was built from, so the reader
   * is not left guessing at a child that sits outside its parent.
   *
   * The case here is a harness whose clock is a full minute behind: the response it timestamps
   * looks, to this machine, as though it arrived before the call went out.
   */
  const h = harness();
  h.tracer.startTurn({ agent: 'quartermaster-local', session: 's1' });
  h.tracer.sawCall('skewed', { tool: 'shell', at: '2026-01-01T00:01:00.000Z' });
  h.tracer.gated('skewed');
  h.tracer.decided('skewed', { refused: true, by: 'terminal' });
  h.tracer.finishedCall('skewed', { at: '2026-01-01T00:00:00.000Z' });
  h.tracer.endTurn({ verdict: 'no-claim' });

  const [root, tool] = h.spans();
  assert.equal(attr(root, 'quartermaster.clock').stringValue, 'local');
  assert.equal(attr(tool, 'quartermaster.clock').stringValue, 'server');
  assert.ok(BigInt(tool.endTimeUnixNano) >= BigInt(tool.startTimeUnixNano), 'a span ended before it began');

  // And the decision stays inside its own span, or a viewer hides the one event worth seeing.
  const [decision] = tool.events;
  assert.ok(BigInt(decision.timeUnixNano) >= BigInt(tool.startTimeUnixNano));
  assert.ok(BigInt(decision.timeUnixNano) <= BigInt(tool.endTimeUnixNano));

  // A call the harness gave no usable timestamp for falls back to this machine's clock and says so.
  const local = harness();
  local.tracer.startTurn({ agent: 'a', session: 's1' });
  local.tracer.sawCall('untimed', { tool: 'shell', at: 'not a date' });
  local.tick(40);
  local.tracer.finishedCall('untimed', { at: '2026-01-01T00:00:00.000Z' });
  local.tracer.endTurn({ verdict: 'no-claim' });
  const [, untimed] = local.spans();
  assert.equal(attr(untimed, 'quartermaster.clock').stringValue, 'local');
  assert.equal((BigInt(untimed.endTimeUnixNano) - BigInt(untimed.startTimeUnixNano)) / 1_000_000n, 40n, 'one clock, both ends');

  // What decides all of that: a usable moment, or nothing. An unparseable date must not become
  // `NaN` and reach the BigInt that turns milliseconds into nanoseconds.
  assert.equal(momentOf('2026-01-01T00:00:00.000Z'), Date.parse('2026-01-01T00:00:00.000Z'));
  assert.equal(momentOf(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(momentOf('not a date'), null);
  assert.equal(momentOf(''), null);
  assert.equal(momentOf(undefined), null);
  assert.equal(momentOf(Number.NaN), null);
});

test('what a run cost is added up across its turns, not replaced by the last one', () => {
  /**
   * One run is several turns whenever the gate is hit. Keeping only the last turn's metrics would
   * report a fraction of what the run cost, and report it with the same confidence as the truth.
   */
  const h = harness();
  h.tracer.startTurn({ agent: 'quartermaster-local', session: 's1' });
  h.tracer.turnUsage({ totalInputTokens: 100, totalOutputTokens: 10, totalCostInUsd: 0.01 });
  h.tracer.turnUsage({ totalInputTokens: 250, totalOutputTokens: 30, totalCostInUsd: 0.02 });
  // A turn that reported no metrics at all must not zero the ones already counted.
  h.tracer.turnUsage(undefined);
  h.tracer.endTurn({ verdict: 'substantiated' });

  const [root] = h.spans();
  assert.equal(attr(root, 'gen_ai.usage.input_tokens').intValue, '350');
  assert.equal(attr(root, 'gen_ai.usage.output_tokens').intValue, '40');
  assert.equal(Math.round(attr(root, 'quartermaster.cost.usd').doubleValue * 100) / 100, 0.03);
  // A count nothing reported stays absent. Zero would be a claim that the run used no cache.
  assert.equal(attr(root, 'gen_ai.usage.cache_read.input_tokens'), undefined);
});
