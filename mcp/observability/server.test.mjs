import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The metrics store, tested through the wire rather than by importing it.
 *
 * Nothing here writes, so the ops-desk question - does the destructive tool genuinely mutate -
 * has no counterpart. What replaces it is the question a read-only server can get wrong, and it is
 * the harder one: **would this reply let a wrong answer through and look complete while it did?**
 *
 * Most of this file is that. A window wider than the retention served as the points that happened
 * to exist; a percentile averaged over a coarse bucket; a comparison against a window that has
 * nothing in it. Each of those produces a number an investigation can act on, arrived at honestly,
 * and wrong - which is the single failure this project is about.
 *
 * The other half is the fixture itself. It plants a trap, and a trap nothing pins can be softened
 * by a later edit until the investigation cannot be got wrong any more - at which point it proves
 * nothing. The cross-server test is the strictest of these: it reads ops-desk's own fixture and
 * asserts the two servers report the same numbers at every instant both of them publish.
 */

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));
const OPS_DESK = fileURLToPath(new URL('../ops-desk/server.mjs', import.meta.url));
const INCIDENTS = JSON.parse(
  readFileSync(fileURLToPath(new URL('../ops-desk/incidents.json', import.meta.url)), 'utf8'),
);
const METRICS = JSON.parse(readFileSync(fileURLToPath(new URL('./metrics.json', import.meta.url)), 'utf8'));

/**
 * Where a test points this server when it wants no desk at all.
 *
 * Not "leave it unset". The default is ops-desk's documented port, so a copy left running from a
 * manual demo - with a rollback already taken on it - would reach into every test in this file and
 * change what the store publishes. Port 1 needs root to bind, so nothing is ever listening on it
 * and the refusal is immediate.
 */
const NO_DESK = 'http://127.0.0.1:1';

/**
 * A server per test, on a port the OS picks.
 *
 * Fixed numbers collide with a stray server left over from a manual run, and the whole file then
 * fails with "did not report a port" - a flake that says nothing about the code under test. There
 * is no state to isolate here, unlike ops-desk, but the isolation is free and the port is not.
 */
async function startServer(opsDeskUrl = NO_DESK) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      OBSERVABILITY_PORT: '0',
      OBSERVABILITY_HOST: '127.0.0.1',
      OPS_DESK_URL: opsDeskUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const port = await new Promise((resolve, reject) => {
    // Accumulate rather than matching per chunk: stdout arrives in whatever pieces the OS feels
    // like, and an announcement split across two of them times out against a healthy server.
    let seen = '';
    const done = (error, value) => {
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(() => done(new Error('observability did not report a port within 10s')), 10_000);
    child.stdout.on('data', (chunk) => {
      seen += String(chunk);
      const match = /listening on http:\/\/localhost:(\d+)\//.exec(seen);
      if (match) done(null, Number(match[1]));
    });
    child.on('error', (error) => done(error));
    child.on('exit', (code) => done(new Error(`observability exited with code ${code} before reporting a port`)));
  });

  /**
   * Connect to the address the server actually bound, not to a name that may resolve elsewhere.
   *
   * The banner prints "localhost" because that is what every README and the connector registration
   * use; resolving it asks the resolver, and on a host where localhost is ::1 first - most Linux CI
   * - that is a different address with nothing listening on it. The Host header stays "localhost",
   * so the server's own DNS-rebinding check is exercised on the same path a browser would take.
   */
  const endpoint = `http://127.0.0.1:${port}/mcp`;

  async function call(method, params) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: `localhost:${port}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    const body = await res.text();
    const line = body.split('\n').find((l) => l.startsWith('data: '));
    return JSON.parse(line ? line.slice(6) : body);
  }

  async function callTool(name, args = {}) {
    const response = await call('tools/call', { name, arguments: args });
    return JSON.parse(response.result.content[0].text);
  }

  return { call, callTool, port, health: () => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()), stop: () => child.kill() };
}

async function withServer(body) {
  const server = await startServer();
  try {
    await body(server);
  } finally {
    server.stop();
  }
}

/**
 * A real ops-desk, so a rollback in one test is a rollback the other server has to answer for.
 *
 * Stubbing the desk here would test this file against its own idea of what a rollback looks like,
 * which is precisely the thing the cross-server assertions exist to stop. The desk mutates in
 * memory, so it is a fresh process per test for the same reason ops-desk's own suite uses one.
 */
async function startOpsDesk() {
  const child = spawn(process.execPath, [OPS_DESK], {
    env: { ...process.env, OPS_DESK_PORT: '0', OPS_DESK_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const port = await new Promise((resolve, reject) => {
    let seen = '';
    const done = (error, value) => {
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(() => done(new Error('ops-desk did not report a port within 10s')), 10_000);
    child.stdout.on('data', (chunk) => {
      seen += String(chunk);
      const match = /listening on http:\/\/localhost:(\d+)\//.exec(seen);
      if (match) done(null, Number(match[1]));
    });
    child.on('error', (error) => done(error));
    child.on('exit', (code) => done(new Error(`ops-desk exited with code ${code} before reporting a port`)));
  });

  const endpoint = `http://127.0.0.1:${port}/mcp`;
  async function callTool(name, args = {}) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: `localhost:${port}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await res.text();
    const line = body.split('\n').find((l) => l.startsWith('data: '));
    return JSON.parse(JSON.parse(line ? line.slice(6) : body).result.content[0].text);
  }

  return { callTool, url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

/** Both servers, wired together the way the README says to wire them. */
async function withPair(body) {
  const desk = await startOpsDesk();
  let store;
  try {
    store = await startServer(desk.url);
    await body({ desk, ...store });
  } finally {
    store?.stop();
    desk.stop();
  }
}

/**
 * A desk that answers /health with whatever a test wants it to.
 *
 * Only for the payloads a real ops-desk cannot produce. Everything a real one can produce is tested
 * against a real one, because a stub that agrees with this file's assumptions proves nothing about
 * the server it is standing in for.
 */
async function withStubDesk(payload, body) {
  const http = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${http.address().port}`;
  let store;
  try {
    store = await startServer(url);
    await body(store);
  } finally {
    store?.stop();
    http.close();
  }
}

/** One series as a lookup from instant to value, which is how most of these assertions read best. */
async function seriesOf(callTool, metric, service, from, to) {
  const answer = await callTool('query_range', { metric, service, from, to });
  assert.equal(answer.error, undefined, `query_range(${metric}, ${service}) failed: ${answer.message}`);
  return new Map(answer.points.map((p) => [p.at, p.value]));
}

const RETAINED = { from: '2026-08-26T12:00:00Z', to: '2026-08-26T14:20:00Z' };

/* ---------------------------------------------------------------------------------------------- */
/* The annotations, which are what the approval selectors resolve from.                             */
/* ---------------------------------------------------------------------------------------------- */

test('every tool publishes annotations, because the selectors are resolved from them', () =>
  withServer(async ({ call }) => {
    const { result } = await call('tools/list');
    assert.equal(result.tools.length, 8);

    for (const tool of result.tools) {
      assert.ok(
        tool.annotations && typeof tool.annotations.readOnlyHint === 'boolean',
        `${tool.name} publishes no readOnlyHint - it would match neither @read-only nor @destructive, and run ungated`,
      );
    }
  }));

test('every tool on this server is a read, and says so in both directions', () =>
  withServer(async ({ call }) => {
    /**
     * `readOnlyHint: true` alone is not the claim. A tool that publishes readOnlyHint and omits
     * destructiveHint matches `@read-only` and would also fall through `@destructive`, which is
     * fine here and would not be on a server that grows a write. Both hints, on all eight, so the
     * day somebody adds a ninth the odd one out is visible.
     */
    const { result } = await call('tools/list');
    const names = result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'compare_windows',
      'get_dashboard',
      'get_service_map',
      'list_alert_rules',
      'list_annotations',
      'list_dashboards',
      'list_metrics',
      'query_range',
    ]);

    for (const tool of result.tools) {
      assert.equal(tool.annotations.readOnlyHint, true, tool.name);
      assert.equal(tool.annotations.destructiveHint, false, tool.name);
    }
  }));

