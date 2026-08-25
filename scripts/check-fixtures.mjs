/**
 * Asserts every fixture is still broken.
 *
 * A fixture that quietly starts passing is worse than a broken build: the demo still runs, the
 * agent finds nothing to fix, and you discover it on camera. This is the one test in the repo whose
 * success condition is a failure.
 */
import { spawnSync } from 'node:child_process';

const FIXTURES = [
  {
    name: 'ledger (python)',
    cwd: 'fixtures/ledger',
    command: ['python3', ['-m', 'unittest', 'discover', '-s', '.']],
    expect: /FAILED \(failures=1\)/,
  },
  {
    name: 'retry (javascript)',
    cwd: 'fixtures/retry',
    command: ['node', ['--test', 'test/retry.test.js']],
    expect: /# fail 1/,
  },
];

let broken = 0;

for (const fixture of FIXTURES) {
  const [bin, args] = fixture.command;
  const run = spawnSync(bin, args, { cwd: fixture.cwd, encoding: 'utf8' });

  // A missing interpreter or a wrong working directory gives status null and no output, which
  // used to read as "the fixture passes" and print a misleading cause.
  if (run.error || run.status === null) {
    console.log(`  ERROR    ${fixture.name}`);
    console.log(`           could not run \`${bin}\` in ${fixture.cwd}: ${run.error?.message ?? 'no exit status'}`);
    continue;
  }

  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const stillBroken = run.status !== 0 && fixture.expect.test(output);

  console.log(`  ${stillBroken ? 'broken ' : 'PASSING'}  ${fixture.name}`);
  if (stillBroken) {
    broken += 1;
  } else {
    console.log(`           expected ${fixture.expect}, got exit ${run.status}`);
  }
}

if (broken !== FIXTURES.length) {
  console.error('\n  A fixture is no longer broken. The demo depends on it failing - fix that before merging.\n');
  process.exit(1);
}
console.log(`\n  All ${broken} fixtures still fail as intended.\n`);
