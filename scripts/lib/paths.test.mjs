import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromModule } from './paths.mjs';

/**
 * This is a two-line function because the bug it replaces was a one-word one: `.pathname` instead
 * of `fileURLToPath`. It is worth pinning because the failure is invisible on a CI runner - the
 * checkout is at /home/runner/work, which has nothing to encode - and appears only on the machine
 * of whoever keeps their projects somewhere with a space in the name.
 */

test('a directory with a space in it resolves to a path that exists on disk', () => {
  assert.equal(
    fromModule('file:///Users/me/My%20Desk/repo/scripts/audit.mjs', '../agents/'),
    '/Users/me/My Desk/repo/agents/',
  );
});

test('non-ASCII survives too', () => {
  assert.equal(
    fromModule('file:///Users/j%C3%B8rn/repo/scripts/audit.mjs', '../agents/'),
    '/Users/jørn/repo/agents/',
  );
});

test('the ordinary case is unchanged, so nothing had to be traded for the fix', () => {
  assert.equal(fromModule('file:///srv/repo/scripts/audit.mjs', '../agents/'), '/srv/repo/agents/');
  assert.equal(fromModule('file:///srv/repo/scripts/lib/x.mjs', './y.json'), '/srv/repo/scripts/lib/y.json');
});

test('it is the decoding that matters, not the URL', () => {
  // The version this replaces returned the encoded form, which is what made readdirSync fail on a
  // directory anyone could see was there.
  const encoded = new URL('../agents/', 'file:///Users/me/My%20Desk/repo/scripts/audit.mjs').pathname;
  assert.equal(encoded, '/Users/me/My%20Desk/repo/agents/');
  assert.notEqual(fromModule('file:///Users/me/My%20Desk/repo/scripts/audit.mjs', '../agents/'), encoded);
});
