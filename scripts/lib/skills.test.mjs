import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

test('the warehouse fixture still contains every trap its README claims', () => {
  /**
   * The README publishes exact answers so an agent can be checked against them rather than merely
   * observed to have run something. That only works while the numbers are true, and a fixture is
   * the easiest thing in a repository to edit by hand and forget.
   */
  const seed = readFileSync(fileURLToPath(new URL('../../fixtures/warehouse/seed.sql', import.meta.url)), 'utf8');
  const readme = readFileSync(fileURLToPath(new URL('../../fixtures/warehouse/README.md', import.meta.url)), 'utf8');

  const rows = (table) => seed.split('\n').filter((l) => l.startsWith(`INSERT INTO ${table} `)).length;
  assert.equal(rows('customers'), 180);
  assert.equal(rows('orders'), 638);

  // The traps, checked in the data rather than trusted from the prose.
  assert.equal((seed.match(/, 'cancelled', /g) ?? []).length, 120, 'cancelled orders');
  assert.equal((seed.match(/INSERT INTO customers VALUES \(\d+, '[^']*', NULL,/g) ?? []).length, 2, 'null countries');
  assert.ok(seed.includes("INSERT INTO customers VALUES (92, 'Customer 041'"), 'the shared name');
  assert.ok(seed.includes("'2026-04-30T23:59:59Z'") && seed.includes("'2026-05-01T00:00:01Z'"), 'the month boundary');

  // And the README's headline numbers are the ones the generator computed.
  for (const claim of ['518', '13,775,026', '595,204', '13,179,822', '43']) {
    assert.ok(readme.includes(claim), `README no longer states ${claim}`);
  }
});

test('a description names a trigger, however it is phrased', () => {
  /**
   * The rule is that the description says *when* to load the skill, and it was checking for three
   * spellings of one phrase - so it rejected "Use after opening a pull request", which states a
   * trigger perfectly well. A check about phrasing rather than about the property it enforces is
   * a check that will be worked around rather than satisfied.
   */
  for (const skill of skillDirs().map((dir) => readSkill(dir))) {
    assert.ok(
      !skill.problems.some((p) => /does not say when to use/.test(p)),
      `skills/${skill.dir}: ${skill.problems.join('; ')}`,
    );
  }

  // Every one of them states a trigger, in whatever words.
  for (const skill of skillDirs().map((dir) => readSkill(dir))) {
    assert.match(
      skill.description,
      /\buse (when|whenever|for|after|once|before|during)\b/i,
      `skills/${skill.dir} does not say when to load it`,
    );
  }
});

test('the SQL skill carries the guardrails a database agent needs', () => {
  /**
   * This agent turns an English question into SQL, so somebody else's string ends up near a query
   * every single time - and the skill said nothing at all about binding. The apostrophe case is
   * the one that bites daily: a customer called O'Brien breaks an interpolated query outright, and
   * the syntax error reads as a broken database rather than as a quoting bug.
   *
   * Profiling is here for the same reason: reading a schema tells you the column names, and only
   * profiling tells you that two rows have no country and one order has no line items - which is
   * the difference between a query that runs and an answer that is right.
   */
  const body = readSkill('sql-analysis').body.toLowerCase();
  for (const guard of ['bind', 'never paste', "o'brien", 'identifiers cannot be bound', 'orphan']) {
    assert.ok(body.includes(guard), `sql-analysis no longer covers ${guard}`);
  }

  // And the older rules it must not lose while gaining these.
  for (const rule of ['category, not a list', 'never present a number you did not get']) {
    assert.ok(body.includes(rule), `sql-analysis no longer states "${rule}"`);
  }
});

test('the report skill offers a format for each kind of reader', () => {
  // Markdown is what somebody reads, CSV is what they pivot, JSON is what the next system consumes.
  // A number in a chat window serves none of them past tomorrow.
  const body = readSkill('data-report').body.toLowerCase();
  for (const shape of ['rows.csv', 'result.json', 'sandbox_artifacts', 'erdiagram', 'cursor.description']) {
    assert.ok(body.includes(shape), `data-report no longer covers ${shape}`);
  }
});
