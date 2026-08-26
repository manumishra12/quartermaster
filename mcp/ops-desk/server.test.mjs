import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The ops desk, tested through the wire rather than by importing it.
 *
 * What matters about this server is not its internals - it is a fixture. What matters is the two
 * things the agent side depends on and cannot check for itself: that every tool publishes the
 * annotations the approval selectors are resolved from, and that the destructive ones genuinely
 * change something. A gate in front of an operation that does nothing proves nothing, and an
 * unannotated tool is invisible to `@destructive` and would run ungated.
 */

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));
const PORT = 8899;
const ENDPOINT = `http://localhost:${PORT}/mcp`;

let child;

before(async () => {
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, OPS_DESK_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Wait for the port rather than sleeping a guessed interval, which is how these become flaky.
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`http://localhost:${PORT}/health`);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error('ops-desk did not start within 10s');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

after(() => child?.kill());

/** One JSON-RPC call. The transport answers as an SSE frame, so the payload needs unwrapping. */
async function call(method, params) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const body = await res.text();
  const line = body.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : body);
}

/** Tool results arrive as text content; every one of these returns JSON inside it. */
async function callTool(name, args = {}) {
  const response = await call('tools/call', { name, arguments: args });
  return JSON.parse(response.result.content[0].text);
}

test('every tool publishes annotations, because the selectors are resolved from them', async () => {
  const { result } = await call('tools/list');
  assert.equal(result.tools.length, 7);

  for (const tool of result.tools) {
    assert.ok(
      tool.annotations && typeof tool.annotations.readOnlyHint === 'boolean',
      `${tool.name} publishes no readOnlyHint - it would match neither @read-only nor @destructive, and run ungated`,
    );
  }
});

test('the two remediations are the destructive ones, and nothing else is', async () => {
  const { result } = await call('tools/list');
  const destructive = result.tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort();
  assert.deepEqual(destructive, ['restart_service', 'rollback_deploy']);

  const readOnly = result.tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort();
  assert.deepEqual(readOnly, [
    'get_alert',
    'get_service_health',
    'list_actions_taken',
    'list_alerts',
    'list_deploys',
  ]);
});

test('the fixture tells a story an investigation can get right', async () => {
  const alert = await callTool('get_alert', { alert_id: 'ALRT-4471' });
  assert.equal(alert.service, 'checkout-api');

  const health = await callTool('get_service_health', { service: 'checkout-api' });
  const before = health.series.find((p) => p.at === '2026-08-26T13:50:00Z');
  const after = health.series.find((p) => p.at === '2026-08-26T14:10:00Z');
  // The step change is the point: an investigation that finds nothing here has misread it.
  assert.ok(after.error_rate > before.error_rate * 10);

  const deploys = await callTool('list_deploys', { service: 'checkout-api' });
  // And a deploy sits between the two readings, four minutes before the alert.
  assert.ok(deploys.deploys.some((d) => d.id === '4c21' && d.shipped_at < alert.first_seen));
});

test('and two stories it should get wrong only by guessing', async () => {
  // Elevated but flat, with no deploy near it: nothing to roll back.
  const search = await callTool('get_service_health', { service: 'search-api' });
  const [first, last] = [search.series[0], search.series.at(-1)];
  assert.ok(Math.abs(last.p99_ms - first.p99_ms) < 20, 'search-api must be flat, not a step change');

  // Already resolved: proposing a remediation for this is worse than doing nothing.
  const resolved = await callTool('get_alert', { alert_id: 'ALRT-4455' });
  assert.equal(resolved.status, 'resolved');
});

test('a rollback actually removes the deploy, so the gate is guarding something', async () => {
  const before = await callTool('list_deploys', { service: 'checkout-api' });
  assert.ok(before.deploys.some((d) => d.id === '4c21'));

  await callTool('rollback_deploy', { deploy_id: '4c21', reason: 'test' });

  const after = await callTool('list_deploys', { service: 'checkout-api' });
  assert.equal(after.deploys.some((d) => d.id === '4c21'), false, 'the deploy must be gone');

  const journal = await callTool('list_actions_taken');
  assert.equal(journal.actions.at(-1).action, 'rollback_deploy');
});

test('an unknown id is answered, not thrown', async () => {
  // A crash here would reach the agent as an opaque transport failure rather than a fact.
  const missing = await callTool('get_alert', { alert_id: 'ALRT-0000' });
  assert.equal(missing.error, 'not_found');
  assert.match(missing.message, /ALRT-0000/);
  // And it names what does exist, so the agent's next call is an informed one.
  assert.ok(missing.known.includes('ALRT-4471'));
});
