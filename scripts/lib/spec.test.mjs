import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
      // Stated because every spec has to state these, not because this test is about any of them.
      config: { sandbox: { enabled: true }, dynamic_sub_agents: { enabled: false }, iteration_limit: 24 },
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

test('a spec cannot get its sandbox policy by omission', () => {
  /**
   * There is no shared safety block to derive from - specs are plain JSON with no include
   * mechanism, and inventing one would put a build step between a reviewer and the policy they
   * are reading. The alternative to a shared block is not silent divergence: it is that
   * divergence fails a check.
   */
  const problems = validateSpec({ name: 'x', manifest: { config: {} } });
  assert.ok(problems.some((p) => /sandbox\.enabled must be stated explicitly/.test(p.message ?? p)));
});

test('an agent with no sandbox may not carry things that need one', () => {
  const withDownloads = validateSpec({
    name: 'x',
    manifest: { config: { sandbox: { enabled: false, file_downloads: true } } },
  });
  assert.ok(withDownloads.some((p) => /one of the two is wrong/.test(p.message ?? p)));

  const withSubagents = validateSpec({
    name: 'x',
    manifest: { config: { sandbox: { enabled: false }, dynamic_sub_agents: { enabled: true } } },
  });
  assert.ok(withSubagents.some((p) => /nowhere safe to run/.test(p.message ?? p)));
});

/** A spec that is sound apart from whatever a test is deliberately breaking. */
const sound = (over = {}) => ({
  name: 'x',
  manifest: {
    model: { name: 'p/m' },
    instructions: 'do a thing',
    config: {
      sandbox: { enabled: true },
      dynamic_sub_agents: { enabled: false },
      iteration_limit: 24,
      ...(over.config ?? {}),
    },
    ...(over.manifest ?? {}),
  },
});

test('subagents left unstated are caught, because the default is on', () => {
  // The direction of the default is what makes this worth a rule of its own. An unstated sandbox
  // is nothing until someone states it; unstated subagents are enabled.
  const spec = sound();
  delete spec.manifest.config.dynamic_sub_agents;
  assert.match(validateSpec(spec).join(), /dynamic_sub_agents\.enabled must be stated/);

  // Stated either way is fine. The rule is about the omission, not about the answer.
  for (const enabled of [true, false]) {
    const stated = sound({ config: { dynamic_sub_agents: { enabled } } });
    assert.doesNotMatch(validateSpec(stated).join(), /dynamic_sub_agents/);
  }
});

test('a config key the harness never reads is caught', () => {
  // One underscore short of the real key. It applies cleanly, reads as a policy, and is not one.
  const spec = sound({ config: { dynamic_subagents: { enabled: false } } });
  assert.match(validateSpec(spec).join(), /dynamic_subagents is not a key TrueForge reads/);

  // And the keys it does read raise nothing.
  const real = sound({ config: { ask_user_questions: { enabled: true }, context_management: {}, generative_ui: {} } });
  assert.doesNotMatch(validateSpec(real).join(), /not a key TrueForge reads/);
});

test('a manifest key the harness never reads is caught', () => {
  assert.match(validateSpec(sound({ manifest: { tools: [] } })).join(), /manifest\.tools is not a key/);
});

test('an iteration limit outside the documented range is caught', () => {
  assert.match(validateSpec(sound({ config: { iteration_limit: 0 } })).join(), /whole number from 1 to 1024/);
  assert.match(validateSpec(sound({ config: { iteration_limit: 2048 } })).join(), /whole number from 1 to 1024/);
  assert.match(validateSpec(sound({ config: { iteration_limit: 12.5 } })).join(), /whole number from 1 to 1024/);

  const missing = sound();
  delete missing.manifest.config.iteration_limit;
  assert.match(validateSpec(missing).join(), /defaults to 100/);

  assert.doesNotMatch(validateSpec(sound({ config: { iteration_limit: 1024 } })).join(), /iteration_limit/);
});

test('@all beside named tools is caught, because the names restrict nothing', () => {
  const spec = sound({
    manifest: { mcp_servers: [{ name: 'g', enable_tools: ['@all', 'read_file'], require_approval_for_tools: ['@write'] }] },
  });
  assert.match(validateSpec(spec).join(), /@all alongside read_file/);
});

