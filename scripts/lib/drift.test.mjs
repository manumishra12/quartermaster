import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driftBetween } from './drift.mjs';

const spec = (over = {}) => ({
  manifest: {
    model: { name: 'ollama/qwen3-4b' },
    mcp_servers: [{ name: 'ops-desk', enable_tools: ['read_logs'], require_approval_for_tools: ['rollback_deploy'] }],
    skills: [{ name: 'incident-triage' }],
    config: { sandbox: { enabled: true }, dynamic_sub_agents: { enabled: true } },
    ...over,
  },
});

test('a spec that matches what is running reports nothing', () => {
  assert.deepEqual(driftBetween(spec(), spec()), []);
});

test('a model applied from a different environment is named', () => {
  /**
   * Exactly what happened: applying once with a different TRUEFORGE_MODEL left all nine agents on a
   * provider whose quota was exhausted, while .env and every document went on describing the local
   * model. Nothing was broken on either side. The pair disagreed.
   */
  const found = driftBetween(spec({ model: { name: 'google-gemini/gemini-3-6-flash' } }), spec());
  assert.equal(found.length, 1);
  assert.match(found[0], /repository says ollama\/qwen3-4b, the harness is running google-gemini/);
});

test('a connector the harness has and the repository does not is drift in that direction too', () => {
  const applied = spec({ mcp_servers: [...spec().manifest.mcp_servers, { name: 'github' }] });
  assert.match(driftBetween(applied, spec())[0], /harness has github and the repository does not/);
});

test('a wider enable list on the harness is found, which a name-only comparison would miss', () => {
  /**
   * The connector is present on both sides and its name matches. What differs is how much of it the
   * agent can reach, which is the whole of the fail-closed argument.
   */
  const applied = spec({ mcp_servers: [{ name: 'ops-desk', enable_tools: ['read_logs', 'rollback_deploy'], require_approval_for_tools: ['rollback_deploy'] }] });
  const found = driftBetween(applied, spec());
  assert.equal(found.length, 1);
  assert.match(found[0], /ops-desk enable_tools.*harness has rollback_deploy/);
});

test('an approval dropped in the harness is drift, and is the one worth waking up for', () => {
  const applied = spec({ mcp_servers: [{ name: 'ops-desk', enable_tools: ['read_logs'], require_approval_for_tools: [] }] });
  assert.match(driftBetween(applied, spec())[0], /require_approval_for_tools.*repository has rollback_deploy/);
});

test('the harness defaults are filled in on both sides before comparing', () => {
  /**
   * An omitted enable list means @all and an omitted approval list means @write and @destructive.
   * Comparing an omission against the default it stands for would report drift on every agent that
   * relies on a default, which is the fastest way to teach somebody to ignore the check.
   */
  const bare = spec({ mcp_servers: [{ name: 'ops-desk' }] });
  const explicit = spec({ mcp_servers: [{ name: 'ops-desk', enable_tools: ['@all'], require_approval_for_tools: ['@write', '@destructive'] }] });
  assert.deepEqual(driftBetween(bare, explicit), []);
});

test('sandbox and subagents are compared, and an omitted subagent setting counts as enabled', () => {
  const off = spec({ config: { sandbox: { enabled: false }, dynamic_sub_agents: { enabled: true } } });
  assert.match(driftBetween(off, spec())[0], /sandbox: the repository says true, the harness has false/);
  const silent = spec({ config: { sandbox: { enabled: true } } });
  assert.deepEqual(driftBetween(silent, spec()), []);
});

test('skills that differ are named in the direction they differ', () => {
  const applied = spec({ skills: [{ name: 'incident-triage' }, { name: 'handing-off' }] });
  assert.match(driftBetween(applied, spec())[0], /skills.*harness has handing-off/);
});
