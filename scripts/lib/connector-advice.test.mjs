import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectorAdvice, connectorReason, isUnreachable } from './connector-advice.mjs';

/**
 * Advice that cannot work is worse than no advice: it sends someone looking for credentials for a
 * process they only needed to start. This is the tool that checks the rest of the project for
 * being confidently unhelpful, so it is the last place it can be tolerated.
 */

test('a local server that is not running is answered with the command that starts it', () => {
  const refused = "failed to connect: connect ECONNREFUSED 127.0.0.1:8795";
  assert.equal(connectorAdvice('ops-desk', refused), 'start it: npm run ops-desk');
  assert.equal(connectorAdvice('front-desk', refused), 'start it: npm run front-desk');
});

test('a remote server that is unreachable does not get a command it has no way to run', () => {
  const advice = connectorAdvice('deepwiki', 'fetch failed');
  assert.match(advice, /not reachable/);
  assert.doesNotMatch(advice, /npm run/, 'there is no local command for somebody else’s server');
});

test('an authentication failure still says to authenticate', () => {
  // The original advice was right for this case; it was only ever wrong as the answer to everything.
  assert.equal(connectorAdvice('github', 'HTTP 401 Unauthorized'), 'authenticate the connector, then re-run');
  assert.equal(connectorAdvice('linear', 'token expired'), 'authenticate the connector, then re-run');
});

test('the shapes a dead socket actually arrives in', () => {
  for (const message of [
    'connect ECONNREFUSED ::1:8796',
    'TypeError: fetch failed',
    'getaddrinfo ENOTFOUND ops-desk.local',
    'socket hang up',
    'read ECONNRESET',
  ]) {
    assert.equal(isUnreachable(message), true, message);
  }
  assert.equal(isUnreachable('HTTP 403 Forbidden'), false);
  assert.equal(isUnreachable(''), false);
  assert.equal(isUnreachable(undefined), false);
});

test('the reason is what happened; the advice is what to do about it', () => {
  // A wall of transport internals is not a reason a person can act on.
  assert.equal(connectorReason('connect ECONNREFUSED ::1:8795'), 'nothing is listening at its URL');
  // But a message that is not a dead socket is passed through rather than guessed at.
  assert.equal(connectorReason('HTTP 401 Unauthorized'), 'HTTP 401 Unauthorized');
});
