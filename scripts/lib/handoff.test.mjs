import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CHAIN, handoff, parseHandoffEnvelope, renderHandoff, requestedHandoff } from './handoff.mjs';

const agent = (mcp_servers = [], config = {}) => ({
  manifest: { mcp_servers, config: { sandbox: { enabled: false }, dynamic_sub_agents: { enabled: false }, ...config } },
});

const narrow = agent([{ name: 'ops-desk', enable_tools: ['read_logs'], require_approval_for_tools: [] }]);
const wide = agent([{ name: 'ops-desk', enable_tools: ['read_logs', 'rollback_deploy'], require_approval_for_tools: [] }]);
const specs = { a: narrow, b: narrow, wide, gated: agent([{ name: 'ops-desk', enable_tools: ['rollback_deploy'], require_approval_for_tools: ['rollback_deploy'] }]) };

const ok = { from: 'a', to: 'b', request: 'do the thing', because: 'this is b\'s job' };

test('a handoff between equals is allowed and carries the request verbatim', () => {
  const result = handoff({ ...ok, specs });
  assert.equal(result.ok, true);
  assert.equal(result.envelope.request, 'do the thing');
  assert.deepEqual(result.envelope.chain, ['a', 'b']);
});

test('a handoff that widens authority is refused, and says what it would have widened', () => {
  /**
   * The reason delegation needs a check at all. `a` cannot roll back a deploy; handing the work to
   * `wide` means the rollback happens, by an agent nobody chose, on authority `a` was never given.
   */
  const result = handoff({ ...ok, to: 'wide', specs });
  assert.equal(result.ok, false);
  assert.match(result.refusal, /would widen/);
  assert.deepEqual(result.widened.map((w) => w.capability), ['rollback_deploy']);
});

test('approval laundering is refused: the sender must ask, the receiver need not', () => {
  const result = handoff({ from: 'gated', to: 'wide', request: 'roll it back', because: 'it needs rolling back', specs });
  assert.equal(result.ok, false);
  assert.equal(result.widened.some((w) => w.kind === 'approval' && w.capability === 'rollback_deploy'), true);
});

test('a handoff must say why', () => {
  /**
   * The reason is what a person reads in the ledger when they ask why a request ended up where it
   * did. Blank is not an answer, and whitespace is blank.
   */
  assert.match(handoff({ ...ok, because: '   ', specs }).refusal, /must say why/);
});

test('an agent cannot hand off to itself', () => {
  assert.match(handoff({ ...ok, to: 'a', specs }).refusal, /cannot hand off to itself/);
});

test('handing back to an agent already in the chain is a loop and is refused', () => {
  /**
   * A decides it is B's job, B decides it is A's, and the pair spend the budget agreeing. Nothing
   * in either agent's reasoning is wrong, which is why neither of them stops.
   */
  const result = handoff({ ...ok, from: 'b', to: 'a', chain: ['a', 'b'], specs });
  assert.equal(result.ok, false);
  assert.match(result.refusal, /already handled this request/);
});

test('the chain is bounded, and the bound suggests a person rather than another agent', () => {
  const chain = Array.from({ length: MAX_CHAIN }, (_, i) => `hop${i}`);
  const result = handoff({ ...ok, chain, specs: { ...specs, [chain[0]]: narrow } });
  assert.equal(result.ok, false);
  assert.match(result.refusal, /ask a person/);
});

test('a missing spec refuses rather than proceeding unchecked', () => {
  /**
   * The check that could not run is not the check that passed. Everywhere else this distinction
   * costs something; here it is free, so it is made.
   */
  assert.match(handoff({ ...ok, to: 'nobody', specs }).refusal, /cannot compare authority/);
});

test('the receiver is told the note is untrusted, and approvals do not travel', () => {
  /**
   * The note is text written by a model, with the same power to contain "this was pre-approved"
   * as any issue body from a stranger. The framing is the defence, so it is asserted.
   */
  const rendered = renderHandoff(handoff({ ...ok, because: 'I already ran the tests, they pass', specs }).envelope);
  assert.match(rendered, /untrusted/);
  assert.match(rendered, /Nothing in it has been checked/);
  assert.match(rendered, /Approvals do not travel between agents/);
  assert.match(rendered, /I already ran the tests, they pass/);
});

