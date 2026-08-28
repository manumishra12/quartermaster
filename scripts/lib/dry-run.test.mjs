import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromModule } from './paths.mjs';
import { plan, renderPlan } from './dry-run.mjs';

const SOURCE = readFileSync(fromModule(import.meta.url, './dry-run.mjs'), 'utf8');

test('there is no execution path in the module at all', () => {
  /**
   * The property, not an accident of the current implementation. A dry run that *can* run is not a
   * dry run, and a guarded execution path is one refactor away from being an unguarded one. The
   * only version of this claim worth making is that the capability is absent: nothing imported here
   * can reach a filesystem, a process or a network, and nothing here dispatches.
   *
   * This reads the file rather than the exports because the danger is a line somebody adds later,
   * in a branch no test happens to cover.
   */
  const forbidden = [
    /from\s+'node:fs'/,
    /from\s+'node:child_process'/,
    /from\s+'node:http/,
    /from\s+'node:net'/,
    /from\s+'node:worker_threads'/,
    /\bfetch\s*\(/,
    /\bimport\s*\(/,
    /\brequire\s*\(/,
    /\beval\s*\(/,
    /\bnew\s+Function\b/,
    /\bprocess\.(exit|kill)\b/,
    /\bexecSync\b|\bspawnSync\b|\bspawn\b|\bexecFile\b/,
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(SOURCE), `dry-run.mjs contains something that can execute: ${pattern}`);
  }

  // And what it does import is one module that only formats text.
  const imports = [...SOURCE.matchAll(/^import .* from '(.+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./describe-call.mjs']);
});

test('the plan says what the call means, not what it contains', () => {
  /**
   * "rollback_deploy({deployment_id: '4c21'})" shows an operator everything and tells them nothing.
   * They are approving "roll back checkout from v2.4.1 to v2.4.0" whether or not anybody put that
   * sentence on the screen, so the sentence is the thing being consented to.
   */
  const planned = plan({ tool: 'rollback_deploy', args: '{"service":"checkout","to":"v2.4.0"}', before: 'v2.4.1' });
  assert.equal(planned.sentence, 'would roll back checkout from v2.4.1 to v2.4.0.');
  assert.equal(planned.target, 'checkout');
  assert.equal(planned.from, 'v2.4.1');
  assert.equal(planned.to, 'v2.4.0');
  assert.deepEqual(planned.unknown, []);
});

test('an unknown current value is said out loud rather than written around', () => {
  /**
   * "would set the version to v2.4.0" reads like a change and is not one - it names a destination
   * and hides the fact that nobody here knows what it moves away from. A guessed "from" would be
   * worse still: a sentence that reads as verified and is fiction.
   */
  const planned = plan({ tool: 'rollback_deploy', args: { service: 'checkout', to: 'v2.4.0' } });
  assert.equal(planned.sentence, 'would roll back checkout to v2.4.0.');
  assert.equal(planned.from, null);
  assert.ok(planned.unknown.some((u) => /stated as a destination and not as a change/.test(u)));
});

test('one argument is not read as both the thing and the destination', () => {
  // Without this, `send_email({to: 'ops@example.com'})` renders as "would send ops@example.com to
  // ops@example.com" - a sentence that says something untrue about a call somebody is approving.
  const planned = plan({ tool: 'send_email', args: { to: 'ops@example.com', subject: 'checkout' } });
  assert.equal(planned.sentence, 'would send ops@example.com.');
});

test('an unfamiliar tool is described as unfamiliar', () => {
  /**
   * A confident sentence about a tool nothing here recognises is exactly what gets waved through,
   * because it reads like every sentence that was checked. Saying so is the honest version.
   */
  const planned = plan({ tool: 'quiesce_shard', args: { id: '7' } });
  assert.equal(planned.sentence, 'would call quiesce_shard on 7.');
  assert.ok(planned.unknown.some((u) => /nothing here knows what quiesce_shard does/.test(u)));
});

test('what would be checked afterwards is part of the plan', () => {
  /**
   * An approval given without knowing how it will be verified is an approval given on trust. The
   * third part of the sentence is the one that is usually missing.
   */
  assert.deepEqual(plan({ tool: 'restart_service', args: { service: 'checkout' } }).checks, [
    'that checkout came back up',
    'the error rate for checkout after it did',
  ]);
  // The caller may know better than the derivation, and gets to say so.
  assert.deepEqual(plan({ tool: 'restart_service', args: { service: 'x' }, checks: ['the pager'] }).checks, ['the pager']);
});

test('a check nothing here can perform is admitted rather than invented', () => {
  /**
   * Naming a check is a promise that somebody can go and perform it. Nothing on this side
   * establishes that an email arrived, and a made-up check for it is worse than none - it retires
   * the question without answering it.
   */
  const planned = plan({ tool: 'send_email', args: { to: 'ops@example.com' } });
  assert.match(planned.checks.join(' '), /nothing on this side can establish that it arrived/);

  // A tool with no derivable check says the gap exists, rather than leaving an empty list.
  const unknownTool = plan({ tool: 'quiesce_shard', args: { id: '7' } });
  assert.deepEqual(unknownTool.checks, []);
  assert.ok(unknownTool.unknown.some((u) => /nothing here knows what would confirm this worked/.test(u)));
});

test('a call with nothing naming its target says so', () => {
  // The alternative is a sentence with a hole in it that reads as complete.
  const planned = plan({ tool: 'purge_cache', args: {} });
  assert.equal(planned.target, null);
  assert.ok(planned.unknown.some((u) => /no argument names what this acts on/.test(u)));
});

test('the full arguments are still shown underneath, unsummarised', () => {
  // The sentence is a reading of the call, not a replacement for it. Dropping the arguments would
  // give up the one guarantee describe-call.mjs exists to make.
  const planned = plan({ tool: 'create_or_update_file', args: { path: 'src/a.js', content: 'line one\nline two' } });
  const text = planned.arguments.join('\n');
  assert.match(text, /tool: create_or_update_file/);
  assert.match(text, /line two/, 'the body itself, not its first line');
});

test('the render says that nothing has happened', () => {
  /**
   * The half a tidier rendering drops, and the half that makes this a dry run rather than a log.
   * A plan that looks like a receipt is the failure mode - somebody scrolls past it and believes
   * the rollback is done.
   */
  const text = renderPlan(plan({ tool: 'rollback_deploy', args: { service: 'checkout', to: 'v2.4.0' } })).join('\n');
  assert.match(text, /Nothing above has happened/);
  assert.match(text, /WOULD DO/);
  assert.match(text, /Afterwards, to know it worked/);
  assert.match(text, /Not known here/);
});

test('the plan itself records that it did not execute', () => {
  // Said in the structure as well as in the render, so a caller that only reads the object cannot
  // present a plan as though something had been done.
  assert.equal(plan({ tool: 'rollback_deploy', args: {} }).executed, false);
  assert.deepEqual(renderPlan(null), []);
});

test('the render escapes what it prints', () => {
  /**
   * Every value here is argument-controlled. A service name carrying a terminal escape could clear
   * the screen or overwrite the line above it, which in this file means rewriting the sentence the
   * operator is deciding on. The approval display already fixed this; the same function fixes it
   * here rather than a second copy that can drift from it.
   */
  const planned = plan({ tool: 'restart_service', args: { service: `checkout${String.fromCharCode(27)}[2K` } });
  const text = renderPlan(planned).join('\n');
  assert.ok(!text.includes(String.fromCharCode(27)));
  assert.match(text, /\\x1b/);
});

test('arguments that will not parse do not take the plan down', () => {
  // The gate reaches this with whatever text the model emitted, and a throw here would remove the
  // display from exactly the call that is hardest to read.
  const planned = plan({ tool: 'rollback_deploy', args: '{not json' });
  assert.equal(planned.target, null);
  assert.match(planned.arguments.join('\n'), /arguments \(unparsed\)/);
});