test('a selector listed twice is caught', () => {
  const spec = sound({
    manifest: {
      mcp_servers: [{ name: 'g', enable_tools: ['push', 'push'], require_approval_for_tools: ['push', 'push'] }],
    },
  });
  const said = validateSpec(spec).join('\n');
  assert.match(said, /enable_tools lists push twice/);
  assert.match(said, /require_approval_for_tools lists push twice/);
});

test('preload: false is caught, because deferred loading is broken on this harness', () => {
  const spec = sound({
    manifest: { mcp_servers: [{ name: 'g', enable_tools: ['@read-only'], require_approval_for_tools: ['@write'], preload: false }] },
  });
  assert.match(validateSpec(spec).join(), /preload: false resolves to a missing-server error/);

  const on = sound({
    manifest: { mcp_servers: [{ name: 'g', enable_tools: ['@read-only'], require_approval_for_tools: ['@write'], preload: true }] },
  });
  assert.doesNotMatch(validateSpec(on).join(), /preload/);
});

test('an instruction promising a spilled tool result needs the setting that spills it', () => {
  /**
   * The same shape as the approval promise-versus-policy rule, found in a second place by review.
   * A spec told the model that an oversized result "has been saved to a path" and to read it from
   * the sandbox, without enabling the setting that writes it - so on the largest results, which is
   * exactly when it matters, the model was sent to read a path that does not exist.
   */
  const promising = sound({
    manifest: {
      instructions: 'When a result is too large and has been saved to a path, read the file with the sandbox shell.',
    },
  });
  assert.match(validateSpec(promising).join(), /large_tool_response\.enabled is not true/);

  // Enabled, and the promise is kept.
  const enabled = sound({
    config: { context_management: { large_tool_response: { enabled: true } } },
    manifest: {
      instructions: 'When a result is too large and has been saved to a path, read the file with the sandbox shell.',
    },
  });
  assert.doesNotMatch(validateSpec(enabled).join(), /large_tool_response/);

  // And a spec that promises nothing is not asked for the setting.
  assert.doesNotMatch(validateSpec(sound()).join(), /large_tool_response/);
});

test('the documented test counts are the counts', () => {
  /**
   * TESTING.md carried per-file numbers typed by hand, and by the time a review checked them the
   * page was describing a suite that does not exist: 276 in the diagram against 326 actual, three
   * files missing entirely, and two lines of the same document disagreeing about the UI.
   *
   * This repository's own serve.mjs calls a hand-written count "a small lie of exactly the kind
   * this project spends the rest of its time refusing". A page nothing generates is exactly that,
   * so the page is now checked against the files it describes.
   */
  const testing = readFileSync(fileURLToPath(new URL('../../TESTING.md', import.meta.url)), 'utf8');

  const claimed = [...testing.matchAll(/([\w-]+)\.test\.mjs<br\/>(\d+)/g)].map(([, name, n]) => [name, Number(n)]);
  assert.ok(claimed.length >= 18, `expected the diagram to list the suites, found ${claimed.length}`);

  const total = Number(/(\d+) tests in the root suite/.exec(testing)?.[1]);
  const summed = claimed.reduce((n, [, count]) => n + count, 0);
  assert.equal(
    summed,
    total,
    `the diagram lists ${summed} tests and the page claims ${total}. Whichever is wrong, they cannot both stand.`,
  );

  // And every suite file has to appear, so a new one cannot be quietly left out of the picture.
  const files = [
    ...readdirSync(fileURLToPath(new URL('.', import.meta.url))),
  ].filter((f) => f.endsWith('.test.mjs')).map((f) => f.replace('.test.mjs', ''));
  const named = new Set(claimed.map(([name]) => name));
  const missing = files.filter((f) => !named.has(f));
  assert.deepEqual(missing, [], `these suites exist and TESTING.md does not mention them: ${missing.join(', ')}`);
});