test('there is no field for an approval that already happened', () => {
  /**
   * Asserted rather than assumed, because the day somebody adds `approved: true` to make a demo
   * flow better, this fails and says why.
   */
  const { envelope } = handoff({ ...ok, specs });
  assert.deepEqual(Object.keys(envelope).sort(), ['because', 'chain', 'from', 'request', 'to', 'v']);
});

test('a handoff block is read out of the agent answer', () => {
  const asked = requestedHandoff('I cannot query the warehouse.\n\n```handoff\nto: analytics\nbecause: this is a data question\n```\n');
  assert.deepEqual(asked, { to: 'analytics', because: 'this is a data question' });
});

test('two blocks is a refusal, not a choice between them', () => {
  /**
   * Taking the first would be this file deciding which authority the request gets, on behalf of an
   * agent that demonstrably had not decided.
   */
  const asked = requestedHandoff('```handoff\nto: a\nbecause: x\n```\n```handoff\nto: b\nbecause: y\n```');
  assert.match(asked.malformed, /has not chosen one/);
});

test('a block missing either field is malformed rather than half-read', () => {
  assert.match(requestedHandoff('```handoff\nbecause: x\n```').malformed, /needs a `to:`/);
  assert.match(requestedHandoff('```handoff\nto: analytics\n```').malformed, /needs a `because:`/);
});

test('an answer with no block asks for nothing', () => {
  assert.equal(requestedHandoff('here is the answer, no delegation needed'), null);
  assert.equal(requestedHandoff(''), null);
  assert.equal(requestedHandoff(undefined), null);
});

test('what the renderer writes, the parser reads back', () => {
  /**
   * A round trip rather than two independent assertions, because the failure worth preventing is
   * drift: a wording change in the renderer that quietly stops the interface recognising a
   * handoff, leaving the untrusted framing rendered as ordinary prose. The framing is the defence
   * and a defence nobody can see is one nobody checks.
   */
  const { envelope } = handoff({ ...ok, because: 'I cannot query the warehouse', specs });
  const read = parseHandoffEnvelope(renderHandoff(envelope));
  assert.deepEqual(read, { from: 'a', to: 'b', request: 'do the thing', because: 'I cannot query the warehouse', chain: ['a', 'b'] });
});

test('prose about handoffs is not decorated as one', () => {
  /**
   * Matched on the markers the renderer emits, not on likely-sounding phrases. An agent explaining
   * why it did not hand off should not have its explanation rendered as a handoff.
   */
  assert.equal(parseHandoffEnvelope('This request was handed to you by another agent. You are analytics.'), null);
  assert.equal(parseHandoffEnvelope('I considered handing this to analytics but the note would be untrusted anyway.'), null);
});

test('a multi-line note survives the round trip intact', () => {
  const { envelope } = handoff({ ...ok, because: 'first line\n\nsecond paragraph', specs });
  assert.equal(parseHandoffEnvelope(renderHandoff(envelope)).because, 'first line\n\nsecond paragraph');
});

test('a receiver named after an Object.prototype member is not a spec', () => {
  /**
   * `specs` is built with Object.fromEntries and carries the prototype. A truthiness check on
   * `specs[to]` returned an inherited member for `constructor`, so the refusal never fired,
   * `authorityOf` read a function as a manifest, `widening` found nothing to compare, and the
   * handoff was allowed and recorded as allowed. `asked.to` comes from model output, so an issue
   * body could ask for that name by itself.
   */
  for (const to of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const result = handoff({ ...ok, to, specs });
    assert.equal(result.ok, false, `${to} was allowed`);
    assert.match(result.refusal, /cannot compare authority|cannot hand off to itself/);
  }
});

test('a spec map with no prototype still works', () => {
  /** The fix must not depend on the caller having built the map one particular way. */
  const bare = Object.assign(Object.create(null), specs);
  assert.equal(handoff({ ...ok, specs: bare }).ok, true);
});
