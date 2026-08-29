import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announcedArtifacts, artifactName } from './artifacts.mjs';

test('only the block the harness defines announces a file', () => {
  /**
   * The contract is a fenced `sandbox_artifacts` block, which the SDK's own markdown dispatches on.
   * Prose that mentions a path is not an announcement - an agent describing where it would have
   * written something must not cause a download attempt for a file that does not exist.
   */
  const announced = announcedArtifacts(
    'Here it is.\n\n```sandbox_artifacts\n/work/reports/may.md\n- /work/reports/chart.md\n```\n\nDone.',
  );
  assert.deepEqual(announced, ['/work/reports/may.md', '/work/reports/chart.md']);

  for (const prose of [
    'I wrote /work/reports/may.md for you.',
    '```bash\ncat /work/reports/may.md\n```',
    '',
    null,
  ]) {
    assert.deepEqual(announcedArtifacts(prose), [], JSON.stringify(prose));
  }
});

test('a relative path is not announced, and a repeat is one file', () => {
  // The path goes to a download endpoint that has no notion of a working directory, and an agent
  // that names the same report twice wrote one report.
  assert.deepEqual(announcedArtifacts('```sandbox_artifacts\nreports/may.md\n```'), []);
  assert.deepEqual(
    announcedArtifacts('```sandbox_artifacts\n/a.md\n/a.md\n```'),
    ['/a.md'],
  );
});

test('the name on disk cannot choose where the file lands', () => {
  /**
   * The same argument as the session directory: this decides where a file the *model* named ends
   * up, and `../../` in it would put it somewhere nobody is looking. Separators become dashes
   * rather than being stripped, so two reports from different directories keep different names.
   */
  assert.equal(artifactName('/work/reports/may.md'), 'work-reports-may.md');
  assert.equal(artifactName('/work/../../etc/passwd'), 'work-..-..-etc-passwd');
  assert.ok(!artifactName('/work/../../etc/passwd').includes('/'));

  // Two files with the same basename stay two files.
  assert.notEqual(artifactName('/work/a/report.md'), artifactName('/work/b/report.md'));

  /**
   * The property, rather than a particular string. `/../..` flattens to `..-..`, which is an ugly
   * filename and a perfectly safe one - it carries no separator, so it cannot leave the directory,
   * and asserting it equals 'artifact' would be testing a spelling instead of the guarantee.
   */
  for (const path of ['/', '/..', '/../..', '', null, undefined, '/a/../../b']) {
    const name = artifactName(path);
    assert.ok(name.length > 0, `${JSON.stringify(path)} produced an empty name`);
    assert.ok(!name.includes('/') && !name.includes('\\'), `${JSON.stringify(path)} kept a separator`);
  }

  // The two that are only "somewhere else" get a name of their own rather than a run of dots.
  assert.equal(artifactName('/'), 'artifact');
  assert.equal(artifactName('/..'), 'artifact');
});
