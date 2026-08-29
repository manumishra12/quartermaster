import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAgents, mentions, route, scoreAgent } from './route.mjs';
import { routingConflicts } from './spec.mjs';

const agents = [
  { name: 'fixer', routing: { handles: ['failing test', 'pull request'], avoid: ['review'] } },
  { name: 'reviewer', routing: { handles: ['review', 'review this pull request'], avoid: ['fix it'] } },
  { name: 'silent', routing: null },
];

test('phrases match whole words, in order and adjacent', () => {
  /**
   * Substring matching made `pr` match `prompt` and `ci` match `decision`, and a loose multi-word
   * match made "pull request" true of any sentence containing both words anywhere - which is most
   * of them, so the router agreed with itself about everything.
   */
  assert.equal(mentions('the pull request is open', 'pull request'), true);
  assert.equal(mentions('pull the lever, then request it', 'pull request'), false);
  assert.equal(mentions('write me a prompt', 'pr'), false);
  assert.equal(mentions('Review This Pull Request', 'review this pull request'), true);
});

test('a longer phrase outranks a word half the specs mention', () => {
  const specific = scoreAgent('review this pull request', agents[1].routing);
  assert.ok(specific.score > scoreAgent('review', agents[1].routing).score);
});

test('avoid subtracts, which is how an agent declines a word that will match it', () => {
  const scored = scoreAgent('review this and then fix it', agents[1].routing);
  assert.deepEqual(scored.against, ['fix it']);
  assert.ok(scored.score < scoreAgent('review this', agents[1].routing).score);
});

test('a clear request is decided, and the reason names the evidence', () => {
  const decision = route('the failing test needs a pull request', agents);
  assert.equal(decision.decided, true);
  assert.equal(decision.agent, 'fixer');
  assert.match(decision.why, /failing test/);
});

test('nothing matching is not a route to the first agent', () => {
  /**
   * The behaviour this replaced: whatever was asked, `quartermaster-local` answered it. A database
   * question was handled, capably and at length, by the agent that fixes failing tests.
   */
  const decision = route('the weather in london', agents);
  assert.equal(decision.decided, false);
  assert.deepEqual(decision.candidates, []);
});

test('a near-tie stops rather than picking the one that sorts first', () => {
  const decision = route('review', [
    { name: 'a', routing: { handles: ['review'] } },
    { name: 'b', routing: { handles: ['review'] } },
  ]);
  assert.equal(decision.decided, false);
  assert.match(decision.why, /match this about equally/);
  assert.deepEqual(decision.candidates.map((c) => c.name), ['a', 'b']);
});

test('one weak match is reported as thin evidence, not as a tie', () => {
  /**
   * Both stop and ask, but they are different facts and the person answering can only use the
   * right one. Saying "these match about equally" about a single agent is also not English.
   */
  const decision = route('review', [{ name: 'a', routing: { handles: ['review'] } }, { name: 'b', routing: { handles: ['sql'] } }]);
  assert.equal(decision.decided, false);
  assert.match(decision.why, /only a matched/);
});

test('a spec with no routing block is never routed to', () => {
  /**
   * Reaching it needs `--agent`, which is the right default for an agent that has not said what it
   * is for: nothing arrives there by accident.
   */
  assert.equal(route('silent', agents).scored.find((s) => s.name === 'silent').score, 0);
});

test('the real specs each answer their own headline request', () => {
  /**
   * The routing blocks are data, and data drifts. This is the test that fails when somebody adds a
   * phrase to one agent that quietly takes work from another.
   */
  const real = loadAgents();
  const expected = [
    ['the checkout test is failing, open a pull request', 'quartermaster'],
    ['how many refunds did we issue last month', 'analytics'],
    ['the error rate is spiking, we have an incident', 'incident-responder'],
    ['review this pull request and say what is wrong with it', 'code-reviewer'],
    ['file a ticket and assign it', 'desk-assistant'],
    ['research this and give me sources', 'research-desk'],
  ];
  for (const [request, agent] of expected) {
    const decision = route(request, real);
    assert.equal(decision.decided, true, `undecided: ${request} (${decision.why})`);
    assert.equal(decision.agent, agent, `${JSON.stringify(request)} routed to ${decision.agent}`);
  }
});

test('two agents claiming the same phrase is a tie built at config time', () => {
  /**
   * Neither spec is wrong on its own, which is why nothing that reads one file at a time finds it.
   * The router would decline to choose and ask a person a question a config change could answer.
   */
  const conflicts = routingConflicts([
    { name: 'a', routing: { handles: ['pull request', 'bug'] } },
    { name: 'b', routing: { handles: ['Pull Request'] } },
  ]);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /"pull request" is claimed by a and b/);
});

test('the real specs do not claim each other\'s phrases', () => {
  assert.deepEqual(routingConflicts(loadAgents()), []);
});