test('reading twice returns the same thing, which is what idempotentHint has to mean', () =>
  withServer(async ({ callTool }) => {
    // Published on all eight tools. Nothing in this file may make that a lie - and the temptation
    // would be a clock, which is why this server has none.
    const first = await callTool('query_range', { metric: 'error_rate', service: 'checkout-api' });
    const second = await callTool('query_range', { metric: 'error_rate', service: 'checkout-api' });
    assert.deepEqual(first.points, second.points);
    assert.deepEqual(first.served, second.served);
  }));

test('the default port is the one the documentation names', () => {
  // A default that disagrees with the docs sends anyone following them to a dead URL: a failing
  // health check and a connector registered at an address nothing is listening on.
  assert.match(readFileSync(SERVER, 'utf8'), /OBSERVABILITY_PORT \?\? 8798/);
});

/* ---------------------------------------------------------------------------------------------- */
/* The two servers agree, which is the whole reason to have both.                                   */
/* ---------------------------------------------------------------------------------------------- */

test('every reading ops-desk publishes, this store publishes the same number for', () =>
  withServer(async ({ callTool }) => {
    /**
     * The strictest test in this file, and the one that stops the two fixtures drifting.
     *
     * ops-desk's `get_service_health` returns five readings ten minutes apart. This store returns
     * one hundred and forty-one a minute apart. They describe the same incident, so at the five
     * instants both of them publish they have to agree exactly - not approximately, and not "both
     * show a step change". Two servers telling an investigation slightly different numbers about
     * the same minute is worse than one server, because the disagreement is invisible until
     * somebody quotes both in a report.
     */
    let checked = 0;
    for (const [service, readings] of Object.entries(INCIDENTS.health)) {
      const p99 = await seriesOf(callTool, 'latency_p99_ms', service, RETAINED.from, RETAINED.to);
      const errors = await seriesOf(callTool, 'error_rate', service, RETAINED.from, RETAINED.to);

      for (const reading of readings) {
        if (reading.at < RETAINED.from || reading.at > RETAINED.to) continue;
        assert.equal(p99.get(reading.at), reading.p99_ms, `${service} p99 at ${reading.at}`);
        assert.equal(errors.get(reading.at), reading.error_rate, `${service} error_rate at ${reading.at}`);
        checked += 1;
      }
    }
    assert.equal(checked, 7, 'ops-desk publishes seven readings inside this retention window');
  }));

test('the deploy ids and alert ids are ops-desk own, not a third set of names', () =>
  withServer(async ({ callTool }) => {
    /**
     * A correlation across two connectors is only worth anything if the identifiers match. An
     * annotation naming a deploy `4c21` that ops-desk calls something else does not let an agent
     * roll anything back; it lets it name a suspect it cannot act on.
     */
    const { annotations } = await callTool('list_annotations', {});
    const deployIds = annotations.filter((a) => a.deploy_id).map((a) => a.deploy_id).sort();
    const known = INCIDENTS.deploys.map((d) => d.id);
    for (const id of deployIds) assert.ok(known.includes(id), `${id} is not a deploy ops-desk has`);
    assert.deepEqual(deployIds, ['1de9', '4c21', '9ab7']);

    // And every annotation's timestamp is the shipped_at ops-desk records for that deploy.
    for (const note of annotations.filter((a) => a.deploy_id)) {
      const deploy = INCIDENTS.deploys.find((d) => d.id === note.deploy_id);
      assert.equal(note.at, deploy.shipped_at, `${note.deploy_id} ships at a different minute on each server`);
      assert.equal(note.service, deploy.service, `${note.deploy_id} is on a different service on each server`);
    }

    const { rules } = await callTool('list_alert_rules', {});
    for (const rule of rules.filter((r) => r.alert_id)) {
      const alert = INCIDENTS.alerts.find((a) => a.id === rule.alert_id);
      assert.ok(alert, `${rule.id} raises ${rule.alert_id}, which ops-desk does not have`);
      assert.equal(rule.service, alert.service, `${rule.id} names a different service than ${alert.id} does`);
    }
  }));

test('the rule that raised ALRT-4471 fires at the minute ops-desk says the alert started', () =>
  withServer(async ({ callTool }) => {
    /**
     * The threshold, the `for` window and the series all have to agree, or the fixture is telling
     * two stories. Error rate first exceeds 1% at 14:00 and the rule holds for 120s, which puts the
     * alert at 14:02 - which is the `first_seen` ops-desk publishes.
     */
    const alert = INCIDENTS.alerts.find((a) => a.id === 'ALRT-4471');
    const { rules } = await callTool('list_alert_rules', {});
    const rule = rules.find((r) => r.alert_id === 'ALRT-4471');

    const errors = await seriesOf(callTool, 'error_rate', 'checkout-api', RETAINED.from, RETAINED.to);
    const crossed = [...errors.entries()].find(([, v]) => v > rule.threshold)[0];
    assert.equal(crossed, '2026-08-26T14:00:00Z');
    assert.equal(new Date(Date.parse(crossed) + rule.for_s * 1000).toISOString().replace('.000Z', 'Z'), alert.first_seen);
    assert.equal(rule.since, alert.first_seen);
  }));

/* ---------------------------------------------------------------------------------------------- */
/* The trap, and the two explanations that are meant to be wrong.                                   */
/* ---------------------------------------------------------------------------------------------- */

test('the step change sits on the deploy annotation, which is the whole finding', () =>
  withServer(async ({ callTool }) => {
    const p99 = await seriesOf(callTool, 'latency_p99_ms', 'checkout-api', RETAINED.from, RETAINED.to);
    const before = [...p99.entries()].filter(([at]) => at <= '2026-08-26T13:58:00Z').map(([, v]) => v);
    const after = [...p99.entries()].filter(([at]) => at >= '2026-08-26T14:00:00Z').map(([, v]) => v);

    assert.ok(Math.max(...before) < 320, `checkout-api p99 must be flat before the deploy, saw ${Math.max(...before)}`);
    assert.ok(Math.min(...after) > 1900, `and pinned near the new timeout after it, saw ${Math.min(...after)}`);
    // Six and a half times, not a wobble. An investigation that finds nothing here has misread it.
    assert.ok(Math.min(...after) / Math.max(...before) > 6);

    const { annotations } = await callTool('list_annotations', {
      from: '2026-08-26T13:57:00Z',
      to: '2026-08-26T13:59:00Z',
    });
    assert.equal(annotations.length, 1);
    assert.equal(annotations[0].deploy_id, '4c21');
    assert.match(annotations[0].title, /5000ms to 2000ms/);
  }));

test('the dependency everyone wants to blame did not move, and is inside its own objective', () =>
  withServer(async ({ callTool }) => {
    /**
     * The control, and the first of the two planted wrong answers. "The payment gateway got slower"
     * fits the alert, fits the sample error, and asks for a page to another team rather than a
     * rollback. It is refuted by looking at the gateway before the deploy, which is the one thing
     * an investigation that starts at the alert never does.
     */
    const gw = await seriesOf(callTool, 'latency_p99_ms', 'payment-gateway', RETAINED.from, RETAINED.to);
    const before = [...gw.entries()].filter(([at]) => at < '2026-08-26T13:58:00Z').map(([, v]) => v);
    const after = [...gw.entries()].filter(([at]) => at >= '2026-08-26T14:00:00Z').map(([, v]) => v);
    assert.deepEqual(
      [Math.min(...before), Math.max(...before)],
      [Math.min(...after), Math.max(...after)],
      'the gateway must be identically slow on both sides, or the wrong answer stops being tempting',
    );

    // And it is not firing on its own rule, which is the fact that settles it.
    const { rules } = await callTool('list_alert_rules', { service: 'payment-gateway' });
    assert.equal(rules.length, 1);
    assert.equal(rules[0].state, 'ok');
    assert.ok(Math.max(...after) < rules[0].threshold, 'the gateway must be inside its own threshold');
    assert.equal(rules[0].since_within_retention, null, 'a rule that is not firing has no since to be outside anything');
  }));

