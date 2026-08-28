import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeConnectorFailure, isUnreachable } from './connector-advice.mjs';

const OPS = 'http://localhost:8795/mcp';
const DESK = 'http://localhost:8796/mcp';
const WAREHOUSE = 'http://localhost:8797/mcp';

/**
 * Advice that cannot work is worse than no advice: it sends someone looking for credentials for a
 * process they only needed to start, or to restart a server that is already running and answering.
 * This is the tool that checks the rest of the project for being confidently unhelpful, so it is
 * the last place it can be tolerated.
 */

test('a refused connection is the only thing that means nothing is listening', () => {
  const refused = describeConnectorFailure('ops-desk', 'connect ECONNREFUSED 127.0.0.1:8795', OPS);
  assert.equal(refused.cause, 'refused');
  assert.equal(refused.reason, 'nothing is listening at its URL');
  assert.equal(refused.advice, 'start it: npm run ops-desk');

  // Every local server this repo ships has to be in the table, or the advice for the newest one
  // is the generic sentence about credentials it does not have.
  const warehouse = describeConnectorFailure('warehouse', 'connect ECONNREFUSED 127.0.0.1:8797', WAREHOUSE);
  assert.equal(warehouse.advice, 'start it: npm run warehouse');
});

test('a remote server that refuses does not get a command it has no way to run', () => {
  const advice = describeConnectorFailure('deepwiki', 'connect ECONNREFUSED 1.2.3.4:443', 'https://mcp.deepwiki.com/mcp').advice;
  assert.doesNotMatch(advice, /npm run/, 'there is no local command for somebody else’s server');
});

test('the causes that are not a refused connection keep their message and their own advice', () => {
  const cases = [
    ['getaddrinfo ENOTFOUND ops.example', 'dns', /host name does not resolve/],
    ['connect ETIMEDOUT 10.0.0.1:443', 'unreachable', /did not answer in time/],
    ['read ECONNRESET', 'reset', /closed before it answered/],
    ['unable to verify the first certificate', 'tls', /certificate was rejected/],
  ];

  for (const [message, cause, reason] of cases) {
    const result = describeConnectorFailure('ops-desk', message, OPS);
    assert.equal(result.cause, cause, message);
    assert.match(result.reason, reason);
    // The typed cause is what somebody diagnoses from; it must survive.
    assert.match(result.reason, new RegExp(message.split(' ').at(-1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(result.advice, /^start it:/, `${cause} must not be answered with "start it"`);
  }
});

test('a reset against a local server points at its output, not at starting it again', () => {
  // Something is listening. Telling the operator to start it is the mistake this test exists for.
  const reset = describeConnectorFailure('front-desk', 'socket hang up', DESK);
  assert.match(reset.advice, /check the output of npm run front-desk/);
});

test('an authentication failure still says to authenticate', () => {
  // The original advice was right for this case; it was only ever wrong as the answer to everything.
  assert.equal(describeConnectorFailure('github', 'HTTP 401 Unauthorized').advice, 'authenticate the connector, then re-run');
  assert.equal(describeConnectorFailure('linear', 'api-key rejected').advice, 'authenticate the connector, then re-run');
});

test('a cause it cannot recognise says so instead of guessing', () => {
  /**
   * A bare "fetch failed" genuinely could be several things. Claiming to know which is how the
   * first version of this got it wrong, so it keeps the message and suggests both checks.
   */
  const vague = describeConnectorFailure('ops-desk', 'TypeError: fetch failed', OPS);
  assert.equal(vague.cause, 'unknown');
  assert.match(vague.reason, /fetch failed/);
  assert.match(vague.advice, /check that it is running/);
  assert.match(vague.advice, /reachable/);
});

test('an empty message does not produce an empty reason', () => {
  assert.equal(describeConnectorFailure('ops-desk', '', OPS).reason, 'it failed without saying why');
  assert.equal(describeConnectorFailure('ops-desk', undefined, OPS).reason, 'it failed without saying why');
});

test('isUnreachable means the port is empty, not that something went wrong', () => {
  assert.equal(isUnreachable('connect ECONNREFUSED ::1:8796'), true);
  // These are all failures, and none of them means nothing is listening.
  for (const message of ['getaddrinfo ENOTFOUND x', 'socket hang up', 'connect ETIMEDOUT 1.2.3.4:443', 'TypeError: fetch failed']) {
    assert.equal(isUnreachable(message), false, message);
  }
});

test('a connector that only shares the name is not offered the local command', () => {
  /**
   * A connector called ops-desk could be a deployment of this server on somebody else's host.
   * `npm run ops-desk` would start an unrelated process on the default port while the configured
   * one stayed exactly as unreachable - advice that looks like it worked and did not.
   */
  const remote = describeConnectorFailure('ops-desk', 'connect ECONNREFUSED 10.0.0.4:8795', 'https://ops.example.com/mcp');
  assert.doesNotMatch(remote.advice, /npm run/);

  // And with no URL to check, it does not claim to know how to start anything.
  assert.doesNotMatch(describeConnectorFailure('ops-desk', 'connect ECONNREFUSED 127.0.0.1:8795').advice, /npm run/);
  assert.doesNotMatch(describeConnectorFailure('ops-desk', 'ECONNREFUSED', 'not a url').advice, /npm run/);
});

test('a local server on a different port is told to start on that port', () => {
  // Offering the bare command here starts it on 8795 while the connector points at 9100.
  const moved = describeConnectorFailure('ops-desk', 'connect ECONNREFUSED 127.0.0.1:9100', 'http://127.0.0.1:9100/mcp');
  assert.equal(moved.advice, 'start it: OPS_DESK_PORT=9100 npm run ops-desk');

  // The default port needs no such prefix.
  assert.equal(describeConnectorFailure('ops-desk', 'ECONNREFUSED', OPS).advice, 'start it: npm run ops-desk');
});
