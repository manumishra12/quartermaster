import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpProblem } from './http.mjs';

test('a successful response is not a problem', () => {
  // Both directions: a check that rejects every response audits nothing at all.
  assert.equal(httpProblem({ ok: true, status: 200 }, '/api/v1/settings/mcp-servers'), null);
  assert.equal(httpProblem({ ok: true, status: 204 }), null);
});

test('an error page is named by its status, not parsed as a tool list', () => {
  /**
   * The one that mattered: a 404 body of `{"message":"not found"}` has no `error` field, so it
   * passed the only check there was and was walked as the tools a connector publishes. Zero tools
   * looks exactly like a connector with nothing risky on it, and the audit then closed with
   * "nothing runs ungated" about a server it had never read.
   */
  assert.equal(httpProblem({ ok: false, status: 404, statusText: 'Not Found' }, '/tools'), '/tools: HTTP 404 Not Found');
  assert.equal(httpProblem({ ok: false, status: 502 }, '/tools'), '/tools: HTTP 502');
});

test('a response too broken to have a status still reports a problem', () => {
  // Anything that is not a plain success is a connector we could not audit, never one we cleared.
  assert.equal(httpProblem(null, '/tools'), '/tools: HTTP no status');
  assert.equal(httpProblem(undefined), 'HTTP no status');
});