test('checkout became faster than the thing it waits for, which is the tell', () =>
  withServer(async ({ callTool }) => {
    /**
     * The numeric fact that makes the correlation into a mechanism.
     *
     * A synchronous caller cannot have a lower p99 than its dependency unless it stopped waiting
     * for it. checkout-api's p99 is pinned at about 2000ms and the gateway's is about 2400ms, so
     * checkout is answering before the gateway has - which is not speed, it is a deadline. That is
     * the difference between "consistent with deploy 4c21" and "this is what 4c21 does".
     */
    const chk = await seriesOf(callTool, 'latency_p99_ms', 'checkout-api', '2026-08-26T14:00:00Z', RETAINED.to);
    const gw = await seriesOf(callTool, 'latency_p99_ms', 'payment-gateway', '2026-08-26T14:00:00Z', RETAINED.to);
    assert.ok(Math.max(...chk.values()) < Math.min(...gw.values()));

    // And the map says checkout waits for the gateway, so the comparison is a legitimate one.
    const map = await callTool('get_service_map', { service: 'checkout-api' });
    assert.ok(map.calls.includes('payment-gateway'));
  }));

test('the traffic explanation is plausible and the series refutes it', () =>
  withServer(async ({ callTool }) => {
    /**
     * The second planted wrong answer. Request rate rises 42% during this window and peaks during
     * the incident, so "we got busy and latency followed" fits every number an investigation reads
     * after 14:00.
     *
     * It is refuted by when: the traffic moved at 13:30 and the latency did not move for another
     * twenty-eight minutes. Fourteen of those minutes were at the full new rate. A cause that
     * arrives half an hour before its effect and does nothing in between is not the cause.
     */
    const rps = await seriesOf(callTool, 'requests_per_second', 'checkout-api', RETAINED.from, RETAINED.to);
    const p99 = await seriesOf(callTool, 'latency_p99_ms', 'checkout-api', RETAINED.from, RETAINED.to);

    assert.ok(rps.get('2026-08-26T13:29:00Z') < 130, 'traffic must be low before the campaign');
    assert.ok(rps.get('2026-08-26T13:44:00Z') > 165, 'and at the new level well before the deploy');
    assert.ok(rps.get('2026-08-26T14:05:00Z') > rps.get('2026-08-26T13:29:00Z') * 1.4, 'and higher still during the incident');

    // Fourteen minutes at the raised rate with the latency completely flat.
    for (let minute = 44; minute <= 57; minute += 1) {
      const at = `2026-08-26T13:${minute}:00Z`;
      assert.ok(rps.get(at) > 165, `traffic at ${at}`);
      assert.ok(p99.get(at) < 320, `latency at ${at} must not have moved with it`);
    }

    // And the campaign is on the timeline, so the wrong answer is available rather than invented.
    const { annotations } = await callTool('list_annotations', { kind: 'campaign' });
    assert.equal(annotations.length, 1);
    assert.equal(annotations[0].at, '2026-08-26T13:30:00Z');
  }));

test('the cache explanation is refuted by a timestamp the logs get wrong', () =>
  withServer(async ({ callTool }) => {
    /**
     * The third distractor, and the one that teaches something the logs cannot.
     *
     * ops-desk's checkout-api log carries "session cache hit rate 71%, below the 80% target" at
     * **14:05:02** - during the incident, five minutes after it started. Read from the logs alone
     * the cache degraded while checkout was failing.
     *
     * The series says it degraded at 13:20, thirty-eight minutes before the deploy and forty-two
     * before the alert. The log line's timestamp is when somebody looked, not when the thing
     * changed, and only a metric can tell you the difference.
     */
    const hits = await seriesOf(callTool, 'hit_rate', 'session-cache', RETAINED.from, RETAINED.to);
    assert.ok(hits.get('2026-08-26T13:19:00Z') > 0.84);
    assert.ok(hits.get('2026-08-26T13:20:00Z') < 0.73);
    // Flat from there, including straight across the deploy: it did not move when checkout did.
    assert.ok(hits.get('2026-08-26T13:57:00Z') < 0.73 && hits.get('2026-08-26T14:10:00Z') < 0.73);

    const line = INCIDENTS.logs['checkout-api'].find((l) => /session cache hit rate/.test(l.message));
    assert.match(line.message, /71%/);
    assert.ok(line.at > '2026-08-26T14:00:00Z', 'the log line has to be later than the change, or the lesson is gone');

    const { annotations } = await callTool('list_annotations', { service: 'session-cache' });
    assert.equal(annotations[0].at, '2026-08-26T13:20:00Z');
  }));

test('the annotation nearest the alert is not the cause, and there is one there to prove it', () =>
  withServer(async ({ callTool }) => {
    /**
     * ALRT-4471 starts firing at 14:02. The nearest annotation to that is the autoscaler at 14:05,
     * which is after both the alert and the step change and is a reaction to them. An agent that
     * correlates with whatever is closest to the alert picks it.
     *
     * The deploy is the third-nearest and is the only one that precedes the step.
     */
    const alert = INCIDENTS.alerts.find((a) => a.id === 'ALRT-4471');
    const { annotations } = await callTool('list_annotations', { service: 'checkout-api' });
    const byDistance = [...annotations].sort(
      (a, b) => Math.abs(Date.parse(a.at) - Date.parse(alert.first_seen)) - Math.abs(Date.parse(b.at) - Date.parse(alert.first_seen)),
    );
    assert.equal(byDistance[0].kind, 'scale');
    assert.ok(byDistance[0].at > alert.first_seen, 'the nearest one has to be after the alert');
    assert.equal(byDistance.find((a) => a.deploy_id === '4c21').at, '2026-08-26T13:58:00Z');
  }));

/* ---------------------------------------------------------------------------------------------- */
/* The partial answers, which are the only way this server can be wrong.                            */
/* ---------------------------------------------------------------------------------------------- */

test('a window wider than the retention is flagged, not silently served short', () =>
  withServer(async ({ callTool }) => {
    /**
     * The failure this whole file is arranged around. Ask a two-hour store for six hours and the
     * points that come back begin at 12:00 - which reads, to anything that did not check, as a
     * metric that was flat until then. An agent establishing a baseline from that is establishing
     * it from the shape of the retention.
     */
    const wide = await callTool('query_range', {
      metric: 'latency_p99_ms',
      service: 'checkout-api',
      from: '2026-08-26T06:00:00Z',
      to: '2026-08-26T18:00:00Z',
    });
    assert.equal(wide.truncated, true);
    assert.deepEqual(wide.missing_before, { from: '2026-08-26T06:00:00Z', to: RETAINED.from });
    assert.deepEqual(wide.missing_after, { from: RETAINED.to, to: '2026-08-26T18:00:00Z' });
    assert.match(wide.note, /not flat, and they are not zero/);
    assert.equal(wide.points.length, 141);

    // And a window inside the retention is not flagged, so the flag means something.
    const inside = await callTool('query_range', {
      metric: 'latency_p99_ms',
      service: 'checkout-api',
      from: '2026-08-26T13:00:00Z',
      to: '2026-08-26T14:00:00Z',
    });
    assert.equal(inside.truncated, false);
    assert.equal(inside.missing_before, null);
    assert.equal(inside.points.length, 61, 'both ends inclusive');
  }));