test('the UI build and its test runner resolve the same shared modules', () => {
  /**
   * Two alias maps, in vite.config.ts and vitest.config.ts, and nothing held them together. They
   * drifted the moment a third shared module was added: the build resolved `@report` and the test
   * runner did not, so the suite failed on an import that works in the browser.
   *
   * The failure mode that matters is the other direction. An alias present in the test config and
   * absent from the build passes every test and ships a page that cannot load - and the shared
   * modules are the evidence rules, which is the worst thing here to have two of.
   */
  const read = (file) => {
    const source = readFileSync(fileURLToPath(new URL(`../../ui/${file}`, import.meta.url)), 'utf8');
    return [...source.matchAll(/'(@[\w-]+)':\s*fileURLToPath\(new URL\('([^']+)'/g)]
      .map(([, alias, target]) => `${alias} -> ${target}`)
      .sort();
  };

  assert.deepEqual(
    read('vite.config.ts'),
    read('vitest.config.ts'),
    'vite.config.ts and vitest.config.ts must alias the same shared modules to the same files',
  );
});

test('a skill that teaches a disabled surface is caught', () => {
  /**
   * Found by tabulating every agent's config side by side, which is the only way this was ever
   * going to show up: each spec reads fine on its own. `code-reviewer` carried `evidence-report` -
   * which teaches an agent to render its verdict as a Generative UI card - with generative_ui off.
   * The fetch succeeds, the model reads the pack, and the components it is told to emit go nowhere.
   */
  const taught = sound({
    manifest: { skills: [{ name: 'evidence-report' }, { name: 'untrusted-input' }] },
  });
  assert.match(validateSpec(taught).join(), /generative_ui\.enabled is not true/);

  const enabled = sound({
    config: { generative_ui: { enabled: true } },
    manifest: { skills: [{ name: 'evidence-report' }, { name: 'untrusted-input' }] },
  });
  assert.doesNotMatch(validateSpec(enabled).join(), /generative_ui/);

  // And an agent that does not carry the skill is not asked for the surface.
  assert.doesNotMatch(validateSpec(sound()).join(), /generative_ui/);
});

test('the dev server does not hand the harness to the network', () => {
  /**
   * `host: true` binds every interface, and the dev server proxies /api straight to the harness
   * with no authentication anywhere on the path. Verified from this machine's LAN address before
   * the fix: the whole interface at 200, every agent spec at 200.
   *
   * The reading was not the problem. The interface renders the approval prompt, and Allow POSTs
   * back through the same proxy - so anybody on the same wifi was a person at a terminal as far as
   * the gate could tell. The MCP servers were hardened against exactly this while the surface that
   * reaches them through the harness stayed open.
   *
   * Checked in the config rather than over a socket, because a test that needs a running dev
   * server to prove a security property is a test that gets skipped.
   */
  const source = readFileSync(fileURLToPath(new URL('../../ui/vite.config.ts', import.meta.url)), 'utf8');
  /**
   * Comments stripped first. The comment beside the setting explains why `host: true` was wrong,
   * and a check that reads prose as configuration fails on the explanation for the fix - which is
   * the same mistake the evidence verifier makes when it reads a quoted command as a command.
   */
  const config = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  assert.doesNotMatch(config, /host:\s*true/, 'host: true binds every interface, and /api proxies to the harness');
  assert.doesNotMatch(config, /host:\s*['"]0\.0\.0\.0['"]/, 'same thing, spelled out');
  assert.match(config, /host:\s*['"]127\.0\.0\.1['"]/, 'the dev server must name loopback explicitly');
});

test('the server tests connect to the address the server binds', () => {
  /**
   * The servers bind 127.0.0.1 and the banner prints "localhost", because that is the URL every
   * README and the connector registration use. The tests connected to that name, which asks the
   * resolver - and on a host where localhost is ::1 first, which is most Linux CI, that is a
   * different address with nothing listening.
   *
   * The suite runs in six seconds here and hung for fourteen minutes there. Verified directly:
   * against a server bound to 127.0.0.1, `127.0.0.1` answers 200 and `[::1]` is ECONNREFUSED.
   */
  for (const file of ['mcp/ops-desk/server.test.mjs', 'mcp/front-desk/server.test.mjs']) {
    const source = readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(
      code,
      /fetch\(`?http:\/\/localhost:/,
      `${file} connects to a name; bind and connect must agree on the address`,
    );
  }
});
