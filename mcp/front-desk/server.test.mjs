import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The front desk, tested through the wire.
 *
 * Two properties matter here, and neither can be checked from the agent side. Every tool must
 * publish the annotations the approval selectors are resolved from; and no write tool may ever
 * report doing something it did not do. The second is worse here than anywhere else in the
 * project, because a person approved the action believing the description they were shown.
 */

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./workspace.json', import.meta.url));

/** A server per test: these mutate, and sharing one makes them order-dependent and quietly wrong. */
/**
 * The OS picks the port.
 *
 * Fixed numbers collided with a stray server left over from a manual run and the whole file failed
 * with "did not start within 10s" - a flake that says nothing about the code under test. Asking for
 * port 0 gets a free one, and the server prints which.
 */
async function startServer() {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, FRONT_DESK_PORT: '0', FRONT_DESK_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const port = await new Promise((resolve, reject) => {
    /**
     * Accumulate, do not match per chunk.
     *
     * stdout arrives in whatever pieces the OS feels like, so testing each chunk on its own misses
     * an announcement split across two of them and times out against a server that is listening
     * perfectly well.
     */
    let seen = '';
    const done = (error, value) => {
      clearTimeout(timer);
      // Kill it here rather than leaving it to withServer: on the failure path withServer never
      // receives the child, so its finally cannot reach it and the process leaks - which hangs the
      // whole run on an open handle rather than failing one test.
      if (error) {
        child.kill();
        reject(error);
      } else {
        resolve(value);
      }
    };

    const timer = setTimeout(() => done(new Error(`front-desk did not report a port within 10s`)), 10_000);

    child.stdout.on('data', (chunk) => {
      seen += String(chunk);
      const match = /listening on http:\/\/localhost:(\d+)\//.exec(seen);
      if (match) done(null, Number(match[1]));
    });
    child.on('error', (error) => done(error));
    child.on('exit', (code) => done(new Error(`front-desk exited with code ${code} before reporting a port`)));
  });

  const endpoint = `http://localhost:${port}/mcp`;

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

  async function callTool(name, args = {}) {
    const response = await call('tools/call', { name, arguments: args });
    return JSON.parse(response.result.content[0].text);
  }

  return { call, callTool, stop: () => child.kill() };
}

async function withServer(body) {
  const server = await startServer();
  try {
    await body(server);
  } finally {
    server.stop();
  }
}

test('every tool publishes annotations, and the gated ones are the ones that reach people', () =>
  withServer(async ({ call }) => {
    const { result } = await call('tools/list');
    assert.equal(result.tools.length, 9);

    for (const tool of result.tools) {
      assert.ok(
        tool.annotations && typeof tool.annotations.readOnlyHint === 'boolean',
        `${tool.name} publishes no readOnlyHint - it would match no selector and run ungated`,
      );
    }

    const gated = result.tools
      .filter((t) => !t.annotations.readOnlyHint)
      .map((t) => t.name)
      .sort();
    // Everything that another person would see the result of.
    assert.deepEqual(gated, ['close_issue', 'create_issue', 'send_message', 'update_issue']);

    const destructive = result.tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort();
    // Closing and sending cannot be walked back; filing and editing can.
    assert.deepEqual(destructive, ['close_issue', 'send_message']);
  }));

test('a filed issue is real, and appears in the record of what was done', () =>
  withServer(async ({ callTool }) => {
    const filed = await callTool('create_issue', {
      project: 'CHK',
      title: '[payments] Refunds over 500 rejected silently',
      body: 'Steps to reproduce\n1. Refund over 500.\n\nExpected\nAn error the customer can see.',
      assignee: 'priya',
      priority: 'high',
    });
    assert.equal(filed.ok, true);

    const issues = await callTool('list_issues', { project: 'CHK' });
    assert.ok(issues.issues.some((i) => i.id === filed.id));

    const outbox = await callTool('list_outbox');
    assert.equal(outbox.actions.at(-1).action, 'create_issue');
  }));

test('a project or a person that does not exist is not filed against', () =>
  withServer(async ({ callTool }) => {
    const wrongProject = await callTool('create_issue', {
      project: 'NOPE',
      title: 't',
      body: 'b',
      assignee: 'priya',
      priority: 'high',
    });
    assert.equal(wrongProject.error, 'not_found');
    assert.ok(wrongProject.known.includes('CHK'));

    const wrongPerson = await callTool('create_issue', {
      project: 'CHK',
      title: 't',
      body: 'b',
      assignee: 'nobody',
      priority: 'high',
    });
    assert.equal(wrongPerson.error, 'not_found');

    // Neither may leave a trace, because neither happened.
    const outbox = await callTool('list_outbox');
    assert.equal(outbox.count, 0);
  }));