test('three ways of asking for nothing, and three different errors', () =>
  withServer(async ({ callTool }) => {
    /**
     * Every one of these used to be the same reply on servers that do not distinguish them: an
     * empty series. A metric this store does not keep, a service it does not keep, and a pair it
     * does not keep are three separate facts with three separate next moves, and only one of them
     * is "look somewhere else".
     */
    const outside = await callTool('query_range', {
      metric: 'latency_p99_ms',
      service: 'checkout-api',
      from: '2026-08-20T00:00:00Z',
      to: '2026-08-20T01:00:00Z',
    });
    assert.equal(outside.error, 'outside_retention');
    assert.equal(outside.points, undefined, 'not an empty list - an empty list reads as a flat metric');

    /**
     * A window inside the retention with no scrape in it, which is the one nobody asks for and
     * which reads worst of all: the store was watching and saw nothing, exactly like a quiet
     * service. Found by reading the coverage check, not by anybody reporting it.
     */
    const between = await callTool('query_range', {
      metric: 'latency_p99_ms',
      service: 'checkout-api',
      from: '2026-08-26T14:00:10Z',
      to: '2026-08-26T14:00:50Z',
    });
    assert.equal(between.error, 'no_points_in_window');
    assert.match(between.message, /narrower than the resolution/);

    assert.equal((await callTool('query_range', { metric: 'nope', service: 'checkout-api' })).error, 'unknown_metric');

    const unknown = await callTool('query_range', { metric: 'hit_rate', service: 'orders-db' });
    assert.equal(unknown.error, 'unknown_service');
    assert.equal(unknown.in_service_map, true, 'orders-db is real and uninstrumented, and the reply has to say which');

    const unpaired = await callTool('query_range', { metric: 'hit_rate', service: 'checkout-api' });
    assert.equal(unpaired.error, 'no_series');
    assert.deepEqual(unpaired.services_with_this_metric, ['session-cache']);
  }));

test('a name off the prototype chain is not a service', () =>
  withServer(async ({ callTool }) => {
    /**
     * `service in store.series` walks the prototype chain, so every name on Object.prototype is
     * truthy. ops-desk shipped that and answered `restart_service("toString")` with ok:true; here
     * the same mistake answers a query_range for `constructor` with a chart, and `__proto__` is
     * worse than that.
     */
    for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
      assert.equal((await callTool('query_range', { metric: 'error_rate', service: name })).error, 'unknown_service', name);
      assert.equal((await callTool('get_service_map', { service: name })).error, 'not_found', name);
      assert.equal(
        (await callTool('compare_windows', {
          metric: 'error_rate',
          service: name,
          baseline_from: RETAINED.from,
          baseline_to: '2026-08-26T13:00:00Z',
          compare_from: '2026-08-26T14:00:00Z',
          compare_to: RETAINED.to,
        })).error,
        'unknown_service',
        name,
      );
    }
  }));

test('a step that is not a whole scrape is refused rather than interpolated', () =>
  withServer(async ({ callTool }) => {
    /**
     * A step smaller than the scrape interval means inventing points between measurements, and
     * nothing in the reply would let a reader tell an invented point from a measured one. A step
     * that is not a multiple puts the same scrape in two buckets, so a series of 141 readings
     * answers with 142 points.
     */
    const odd = await callTool('query_range', { metric: 'latency_p99_ms', service: 'checkout-api', step_s: 90 });
    assert.equal(odd.error, 'bad_step');
    assert.deepEqual(odd.nearest_valid, [60, 120]);

    const tooFine = await callTool('query_range', { metric: 'latency_p99_ms', service: 'checkout-api', step_s: 15 });
    assert.equal(tooFine.error, 'bad_step');

    // And a valid multiple still answers.
    const fine = await callTool('query_range', { metric: 'latency_p99_ms', service: 'checkout-api', step_s: 120 });
    assert.equal(fine.error, undefined);
    assert.equal(fine.downsampled, true);
  }));

test('a percentile is never averaged, and a coarse step says it is an approximation', () =>
  withServer(async ({ callTool }) => {
    /**
     * The mean of [305, 1980] is 1142. A five-minute step that averaged would turn the step change
     * this whole fixture is built around into a gentle slope through a number that looks like a
     * slow service rather than a broken one - and the reply would carry no sign that it had done
     * so. The p99 of merged buckets is not a function of the p99s inside them at all, so the
     * maximum is reported and named as the approximation it is.
     */
    const coarse = await callTool('query_range', {
      metric: 'latency_p99_ms',
      service: 'checkout-api',
      from: '2026-08-26T13:40:00Z',
      to: RETAINED.to,
      step_s: 300,
    });
    assert.equal(coarse.aggregation, 'max');
    assert.match(coarse.note, /is an approximation and an upper one/);
    for (const point of coarse.points) {
      assert.ok(point.merged >= 1, 'each point has to say how many readings it merged');
    }
    // No merged point may sit between the two levels, which is what an average would produce.
    const between = coarse.points.filter((p) => p.value > 320 && p.value < 1100);
    assert.deepEqual(between, [], 'a value between the two levels is an average, and this must never average a p99');

    // A metric that is not a percentile does average, and says which it did.
    const rate = await callTool('query_range', {
      metric: 'requests_per_second',
      service: 'checkout-api',
      from: '2026-08-26T13:40:00Z',
      to: RETAINED.to,
      step_s: 300,
    });
    assert.equal(rate.aggregation, 'mean');
    assert.match(rate.note, /mean of each bucket/);
  }));

test('a coarse step moves where the step change appears to be, which is why the note is there', () =>
  withServer(async ({ callTool }) => {
    /**
     * The artefact worth knowing about, and the one that would let a wrong answer through even
     * with the percentile handled correctly.
     *
     * At the 60s scrape interval the last normal reading is 13:58 and the first raised one is
     * 13:59 - the deploy is at 13:58 and the correlation is exact. At a 300s step the bucket
     * starting 13:55 already carries the raised value, because its maximum includes 13:59. So the
     * chart says the regression began at 13:55, three minutes before the deploy that caused it -
     * and an investigation reading only that would rule the deploy out and reach for the campaign
     * at 13:30 instead.
     *
     * Bucketing moves a step change earlier, always. That is a property of taking a maximum over a
     * window, not a defect, and the way to be right about it is to query at the scrape interval
     * before naming a minute.
     */
    const fine = await callTool('query_range', {
      metric: 'latency_p99_ms',
      service: 'checkout-api',
      from: '2026-08-26T13:40:00Z',
      to: RETAINED.to,
    });
    const firstRaisedFine = fine.points.find((p) => p.value > 1000).at;
    assert.equal(firstRaisedFine, '2026-08-26T13:59:00Z');

    const coarse = await callTool('query_range', {
      metric: 'latency_p99_ms',
      service: 'checkout-api',
      from: '2026-08-26T13:40:00Z',
      to: RETAINED.to,
      step_s: 300,
    });
    const firstRaisedCoarse = coarse.points.find((p) => p.value > 1000).at;
    assert.equal(firstRaisedCoarse, '2026-08-26T13:55:00Z');
    assert.ok(
      firstRaisedCoarse < '2026-08-26T13:58:00Z',
      'the coarse bucket has to land before the deploy, or this trap is not set',
    );
    assert.match(coarse.note, /Query at the 60s scrape interval before quoting a number/);
  }));

/* ---------------------------------------------------------------------------------------------- */
/* compare_windows, which is where "it recovered" gets refused.                                     */
/* ---------------------------------------------------------------------------------------------- */

test('a comparison against a window with nothing in it is refused, not computed', () =>
  withServer(async ({ callTool }) => {
    /**
     * The last step of an investigation, and the one a demo most wants to fake. With no desk to
     * ask, the honest state of this store is that no reading exists past 14:20. A tool that
     * answered `change: null` and nothing else would let "recovered" be written on the strength of
     * a field nobody read.
     *
     * ops-desk refuses `resolve_alert` with `no_readings` for exactly this reason, and this is that
     * discipline on the metric side.
     */
    const recovery = await callTool('compare_windows', {
      metric: 'latency_p99_ms',
      service: 'checkout-api',
      baseline_from: '2026-08-26T13:30:00Z',
      baseline_to: '2026-08-26T13:57:00Z',
      compare_from: '2026-08-26T14:25:00Z',
      compare_to: '2026-08-26T14:35:00Z',
    });
    assert.equal(recovery.change, null);
    assert.equal(recovery.refused.length, 1);
    assert.equal(recovery.refused[0].window, 'compare');
    assert.equal(recovery.refused[0].why, 'no_points_in_window');
    /**
     * And it says which empty it is. "There is no reading yet" and "I could not find out whether
     * there is a reading" are the same blank chart, and only one of them may be reported as a
     * recovery that has not been observed.
     */
    assert.match(recovery.refused[0].detail, /could not be reached/);
    assert.match(recovery.refused[0].detail, /not evidence that nothing happened/);
    assert.equal(recovery.world.reachable, false);
  }));

