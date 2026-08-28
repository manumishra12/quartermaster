/**
 * Asserts every fixture still does the thing the demo depends on it doing.
 *
 * For two of them that is failing. A fixture that quietly starts passing is worse than a broken
 * build: the demo still runs, the agent finds nothing to fix, and you discover it on camera. That
 * is the one success condition in this repo that is a failure.
 *
 * The third is a reproduction rather than a broken repository, and it has to keep doing both
 * halves - fail on the deploy the incident blames, pass on the one a rollback returns to. Checking
 * only the failure would pass a fixture that fails in every configuration, which demonstrates a
 * broken script rather than a cause. So what is checked is the pair.
 */
import { spawnSync } from 'node:child_process';

const FIXTURES = [
  {
    name: 'ledger (python)',
    must: 'still fail',
    cwd: 'fixtures/ledger',
    command: ['python3', ['-m', 'unittest', 'discover', '-s', '.']],
    expect: /FAILED \(failures=1\)/,
  },
  {
    name: 'retry (javascript)',
    must: 'still fail',
    cwd: 'fixtures/retry',
    command: ['node', ['--test', 'test/retry.test.js']],
    expect: /# fail 1/,
  },
  {
    name: 'checkout-timeout (python)',
    must: 'still fail on 4c21 and pass on 9ab7',
    cwd: 'fixtures/checkout-timeout',
    command: ['python3', ['repro.py', '--both']],
    // The only fixture here that is meant to exit 0, because what it reports is the pair holding.
    status: 0,
    expect: /reproduced on 4c21, recovered on 9ab7/,
  },
];

let holding = 0;

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
  // An absent `status` means any non-zero exit, which is what "still broken" is: a fixture may
  // fail with 1 today and 2 tomorrow without anything the demo cares about having changed.
  const exited = fixture.status === undefined ? run.status !== 0 : run.status === fixture.status;
  const holds = exited && fixture.expect.test(output);

  console.log(`  ${holds ? '  ok   ' : 'CHANGED'}  ${fixture.name.padEnd(26)} ${fixture.must}`);
  if (holds) {
    holding += 1;
  } else {
    const wanted = fixture.status === undefined ? 'a non-zero exit' : `exit ${fixture.status}`;
    console.log(`           expected ${wanted} and ${fixture.expect}, got exit ${run.status}`);
  }
}

if (holding !== FIXTURES.length) {
  console.error('\n  A fixture no longer does what the demo depends on - fix that before merging.\n');
  process.exit(1);
}
console.log(`\n  All ${holding} fixtures still behave as the demo needs.\n`);
