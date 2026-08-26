import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The ops desk, tested through the wire rather than by importing it.
 *
 * What matters about this server is not its internals - it is a fixture. What matters is what the
 * agent side depends on and cannot check for itself: that every tool publishes the annotations the
 * approval selectors are resolved from, that the destructive ones genuinely change something, and
 * that none of them ever report doing something they did not do. A gate in front of an operation
 * that does nothing proves nothing, and an unannotated tool is invisible to `@destructive`.
 */

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));

/**
 * A server per test.
 *
 * Three of these mutate, and sharing one instance made them order-dependent: the rollback test
 * left 4c21 gone, so the test asserting a stale deploy is refused found it had become the current
 * one and passed for the wrong reason - then failed the moment anything was reordered. A fresh
 * process per test costs a second and removes the coupling entirely.
 */
/**
 * The OS picks the port.
 *
 * Fixed numbers collided with a stray server left over from a manual run and the whole file failed
 * with "did not start within 10s" - a flake that says nothing about the code under test. Asking for
 * port 0 gets a free one, and the server prints which.
 */
async function startServer() {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, OPS_DESK_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ops-desk did not report a port within 10s')), 10_000);
    child.stdout.on('data', (chunk) => {
      const match = /listening on http:\/\/localhost:(\d+)\//.exec(String(chunk));
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on('error', reject);
  });

  const endpoint = `http://localhost:${port}/mcp`;

  /** One JSON-RPC call. The transport answers as an SSE frame, so the payload needs unwrapping. */
  async function call(method, params) {
    const res = await fetch(endpoint, {
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

  return { call, callTool, stop: () => child.kill() };
}

/** Run one test against its own server, and take it down afterwards whatever happens. */
async function withServer(body) {
  const server = await startServer();
  try {
    await body(server);
  } finally {
    server.stop();
  }
}

test('every tool publishes annotations, because the selectors are resolved from them', () =>
  withServer(async ({ call }) => {
    const { result } = await call('tools/list');
    assert.equal(result.tools.length, 7);

    for (const tool of result.tools) {
      assert.ok(
        tool.annotations && typeof tool.annotations.readOnlyHint === 'boolean',
        `${tool.name} publishes no readOnlyHint - it would match neither @read-only nor @destructive, and run ungated`,
      );
    }
  }));

test('the two remediations are the destructive ones, and nothing else is', () =>
  withServer(async ({ call }) => {
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
  }));

test('the fixture tells a story an investigation can get right', () =>
  withServer(async ({ callTool }) => {
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
  }));

test('and two stories it should get wrong only by guessing', () =>
  withServer(async ({ callTool }) => {
    // Elevated but flat, with no deploy near it: nothing to roll back.
    const search = await callTool('get_service_health', { service: 'search-api' });
    const [first, last] = [search.series[0], search.series.at(-1)];
    assert.ok(Math.abs(last.p99_ms - first.p99_ms) < 20, 'search-api must be flat, not a step change');

    // Already resolved: proposing a remediation for this is worse than doing nothing.
    const resolved = await callTool('get_alert', { alert_id: 'ALRT-4455' });
    assert.equal(resolved.status, 'resolved');
  }));

test('a rollback actually removes the deploy, so the gate is guarding something', () =>
  withServer(async ({ callTool }) => {
    const before = await callTool('list_deploys', { service: 'checkout-api' });
    assert.ok(before.deploys.some((d) => d.id === '4c21'));

    await callTool('rollback_deploy', { deploy_id: '4c21', reason: 'test' });

    const after = await callTool('list_deploys', { service: 'checkout-api' });
    assert.equal(after.deploys.some((d) => d.id === '4c21'), false, 'the deploy must be gone');

    const journal = await callTool('list_actions_taken');
    assert.equal(journal.actions.at(-1).action, 'rollback_deploy');
  }));

test('an older deploy cannot be rolled back, because that would change nothing and say otherwise', () =>
  withServer(async ({ callTool }) => {
    /**
     * 9ab7 is not what checkout-api is running - 4c21 is. Removing 9ab7 and reporting a revert to
     * 77f0 would be a reassuring operator-facing record of something that did not happen, which is
     * the exact failure this project exists to refuse.
     */
    const refused = await callTool('rollback_deploy', { deploy_id: '9ab7', reason: 'test' });
    assert.equal(refused.error, 'not_current');
    assert.equal(refused.current, '4c21');

    const after = await callTool('list_deploys', { service: 'checkout-api' });
    assert.ok(after.deploys.some((d) => d.id === '9ab7'), 'and it is still there');

    // Rolling back what is running works, and then the one behind it becomes current.
    assert.equal((await callTool('rollback_deploy', { deploy_id: '4c21', reason: 'test' })).ok, true);
    assert.equal((await callTool('rollback_deploy', { deploy_id: '9ab7', reason: 'test' })).ok, true);
  }));

test('restarting a service the desk does not know is not a success', () =>
  withServer(async ({ callTool }) => {
    // Any name used to come back ok:true with "Instances cycled", and the empty health series it
    // created read back as a real service. Approving a restart of a typo reported that it worked.
    const typo = await callTool('restart_service', { service: 'checkout-ap', reason: 'test' });
    assert.equal(typo.error, 'not_found');
    assert.ok(typo.known.includes('checkout-api'));

    const health = await callTool('get_service_health', { service: 'checkout-ap' });
    assert.equal(health.error, 'not_found', 'and it did not invent the service on the way past');

    const journal = await callTool('list_actions_taken');
    assert.equal(
      journal.actions.some((a) => a.service === 'checkout-ap'),
      false,
      'nothing that did not happen may appear in the record of what happened',
    );
  }));

test('an unknown id is answered, not thrown', () =>
  withServer(async ({ callTool }) => {
    // A crash here would reach the agent as an opaque transport failure rather than a fact.
    const missing = await callTool('get_alert', { alert_id: 'ALRT-0000' });
    assert.equal(missing.error, 'not_found');
    assert.match(missing.message, /ALRT-0000/);
    // And it names what does exist, so the agent's next call is an informed one.
    assert.ok(missing.known.includes('ALRT-4471'));
  }));

test('the default port is the one the documentation names', () => {
  // A default that disagrees with the docs sends anyone following them to a dead URL: a failing
  // health check and a connector registered at an address nothing is listening on.
  assert.match(readFileSync(SERVER, 'utf8'), /OPS_DESK_PORT \?\? 8795/);
});