test('a comparison over a window the store only half kept is refused too', () =>
  withServer(async ({ callTool }) => {
    /**
     * Smaller than the empty case and it goes the same way. The mean of a window missing half its
     * minutes is the mean of the half that was kept, and nothing in the number says which half -
     * so a baseline reaching back before the retention would be computed from the incident's own
     * opening minutes and compared against itself.
     */
    const half = await callTool('compare_windows', {
      metric: 'latency_p99_ms',
      service: 'checkout-api',
      baseline_from: '2026-08-26T09:00:00Z',
      baseline_to: '2026-08-26T12:30:00Z',
      compare_from: '2026-08-26T14:00:00Z',
      compare_to: RETAINED.to,
    });
    assert.equal(half.change, null);
    assert.equal(half.refused[0].why, 'window_not_fully_retained');
    assert.ok(half.baseline.points > 0, 'the points it did have are still reported, so the refusal is checkable');
  }));

test('a comparison it can make reports the step, and calls the mean what it is', () =>
  withServer(async ({ callTool }) => {
    const step = await callTool('compare_windows', {
      metric: 'latency_p99_ms',
      service: 'checkout-api',
      baseline_from: '2026-08-26T13:30:00Z',
      baseline_to: '2026-08-26T13:57:00Z',
      compare_from: '2026-08-26T14:00:00Z',
      compare_to: RETAINED.to,
    });
    assert.equal(step.refused, null);
    assert.ok(step.change.max_ratio > 6);
    assert.equal(step.baseline.percentile_metric, true);
    // `mean_of_points`, not `mean`. The average of ninety-ninth percentiles is not a percentile,
    // and a field called `mean` on a p99 series invites somebody to quote it as one.
    assert.equal(typeof step.baseline.mean_of_points, 'number');
    assert.equal(step.baseline.mean, undefined);
    assert.match(step.note, /is not itself a percentile/);
  }));

/* ---------------------------------------------------------------------------------------------- */
/* The rest of the surface.                                                                         */
/* ---------------------------------------------------------------------------------------------- */

test('a window that cannot be read is refused, not quietly dropped', () =>
  withServer(async ({ callTool }) => {
    /**
     * `from: "14:00"` is how a person says it and therefore how a model says it. Dropped, it
     * becomes the default window and the reply looks like a chart somebody asked for. ops-desk
     * shipped the string-comparison version of this and answered a narrow search with every line
     * in the file.
     */
    const unreadable = await callTool('query_range', { metric: 'error_rate', service: 'checkout-api', from: '14:00' });
    assert.equal(unreadable.error, 'bad_timestamp');
    assert.equal(unreadable.field, 'from');

    const backwards = await callTool('query_range', {
      metric: 'error_rate',
      service: 'checkout-api',
      from: RETAINED.to,
      to: RETAINED.from,
    });
    assert.equal(backwards.error, 'bad_window');

    // The same two on the tools that take a window, because a refusal one tool makes and another
    // does not is worse than neither making it.
    assert.equal((await callTool('list_annotations', { from: 'yesterday afternoon' })).error, 'bad_timestamp');
    const badCompare = await callTool('compare_windows', {
      metric: 'error_rate',
      service: 'checkout-api',
      baseline_from: RETAINED.from,
      baseline_to: '2026-08-26T13:00:00Z',
      compare_from: 'half two',
      compare_to: RETAINED.to,
    });
    assert.equal(badCompare.error, 'bad_timestamp');
    assert.equal(badCompare.window, 'compare', 'and it says which of the two windows was unreadable');
  }));

test('no annotations matched is a filter, and the reply says which empty it is', () =>
  withServer(async ({ callTool }) => {
    /**
     * `matched: 0` on its own reads as a timeline with nothing on it, which an agent concludes as
     * "nothing shipped, so this is not a deploy". Beside `held: 6` it reads as a filter, which is
     * the true statement and a different next move. Same shape as ops-desk's search_logs.
     */
    const none = await callTool('list_annotations', { service: 'search-api', kind: 'scale' });
    assert.equal(none.matched, 0);
    assert.equal(none.held, 6);

    const all = await callTool('list_annotations', {});
    assert.equal(all.matched, 6);

    /**
     * And an annotation outside the metric retention says so, rather than sending the agent to a
     * query_range that refuses. 9ab7 is the deploy a rollback returns the service to, and it
     * shipped the previous day - so it is exactly the one worth knowing this about.
     */
    const previous = all.annotations.find((a) => a.deploy_id === '9ab7');
    assert.equal(previous.within_retention, false);
    assert.equal(all.annotations.find((a) => a.deploy_id === '4c21').within_retention, true);
  }));

test('the map names more services than the store measures, and admits it', () =>
  withServer(async ({ callTool }) => {
    /**
     * A dependency you can name is not a dependency you can measure. Without `has_series` an agent
     * traces "checkout is slow" to orders-db, calls query_range, and gets a refusal it has no way
     * to read - it cannot tell an uninstrumented service from a misspelled one.
     */
    const map = await callTool('get_service_map', {});
    const uninstrumented = map.services.filter((s) => !s.has_series).map((s) => s.service).sort();
    assert.deepEqual(uninstrumented, ['edge', 'object-store', 'orders-db', 'reporting', 'search-index']);
    for (const node of map.services.filter((s) => !s.has_series)) assert.deepEqual(node.metrics, []);

    /**
     * `reporting` is the interesting one: ops-desk keeps logs for it and no health series, because
     * a nightly export is not a service taking traffic. This store agrees, which is what "the two
     * fixtures describe one estate" has to mean.
     */
    assert.ok(Object.hasOwn(INCIDENTS.logs, 'reporting'));
    assert.ok(!Object.hasOwn(INCIDENTS.health, 'reporting'));

    const checkout = await callTool('get_service_map', { service: 'checkout-api' });
    assert.deepEqual(checkout.calls, ['payment-gateway', 'session-cache', 'orders-db']);
    assert.deepEqual(checkout.called_by, ['edge']);
    assert.equal(checkout.neighbours.length, 4);
  }));

test('a panel names a query you can make, and says when it would draw nothing', () =>
  withServer(async ({ callTool }) => {
    const { dashboards } = await callTool('list_dashboards');
    assert.ok(dashboards.length >= 3);

    const board = await callTool('get_dashboard', { dashboard_id: 'checkout-overview' });
    for (const panel of board.panels) {
      assert.equal(typeof panel.metric, 'string');
      assert.equal(typeof panel.service, 'string');
      assert.equal(panel.has_series, true);
      // Every panel on this board is a query_range call that answers, which is the point of
      // publishing the metric and the service on it rather than only a title.
      const answer = await callTool('query_range', { metric: panel.metric, service: panel.service });
      assert.equal(answer.error, undefined, `${panel.id} charts something query_range refuses`);
      assert.equal(answer.unit, panel.unit);
    }

    const missing = await callTool('get_dashboard', { dashboard_id: 'nope' });
    assert.equal(missing.error, 'not_found');
    assert.ok(missing.known.includes('checkout-overview'));
  }));

test('list_metrics publishes the units and the retention, because both are guessed otherwise', () =>
  withServer(async ({ callTool }) => {
    /**
     * 11.7% against a 1% threshold and 0.117% against the same one are opposite findings, and the
     * only thing between them is whether `error_rate` is a fraction. The retention is published for
     * the same reason: a baseline window is chosen before the first query, and one chosen without
     * knowing where the data starts is chosen against the shape of the store.
     */
    const answer = await callTool('list_metrics');
    assert.equal(answer.retention.from, RETAINED.from);
    assert.equal(answer.retention.resolution_s, 60);
    assert.equal(answer.retention.now, RETAINED.to);

    const byName = new Map(answer.metrics.map((m) => [m.name, m]));
    assert.equal(byName.get('error_rate').unit, 'ratio');
    assert.equal(byName.get('latency_p99_ms').unit, 'ms');
    assert.equal(byName.get('latency_p99_ms').percentile, true);
    assert.equal(byName.get('requests_per_second').percentile, false);
    assert.deepEqual(byName.get('hit_rate').services, ['session-cache']);
  }));