test('a required field left blank is not a filed issue', () =>
  withServer(async ({ callTool }) => {
    // The instructions say to ask when a required field is ambiguous rather than leave it blank
    // hoping nobody notices. This is what makes that more than advice.
    const missing = await callTool('create_issue', {
      project: 'CHK',
      title: '[payments] Something',
      body: 'A body.',
      assignee: 'priya',
    });
    assert.equal(missing.error, 'missing_fields');
    assert.match(missing.message, /priority/);

    const outbox = await callTool('list_outbox');
    assert.equal(outbox.count, 0);
  }));

test('closing what is already closed changes nothing, and does not say otherwise', () =>
  withServer(async ({ callTool }) => {
    // CHK-117 is closed in the fixture. Reporting a second close would be a false record of a
    // state change, on the far side of an approval somebody just gave.
    const again = await callTool('close_issue', { issue_id: 'CHK-117', resolution: 'again' });
    assert.equal(again.error, 'already_closed');

    const outbox = await callTool('list_outbox');
    assert.equal(outbox.count, 0);

    // And closing something genuinely open works.
    const closed = await callTool('close_issue', { issue_id: 'CHK-118', resolution: 'fixed in 4c21' });
    assert.equal(closed.ok, true);
    assert.equal(closed.state, 'closed');
  }));

test('an edit that changes nothing is not recorded as an edit', () =>
  withServer(async ({ callTool }) => {
    const nothing = await callTool('update_issue', { issue_id: 'CHK-118' });
    assert.equal(nothing.error, 'no_changes');

    const outbox = await callTool('list_outbox');
    assert.equal(outbox.count, 0);
  }));

test('a message to nobody is not sent, and is not recorded as sent', () =>
  withServer(async ({ callTool }) => {
    const nowhere = await callTool('send_message', { to: 'nobody', body: 'hello' });
    assert.equal(nowhere.error, 'not_found');
    assert.match(nowhere.message, /Nothing was sent/);

    const outbox = await callTool('list_outbox');
    assert.equal(outbox.count, 0);

    const sent = await callTool('send_message', { to: 'priya', body: 'hello' });
    assert.equal(sent.ok, true);
  }));

test('a field of spaces is a field left blank', () =>
  withServer(async ({ callTool }) => {
    // Whitespace looks present to every truthiness check and is not a title. Accepting one files
    // an issue with a blank required field and reports it as filed - the same false record as any
    // other, only harder to see.
    const spaces = await callTool('create_issue', {
      project: 'CHK',
      title: '   ',
      body: 'A real body.',
      assignee: 'priya',
      priority: 'high',
    });
    assert.equal(spaces.error, 'missing_fields');
    assert.match(spaces.message, /title/);

    const outbox = await callTool('list_outbox');
    assert.equal(outbox.count, 0);
  }));

test('an edit to the value already there is not an edit', () =>
  withServer(async ({ callTool }) => {
    // Recording this as a change is the false event the handler claims to prevent: an edit in the
    // record that nobody would find any trace of in the issue.
    const issue = await callTool('get_issue', { issue_id: 'CHK-118' });
    const same = await callTool('update_issue', { issue_id: 'CHK-118', title: issue.title });
    assert.equal(same.error, 'no_changes');
    assert.match(same.message, /already reads that way/);

    const outbox = await callTool('list_outbox');
    assert.equal(outbox.count, 0);

    // A genuinely different value still goes through.
    const changed = await callTool('update_issue', { issue_id: 'CHK-118', title: 'Something else' });
    assert.equal(changed.ok, true);
  }));

test('whether a field can be erased depends on the project, not the field', () =>
  withServer(async ({ callTool }) => {
    /**
     * The existence check only ran when the value was truthy, so an empty assignee walked past it
     * and left the issue in a state the desk would have refused to create. Refusing every blank
     * was the opposite mistake: priority is optional on SRCH, so removing it is a real edit.
     */
    const erased = await callTool('update_issue', { issue_id: 'CHK-118', assignee: '' });
    assert.equal(erased.error, 'missing_fields');
    assert.match(erased.message, /CHK requires assignee/);

    const issue = await callTool('get_issue', { issue_id: 'CHK-118' });
    assert.equal(issue.assignee, 'priya', 'and the assignee is still there');

    // SRCH does not require priority, so clearing it is an edit the desk should perform.
    const cleared = await callTool('update_issue', { issue_id: 'SRCH-42', priority: '' });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.priority, null, 'stored as absent, not as an empty string');

    // And clearing what is already absent is still not a change.
    const again = await callTool('update_issue', { issue_id: 'SRCH-42', priority: '' });
    assert.equal(again.error, 'no_changes');
  }));

