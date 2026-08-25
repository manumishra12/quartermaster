import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { specFiles, validateSpec } from './spec.mjs';

test('every agent spec in the repository is valid', () => {
  const problems = specFiles().flatMap(({ name, path }) =>
    validateSpec(JSON.parse(readFileSync(path, 'utf8')), name),
  );
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('an unknown approval tag is caught, because it silently gates nothing', () => {
  const spec = {
    name: 'x',
    manifest: {
      model: { name: 'p/m' },
      instructions: 'do a thing',
      mcp_servers: [{ name: 'github', require_approval_for_tools: ['@writes'] }],
    },
  };
  assert.match(validateSpec(spec).join(), /unknown approval tag @writes/);
});

test('an empty approval policy is caught', () => {
  const spec = {
    name: 'x',
    manifest: {
      model: { name: 'p/m' },
      instructions: 'do a thing',
      mcp_servers: [{ name: 'github', require_approval_for_tools: [] }],
    },
  };
  assert.match(validateSpec(spec).join(), /runs ungated/);
});

test('skills without a sandbox are caught', () => {
  const spec = {
    name: 'x',
    manifest: { model: { name: 'p/m' }, instructions: 'x', skills: [{ name: 's' }] },
  };
  assert.match(validateSpec(spec).join(), /sandbox is not enabled/);
});

test('a spec with no model or instructions is caught', () => {
  assert.match(validateSpec({ name: 'x', manifest: {} }).join(), /missing model/);
  assert.match(validateSpec({ name: 'x', manifest: { model: { name: 'p/m' } } }).join(), /missing instructions/);
});

test('a promised approval with no gate and no admission is caught', () => {
  // The worst defect this review found: instructions saying writes "stop and ask first" while the
  // spec declared no connector at all, so nothing anywhere could pause. The validator passed it.
  const spec = {
    name: 'x',
    manifest: { model: { name: 'p/m' }, instructions: 'Anything that writes stops and asks first.' },
  };
  assert.match(validateSpec(spec).join(), /promise an approval pause/);
});

test('the same promise is fine when the spec says plainly that nothing enforces it', () => {
  const spec = {
    name: 'x',
    manifest: {
      model: { name: 'p/m' },
      instructions: 'Anything that writes stops and asks first. Nothing outside you enforces this.',
    },
  };
  assert.deepEqual(validateSpec(spec), []);
});

test('the fail-open shape SECURITY.md prescribes against is caught', () => {
  const spec = {
    name: 'x',
    manifest: {
      model: { name: 'p/m' },
      instructions: 'do a thing',
      mcp_servers: [{ name: 'linear', enable_tools: ['@all'], require_approval_for_tools: ['@write'] }],
    },
  };
  assert.match(validateSpec(spec).join(), /fail-open shape/);
});

test('an omitted approval policy is called out, not silently defaulted', () => {
  const spec = {
    name: 'x',
    manifest: { model: { name: 'p/m' }, instructions: 'do a thing', mcp_servers: [{ name: 'linear' }] },
  };
  assert.match(validateSpec(spec).join(), /no approval policy declared/);
});

test('a gate on a tool the agent cannot call is caught', () => {
  const spec = {
    name: 'x',
    manifest: {
      model: { name: 'p/m' },
      instructions: 'do a thing',
      mcp_servers: [{ name: 'gh', enable_tools: ['read_file'], require_approval_for_tools: ['create_pull_request'] }],
    },
  };
  assert.match(validateSpec(spec).join(), /gated but not enabled/);
});

test('code-runner must keep subagents disabled', () => {
  const spec = {
    name: 'code-runner',
    manifest: { model: { name: 'p/m' }, instructions: 'run it', config: { dynamic_sub_agents: { enabled: true } } },
  };
  assert.match(validateSpec(spec).join(), /dynamic_sub_agents disabled/);
});