/* ---------------------------------------------------------------------------------------------- */
/* Verifying a fix, which is the step this store could not reach before and the one worth faking.   */
/* ---------------------------------------------------------------------------------------------- */

/** A minute past two on the day this whole fixture is about. */
const minute = (n) => `2026-08-26T14:${String(n).padStart(2, '0')}:00Z`;

test('a rollback puts readings after the incident window, and they are this store own', () =>
  withPair(async ({ desk, callTool }) => {
    /**
     * The step that was missing. Before this, the store ended at 14:20 whatever happened next, so
     * the honest answer to "did the fix work" was always "no reading exists" - and an agent could
     * only ever predict a recovery.
     *
     * What makes the new readings honest is that they are not new numbers. 9ab7 restores a 5000ms
     * payment-gateway budget; this store measured that gateway at 2388-2430ms for 141 consecutive
     * minutes; so the call finishes, and checkout-api's p99 is what it was for the 119 minutes it
     * last ran with that budget. The assertion below is that literally - the post-rollback value
     * has to be a reading this store already held before the incident.
     */
    const rolled = await desk.callTool('rollback_deploy', { deploy_id: '4c21', reason: 'the timeout was cut below the gateway' });
    assert.equal(rolled.ok, true);
    assert.equal(rolled.to, '9ab7');
    assert.equal(rolled.at, minute(21), 'ops-desk ticks a minute per remediation, onto this store scrape boundary');

    const after = await callTool('query_range', {
      metric: 'latency_p99_ms',
      service: 'checkout-api',
      from: minute(19),
      to: minute(21),
    });
    assert.equal(after.error, undefined);
    assert.equal(after.retention.to, minute(21), 'the store now runs one reading past its fixture');
    assert.equal(after.retention.in_fixture, RETAINED.to, 'and still says where the checked-in numbers stop');
    assert.equal(after.retention.extended_by, 1);

    const recovered = after.points.at(-1);
    assert.equal(recovered.at, minute(21));
    assert.ok(recovered.value < 320, `p99 must be back at its baseline, saw ${recovered.value}`);

    /**
     * Derived, not typed in. If somebody replaces the replay with a hardcoded healthy number this
     * goes red, which is the point of asserting it rather than asserting `< 320`.
     */
    const before = METRICS.series['checkout-api'].latency_p99_ms.slice(0, 119);
    assert.ok(
      before.includes(recovered.value),
      `${recovered.value} is not a reading this store took before the incident - a recovery has to be replayed, not invented`,
    );

    const errors = await callTool('query_range', { metric: 'error_rate', service: 'checkout-api', from: minute(20), to: minute(21) });
    assert.ok(errors.points.at(-1).value < 0.01, 'and the error rate is back under the rule threshold');
    assert.ok(METRICS.series['checkout-api'].error_rate.slice(0, 119).includes(errors.points.at(-1).value));
  }));

test('the arithmetic that decides a recovery is two numbers this store already published', () =>
  withPair(async ({ desk, callTool }) => {
    /**
     * The claim in the README, asserted against the fixture rather than believed.
     *
     * A synchronous caller finishes if its deadline is above what the dependency takes. The
     * dependency's spread is 141 readings on the chart next door and the deadlines are what each
     * deploy set. 2000 is below the gateway's fastest minute and 5000 is above its slowest, so
     * neither verdict depends on which minute you pick - and if somebody softens the gateway series
     * until 2000ms starts fitting inside it, this goes red before the recovery does.
     */
    const gateway = await seriesOf(callTool, 'latency_p99_ms', 'payment-gateway', RETAINED.from, RETAINED.to);
    const slowest = Math.max(...gateway.values());
    const fastest = Math.min(...gateway.values());
    const budgets = METRICS.recovery.client_timeout_ms;

    assert.ok(budgets['4c21'] < fastest, `4c21 sets ${budgets['4c21']}ms, which must be below the gateway's fastest minute (${fastest}ms)`);
    assert.ok(budgets['9ab7'] > slowest, `9ab7 sets ${budgets['9ab7']}ms, which must be above the gateway's slowest minute (${slowest}ms)`);

    // And the deploy the fixture starts its replay from is the one ops-desk says is current, or the
    // replay begins on a version nothing is running.
    const deploys = await desk.callTool('list_deploys', { service: 'checkout-api' });
    assert.equal(deploys.deploys[0].id, METRICS.recovery.deployed_at_window_end);

    // Every deploy this store carries a budget for is a deploy ops-desk has, so the two servers
    // cannot disagree about which versions exist.
    for (const id of Object.keys(budgets)) {
      assert.ok(
        INCIDENTS.deploys.some((d) => d.id === id && d.service === METRICS.recovery.service),
        `${id} is not an ops-desk checkout deploy`,
      );
    }
  }));

test('a remediation that fixes nothing still reads as broken, which is what makes this a verify step', () =>
  withPair(async ({ desk, callTool }) => {
    /**
     * The half that matters. A verify step that can only ever confirm success is not a verify step,
     * and this one is reachable from an ordinary agent: restarting is the first thing anybody tries.
     *
     * A restart cycles the instances 4c21 is on. The budget is still 2000ms, the gateway still
     * takes 2400ms, so the call still cannot finish - and the reading taken after it has to say so.
     */
    assert.equal((await desk.callTool('restart_service', { service: 'checkout-api', reason: 'wedged workers' })).ok, true);

    const after = await callTool('query_range', { metric: 'latency_p99_ms', service: 'checkout-api', from: minute(21), to: minute(21) });
    assert.equal(after.error, undefined, 'a reading has to exist, or this is the old no-evidence-either-way');
    assert.ok(after.points[0].value > 1900, `the regression must still be there, saw ${after.points[0].value}`);

    const errors = await callTool('query_range', { metric: 'error_rate', service: 'checkout-api', from: minute(21), to: minute(21) });
    assert.ok(errors.points[0].value > 0.1, `and the error rate with it, saw ${errors.points[0].value}`);

    /**
     * compare_windows must not report an improvement that did not happen. Against the pre-incident
     * baseline the ratio is still six and a half; against the incident window it is one.
     */
    const versusHealthy = await callTool('compare_windows', {
      metric: 'latency_p99_ms',
      service: 'checkout-api',
      baseline_from: '2026-08-26T13:30:00Z',
      baseline_to: '2026-08-26T13:57:00Z',
      compare_from: minute(21),
      compare_to: minute(21),
    });
    assert.equal(versusHealthy.refused, null, 'the comparison is makeable - refusing it would hide the failure, not report it');
    assert.ok(versusHealthy.change.max_ratio > 6, `no improvement may be reported, saw ${versusHealthy.change.max_ratio}`);
    assert.ok(versusHealthy.change.max_delta > 0, 'and the delta has to point the wrong way');

    const versusIncident = await callTool('compare_windows', {
      metric: 'latency_p99_ms',
      service: 'checkout-api',
      baseline_from: minute(0),
      baseline_to: RETAINED.to,
      compare_from: minute(21),
      compare_to: minute(21),
    });
    assert.ok(
      Math.abs(versusIncident.change.max_ratio - 1) < 0.05,
      `nothing changed, so the ratio is one, saw ${versusIncident.change.max_ratio}`,
    );

    // And the rules agree: the thresholds re-read against the latest reading are still breached.
    const { rules } = await callTool('list_alert_rules', { service: 'checkout-api' });
    for (const rule of rules) {
      assert.equal(rule.still_breaching, true, `${rule.id} must still be breaching after a remediation that changed nothing`);
      assert.equal(rule.latest.at, minute(21));
    }
  }));