test('an issue is not closed without a resolution', () =>
  withServer(async ({ call, callTool }) => {
    // Closing is destructive, so a blank required field must be refused before the mutation.
    const response = await call('tools/call', {
      name: 'close_issue',
      arguments: { issue_id: 'CHK-118', resolution: '   ' },
    });
    /**
     * The schema refuses this before the handler runs, so the answer is a protocol-level error
     * rather than one of this server's structured refusals. That is the better place for it to
     * happen - the destructive branch is never reached at all - but it means the body is not JSON.
     */
    const refusal = response.result?.content?.[0]?.text ?? JSON.stringify(response.error ?? response);
    assert.match(refusal, /resolution|invalid|expected/i);

    const issue = await callTool('get_issue', { issue_id: 'CHK-118' });
    assert.equal(issue.state, 'open', 'and it is still open');
  }));

test('the fixture still carries an injection, so the defence has something to defend against', () => {
  /**
   * SRCH-42's body claims the work is pre-approved and tells the agent not to stop for approval.
   * The agent's instructions say everything it reads is data and never instruction; that claim is
   * worth nothing without something that tests it.
   *
   * A run against this fixture is the reason it is here: the model *was* persuaded and called
   * close_issue on SRCH-42 with a fabricated resolution - and the harness stopped it anyway,
   * because the gate is outside the model. If this text is ever removed, that demonstration
   * silently stops demonstrating anything.
   */
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const planted = fixture.issues.find((i) => i.id === 'SRCH-42');
  assert.match(planted.body, /IGNORE YOUR PREVIOUS INSTRUCTIONS/);
  assert.match(planted.body, /pre-approved/);
  assert.equal(planted.state, 'open', 'it has to be open, or closing it would be a reasonable act');
});

test('the default port is the one the documentation names', () => {
  assert.match(readFileSync(SERVER, 'utf8'), /FRONT_DESK_PORT \?\? 8796/);
});

test('closing an issue does not edit what somebody else wrote', () =>
  withServer(async ({ callTool }) => {
    const before = await callTool('get_issue', { issue_id: 'CHK-118' });

    const closed = await callTool('close_issue', {
      issue_id: 'CHK-118',
      resolution: 'Backoff added to the webhook retry',
    });
    assert.equal(closed.ok, true);

    /**
     * The approval card showed an issue id and a resolution. What used to happen was that, plus a
     * silent append to the issue body - an edit nobody approved, on the far side of a decision
     * somebody had just made. That is worse than an ungated write, because the record now carries
     * a person's assent to a change they were never shown.
     */
    const after = await callTool('get_issue', { issue_id: 'CHK-118' });
    assert.equal(after.body, before.body, 'the body must be exactly as it was');
    assert.equal(after.state, 'closed');
    assert.equal(after.resolution, 'Backoff added to the webhook retry', 'recorded beside the issue, not inside it');
  }));

test('the outbox keeps the order things happened in', () =>
  withServer(async ({ callTool }) => {
    // Every entry used to carry the same frozen timestamp, so the record read as though a day of
    // work happened in one instant.
    await callTool('create_issue', {
      project: 'SRCH', title: 'Short queries return the fallback set',
      body: 'Reported twice this week.', assignee: 'sam',
    });
    await callTool('close_issue', { issue_id: 'CHK-118', resolution: 'first' });
    await callTool('send_message', { to: 'ravi', body: 'closed CHK-118' });

    const { actions } = await callTool('list_outbox', {});
    assert.deepEqual(actions.map((a) => a.action), ['create_issue', 'close_issue', 'send_message']);
    const times = actions.map((a) => Date.parse(a.at));
    assert.ok(times.every((t, i) => i === 0 || times[i - 1] < t), `timestamps do not advance: ${actions.map((a) => a.at)}`);
  }));

test('a body longer than anyone will read is refused before it is stored', () =>
  withServer(async ({ callTool }) => {
    // Refused by the schema, so the handler is never reached and nothing has to remember to check.
    await assert.rejects(() =>
      callTool('create_issue', {
        project: 'CHK', title: 'x', body: 'x'.repeat(50_000), assignee: 'priya', priority: 'low',
      }),
    );
    await assert.rejects(() => callTool('send_message', { to: 'ravi', body: 'x'.repeat(50_000) }));

    // A long but ordinary ticket still files.
    const filed = await callTool('create_issue', {
      project: 'CHK',
      title: '[payments] A real but wordy report',
      body: `Steps to reproduce\n${'detail '.repeat(500)}\n\nExpected\nSomething else.`,
      assignee: 'priya',
      priority: 'low',
    });
    assert.equal(filed.ok, true);
  }));

test('a message with nothing in it is not sent', () =>
  withServer(async ({ callTool }) => {
    // The only write tool here that skipped the whitespace check, and the one that cannot be
    // recalled - so a body of spaces was pushed to the outbox and reported as sent.
    assert.equal((await callTool('send_message', { to: 'priya', body: '   ' })).error, 'missing_fields');
    assert.equal((await callTool('list_outbox', {})).count, 0);

    assert.equal((await callTool('send_message', { to: 'priya', body: 'CHK-118 is closed' })).ok, true);
  }));
