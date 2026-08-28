import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkRegistry, readSkill, skillDirs, UNIVERSAL } from './skills.mjs';
import { specFiles } from './spec.mjs';

const specs = () => specFiles().map(({ path }) => JSON.parse(readFileSync(path, 'utf8')));

test('the skill registry and the agents that use it agree', () => {
  const problems = checkRegistry(specs());
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('every skill declares a name matching its directory and a description saying when to use it', () => {
  for (const dir of skillDirs()) {
    const skill = readSkill(dir);
    assert.deepEqual(skill.problems, [], `skills/${dir}: ${skill.problems.join('; ')}`);
    assert.equal(skill.name, dir);
  }
});

test('an agent attaching a skill that does not exist is caught', () => {
  /**
   * The expensive failure, and the one nothing else catches. A skill is fetched from git when the
   * sandbox starts; a path that is not there fails the fetch and takes the sandbox with it. The
   * agent then reports that it could not reach its tools, which sends whoever is debugging to the
   * connector and the token - neither of which is the problem.
   */
  const invented = [
    {
      name: 'x',
      manifest: { config: { sandbox: { enabled: true } }, skills: [{ name: 'untrusted-input' }, { name: 'no-such-skill' }] },
    },
  ];
  assert.match(checkRegistry(invented).join('\n'), /attaches skill "no-such-skill".*sandbox init/s);
});

test('a sandboxed agent without the guardrail is caught', () => {
  const bare = [{ name: 'x', manifest: { config: { sandbox: { enabled: true } }, skills: [] } }];
  assert.match(checkRegistry(bare).join('\n'), /does not carry the "untrusted-input" guardrail/);

  // An agent with no sandbox cannot carry a skill at all, so it is not asked to.
  const nosandbox = [{ name: 'x', manifest: { config: { sandbox: { enabled: false } }, skills: [] } }];
  assert.deepEqual(
    checkRegistry(nosandbox).filter((p) => p.startsWith('x:')),
    [],
  );
});

test('every guardrail skill is one that exists', () => {
  // Otherwise the rule above demands something nothing can supply, and every spec fails at once.
  const dirs = new Set(skillDirs());
  for (const name of UNIVERSAL) assert.ok(dirs.has(name), `UNIVERSAL names ${name}, which has no directory`);
});

test('a skill nothing attaches is caught, because it is documentation nobody reads', () => {
  // Checked against a fixture rather than the real tree: the real tree passing is the first test.
  const orphaned = checkRegistry([
    { name: 'x', manifest: { config: { sandbox: { enabled: true } }, skills: [{ name: 'untrusted-input' }] } },
  ]);
  assert.match(orphaned.join('\n'), /no agent attaches it - dead documentation/);
});

test('the guardrail skill names the shapes an injection actually takes', () => {
  /**
   * A guardrail whose body drifts into generalities stops guarding. These are the specific claims
   * that appeared in this project's own injection fixture and in the run that echoed it back, so a
   * rewrite that loses them is losing the thing the demonstration proved.
   */
  const body = readSkill('untrusted-input').body.toLowerCase();
  for (const shape of ['pre-approved', 'standing grant', 'quote it', 'urgency', 'authority']) {
    assert.ok(body.includes(shape), `the untrusted-input skill no longer mentions ${shape}`);
  }
});