test('rolling back the wrong service is a remediation too, and it does not move this one', () =>
  withPair(async ({ desk, callTool }) => {
    /**
     * The other unsuccessful path, and the one an investigation reaches by correlating with the
     * wrong annotation. `1de9` is search-api's deploy: rolling it back is accepted, is destructive,
     * ticks the clock, and does nothing whatever to checkout-api's budget.
     *
     * If this store keyed the recovery off "was anything done" rather than off what is deployed,
     * this is the call that would fake one.
     */
    const rolled = await desk.callTool('rollback_deploy', { deploy_id: '1de9', reason: 'wrong suspect' });
    assert.equal(rolled.ok, true);
    assert.equal(rolled.service, 'search-api');

    const after = await callTool('query_range', { metric: 'latency_p99_ms', service: 'checkout-api', from: minute(21), to: minute(21) });
    assert.ok(after.points[0].value > 1900, `checkout-api must be unchanged, saw ${after.points[0].value}`);
    assert.equal(after.world.deployed, '4c21', 'because checkout-api is still on the deploy that broke it');

    const { rules } = await callTool('list_alert_rules', { service: 'checkout-api' });
    assert.ok(rules.every((r) => r.still_breaching === true));
  }));

test('a window with the fix inside it is refused rather than averaged across', () =>
  withPair(async ({ desk, callTool }) => {
    /**
     * A restart at 14:21 that changed nothing, then a rollback at 14:22 that changed everything.
     * The window 14:21 to 14:22 holds one reading from each world.
     *
     * Its mean lands between the two levels, which reads as a service half way better - and nothing
     * in the number says the window was two windows. Same failure as averaging a percentile across
     * a coarse bucket, in a new place, and refused for the same reason.
     */
    await desk.callTool('restart_service', { service: 'checkout-api', reason: 'first try' });
    await desk.callTool('rollback_deploy', { deploy_id: '4c21', reason: 'then the fix' });

    const straddled = await callTool('compare_windows', {
      metric: 'latency_p99_ms',
      service: 'checkout-api',
      baseline_from: '2026-08-26T13:30:00Z',
      baseline_to: '2026-08-26T13:57:00Z',
      compare_from: minute(21),
      compare_to: minute(22),
    });
    assert.equal(straddled.change, null);
    assert.equal(straddled.refused[0].window, 'compare');
    assert.equal(straddled.refused[0].why, 'window_straddles_remediation');
    assert.equal(straddled.compare.straddles[0].at, minute(22));
    assert.equal(straddled.compare.straddles[0].to, '9ab7');

    /**
     * The number the refusal is protecting against, asserted so the refusal cannot be dropped later
     * as pedantry. Between the two levels is exactly where a mean lands.
     */
    assert.ok(
      straddled.compare.mean_of_points > 400 && straddled.compare.mean_of_points < 1900,
      `the mean across the rollback is ${straddled.compare.mean_of_points}, which is a level nothing was ever at`,
    );

    // A window entirely on the far side of it is answered, so the refusal is about the straddle and
    // not about the window being new.
    const clean = await callTool('compare_windows', {
      metric: 'latency_p99_ms',
      service: 'checkout-api',
      baseline_from: minute(0),
      baseline_to: RETAINED.to,
      compare_from: minute(22),
      compare_to: minute(22),
    });
    assert.equal(clean.refused, null);
    assert.ok(clean.change.max_ratio < 0.2, `recovered, and by this much: ${clean.change.max_ratio}`);
    assert.match(clean.note, /observation rather than a trend/, 'one scrape is one scrape, and the reply has to say so');
  }));

test('a restart is not a straddle, because this store own numbers say nothing moved', () =>
  withPair(async ({ desk, callTool }) => {
    /**
     * The refusal has to be about the readings and not about the ceremony. A restart leaves the
     * same deploy running, so the minutes either side of it are one world - and refusing to
     * summarise across it would deny the verify step the number it most needs, which is the one
     * showing that nothing improved.
     */
    await desk.callTool('restart_service', { service: 'checkout-api', reason: 'probe' });

    const across = await callTool('compare_windows', {
      metric: 'latency_p99_ms',
      service: 'checkout-api',
      baseline_from: '2026-08-26T13:30:00Z',
      baseline_to: '2026-08-26T13:57:00Z',
      compare_from: minute(15),
      compare_to: minute(21),
    });
    assert.equal(across.refused, null, 'a restart that moved nothing must not block a comparison');
    assert.deepEqual(across.compare.straddles, []);
    // It is still reported as having happened inside the window, because it did.
    assert.equal(across.compare.remediations_inside[0].action, 'restart_service');
    assert.ok(across.change.max_ratio > 6, 'and the answer is still that nothing got better');
  }));

test('only the series a client timeout decides run past the window, and the rest say why not', () =>
  withPair(async ({ desk, callTool }) => {
    /**
     * The line between deriving and inventing. checkout-api's request rate after a rollback is not
     * something the payment-gateway budget decides - the campaign traffic is still arriving - so
     * this store has no basis for a number and publishes none rather than continuing the line.
     */
    await desk.callTool('rollback_deploy', { deploy_id: '4c21', reason: 'the fix' });

    for (const [service, metric] of [
      ['checkout-api', 'requests_per_second'],
      ['payment-gateway', 'latency_p99_ms'],
      ['session-cache', 'hit_rate'],
    ]) {
      const past = await callTool('query_range', { metric, service, from: minute(21), to: minute(21) });
      assert.equal(past.error, 'outside_retention', `${service} ${metric}`);
      assert.equal(past.points, undefined, 'not an empty list - an empty list reads as a flat metric');
      assert.match(past.why_it_ends_here, /not something a payment-gateway client timeout decides/);
      assert.equal(past.retention.to, RETAINED.to, `${service} ${metric} still ends where the fixture does`);
    }

    // And list_metrics names the two that do go further, so nobody has to work it out per series.
    const listed = await callTool('list_metrics');
    assert.deepEqual(
      listed.retention.extended.map((s) => `${s.service} ${s.metric}`),
      ['checkout-api latency_p99_ms', 'checkout-api error_rate'],
    );
    assert.equal(listed.retention.to, RETAINED.to, 'the store-wide block still reports where the fixture stops');
    assert.equal(listed.retention.now, minute(21));
  }));

test('a desk this store cannot reach is not a desk that has done nothing', () =>
  withServer(async ({ callTool, health }) => {
    /**
     * The quiet failure, and the reason every reply carries a `world` block. With nothing listening
     * the store ends at 14:20, which is character for character the same output as a desk that has
     * been asked and has done nothing - and an agent verifying a rollback would read the first as
     * the second.
     */
    const answer = await callTool('query_range', { metric: 'latency_p99_ms', service: 'checkout-api', from: minute(21), to: minute(21) });
    assert.equal(answer.error, 'outside_retention');
    assert.equal(answer.world.reachable, false);
    assert.match(answer.world.why, /could not be reached/);
    assert.match(answer.world.note, /not the same as knowing nothing has been done/);
    assert.match(answer.why_it_ends_here, /not evidence that nothing happened/);

    // /health says the same thing rather than reporting a span it has not checked.
    const line = await health();
    assert.equal(line.retention, `${RETAINED.from} to ${RETAINED.to}`);
    assert.deepEqual(line.extended_series, []);
    assert.match(line.world_as_last_read, /could not be reached/);
  }));

