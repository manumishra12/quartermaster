import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
const INCIDENTS = JSON.parse(
  readFileSync(fileURLToPath(new URL('../ops-desk/incidents.json', import.meta.url)), 'utf8'),
);

/**
 * A server per test, on a port the OS picks.
 *
 * Fixed numbers collide with a stray server left over from a manual run, and the whole file then
 * fails with "did not report a port" - a flake that says nothing about the code under test. There
 * is no state to isolate here, unlike ops-desk, but the isolation is free and the port is not.
 */
async function startServer() {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, OBSERVABILITY_PORT: '0', OBSERVABILITY_HOST: '127.0.0.1' },
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

  return { call, callTool, port, stop: () => child.kill() };
}

async function withServer(body) {
  const server = await startServer();
  try {
    await body(server);
  } finally {
    server.stop();
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
     * The last step of an investigation, and the one a demo most wants to fake. After a rollback
     * the honest state of this store is that no reading exists past 14:20 - nothing here advances
     * a clock, because reading a graph does not make time pass. A tool that answered `change: null`
     * and nothing else would let "recovered" be written on the strength of a field nobody read.
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
    assert.match(recovery.refused[0].detail, /has not been taken yet/);
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