test('a desk answering something this store cannot use is refused, not half read', async () => {
  /**
   * Every field below arrives from another process and decides whether this store publishes a
   * recovery. Accepted half-read, each of them produces readings nobody measured under a timestamp
   * nobody took, and the reply gives no way to tell those from the fixture's own.
   *
   * The off-boundary case is the subtle one: a remediation at 14:21:30 sits in the middle of the
   * minute the 14:22 scrape covers, so attributing that whole scrape to either world publishes a
   * percentile that is half of each.
   */
  const good = {
    now: minute(21),
    deployed: { 'checkout-api': '9ab7' },
    remediations: [{ action: 'rollback_deploy', service: 'checkout-api', to: '9ab7', at: minute(21) }],
  };

  const cases = [
    [{ ...good, now: 'half past two' }, /without a `now` this store can read/],
    [{ ...good, now: '2026-08-26T13:00:00Z' }, /before this store's own/],
    [{ ...good, now: '2026-08-27T14:21:00Z' }, /more than the 141 readings/],
    [{ now: minute(21), deployed: {} }, /without a `remediations` list/],
    [{ ...good, remediations: [{ ...good.remediations[0], at: 'the other day' }] }, /timestamp this store cannot read/],
    [{ ...good, remediations: [{ ...good.remediations[0], at: '2026-08-26T14:21:30Z' }] }, /not on this store's 60s scrape boundary/],
    ['{ not json', /could not be reached|JSON/],
  ];

  for (const [payload, expected] of cases) {
    await withStubDesk(payload, async ({ callTool }) => {
      const answer = await callTool('query_range', { metric: 'latency_p99_ms', service: 'checkout-api', from: minute(21), to: minute(21) });
      assert.equal(answer.error, 'outside_retention', `${JSON.stringify(payload).slice(0, 60)} must not extend the store`);
      assert.equal(answer.world.reachable, false);
      assert.match(answer.world.why, expected);
    });
  }

  /**
   * And a desk that contradicts its own journal is refused rather than resolved in favour of
   * either. Two servers disagreeing about which version is running is worse than one server,
   * because the disagreement is invisible until somebody quotes both - and here it decides whether
   * a recovery gets published.
   */
  await withStubDesk({ ...good, deployed: { 'checkout-api': '4c21' } }, async ({ callTool }) => {
    const answer = await callTool('query_range', { metric: 'latency_p99_ms', service: 'checkout-api', from: minute(21), to: minute(21) });
    assert.equal(answer.error, 'outside_retention');
    assert.equal(answer.world.reachable, true, 'the desk answered - what it said is the problem');
    assert.match(answer.why_it_ends_here, /replaying the actions it recorded gives 9ab7/);
  });

  /**
   * A deploy this store has no budget for stops the replay rather than guessing one. Without this,
   * an unknown version would fall through to whichever branch was written last.
   */
  await withStubDesk(
    {
      now: minute(21),
      deployed: { 'checkout-api': 'beef' },
      remediations: [{ action: 'rollback_deploy', service: 'checkout-api', to: 'beef', at: minute(21) }],
    },
    async ({ callTool }) => {
      const answer = await callTool('query_range', { metric: 'latency_p99_ms', service: 'checkout-api', from: minute(21), to: minute(21) });
      assert.equal(answer.error, 'outside_retention');
      assert.match(answer.why_it_ends_here, /no payment-gateway client timeout recorded for it/);
    },
  );
});

test('the remediation is drawn on the timeline, so a step change down has its marker too', () =>
  withPair(async ({ desk, callTool }) => {
    /**
     * This store opens by saying that a step change and a marker on the same minute is the whole
     * finding and neither half says anything alone. That is as true of a recovery as of a
     * regression, so the rollback goes on the timeline - labelled with where it came from, because
     * this store did not observe it.
     */
    await desk.callTool('rollback_deploy', { deploy_id: '4c21', reason: 'the fix' });

    const all = await callTool('list_annotations', {});
    assert.equal(all.held, 7, 'six in the fixture, one reported by the desk');
    assert.equal(all.reported_by_ops_desk, 1);

    const marker = all.annotations.find((a) => a.source === 'ops-desk');
    assert.equal(marker.kind, 'remediation');
    assert.equal(marker.at, minute(21));
    assert.equal(marker.deploy_id, '9ab7', 'the version it returned to, which ops-desk will answer for');
    assert.equal(marker.within_retention, true, 'and the series does run that far, so it is chartable');

    /**
     * It is not a deploy. `list_deploys` on ops-desk has no row for a rollback, so folding it into
     * `kind: "deploy"` would hand an agent an id that does not resolve on the desk it came from.
     */
    const deploys = await callTool('list_annotations', { kind: 'deploy' });
    assert.equal(deploys.matched, 3);
    assert.ok(deploys.annotations.every((a) => a.source === undefined));
    assert.equal((await callTool('list_annotations', { kind: 'remediation' })).matched, 1);
  }));

test('what the rule recorded and what the latest reading says are published separately', () =>
  withPair(async ({ desk, callTool }) => {
    /**
     * `state` is what the rule was doing when this fixture was written and it stays that - a stored
     * fact this server did not compute and must not quietly rewrite. After a rollback it is the
     * wrong answer to "is it still broken", so the threshold is read again against the latest
     * reading and both are published. They disagree exactly when something has changed.
     */
    const before = await callTool('list_alert_rules', {});
    const beforeById = new Map(before.rules.map((r) => [r.id, r]));
    assert.equal(beforeById.get('RULE-CHK-5XX').still_breaching, true);
    assert.equal(beforeById.get('RULE-EXPORT').still_breaching, null, 'a rule watching a job exit status has no series to re-read');
    assert.equal(beforeById.get('RULE-GW-P99').still_breaching, false, 'the gateway was always inside its own objective');

    await desk.callTool('rollback_deploy', { deploy_id: '4c21', reason: 'the fix' });

    const after = await callTool('list_alert_rules', { service: 'checkout-api' });
    for (const rule of after.rules) {
      assert.equal(rule.state, 'firing', 'the recorded state is not rewritten');
      assert.equal(rule.still_breaching, false, `${rule.id} no longer breaches its threshold`);
      assert.equal(rule.latest.at, minute(21));
    }
    assert.match(after.note, /`state` is what the rule was doing at/);
  }));

test('the health line says where the store ends, and where its fixture ends', () =>
  withPair(async ({ desk, callTool, health }) => {
    /**
     * /health is answered synchronously and cannot ask the desk, so it reports what the last query
     * learned. The alternative was a health line saying "to 14:20" while list_metrics said
     * "to 14:21", which is one server giving two answers about its own retention.
     */
    const cold = await health();
    assert.match(cold.world_as_last_read, /no tool call has asked ops-desk yet/);

    await desk.callTool('rollback_deploy', { deploy_id: '4c21', reason: 'the fix' });
    await callTool('list_metrics');

    const warm = await health();
    assert.equal(warm.retention, `${RETAINED.from} to ${minute(21)}`);
    assert.equal(warm.retention_in_fixture, `${RETAINED.from} to ${RETAINED.to}`);
    assert.deepEqual(warm.extended_series, [
      `checkout-api latency_p99_ms to ${minute(21)}`,
      `checkout-api error_rate to ${minute(21)}`,
    ]);
    assert.match(warm.world_as_last_read, /1 remediation/);
  }));

test('the replay spans hold the two levels they are named for, or a recovery means nothing', () =>
  withServer(async ({ callTool }) => {
    /**
     * The fixture pinned against being softened, the same way the traps above are.
     *
     * Widen the pre-incident span to include 13:59 and it picks up the 1124ms transition minute, so
     * a recovery starts replaying a partly broken reading. Widen the settled span back to 14:00 and
     * it picks up the error rate ramping from 0.021, so a remediation that fixed nothing starts
     * looking like a slow improvement. Both were tried; both go red here.
     */
    const p99 = await seriesOf(callTool, 'latency_p99_ms', 'checkout-api', RETAINED.from, RETAINED.to);
    const errors = await seriesOf(callTool, 'error_rate', 'checkout-api', RETAINED.from, RETAINED.to);
    const within = (span, at) => at >= span.from && at <= span.to;
    const { budget_above_dependency: healthy, budget_below_dependency: settled } = METRICS.recovery.replay;

    for (const [at, value] of p99) {
      if (within(healthy, at)) assert.ok(value < 320, `${at} is in the pre-incident replay span and reads ${value}`);
      if (within(settled, at)) assert.ok(value > 1900, `${at} is in the settled replay span and reads ${value}`);
    }
    for (const [at, value] of errors) {
      if (within(healthy, at)) assert.ok(value < 0.01, `${at} is in the pre-incident replay span and reads ${value}`);
      if (within(settled, at)) assert.ok(value > 0.1, `${at} is in the settled replay span and reads ${value}`);
    }

    // Both spans have to be inside the retention, or the replay reads values this store never took.
    for (const span of [healthy, settled]) {
      assert.ok(span.from >= RETAINED.from && span.to <= RETAINED.to, `${span.from} to ${span.to} is not retained`);
    }
    assert.deepEqual(METRICS.recovery.metrics, ['latency_p99_ms', 'error_rate']);
  }));
