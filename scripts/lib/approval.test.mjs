import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideApproval } from './approval.mjs';

const at = (over) => decideApproval({ displayable: true, denyAll: false, piped: false, ...over });

test('a person at a terminal can approve, in any of the words that mean yes', () => {
  // Both directions: a gate that cannot be passed is not a gate either, it is a broken tool.
  for (const answer of ['allow', 'yes', 'y', 'approve', 'ALLOW', '  Yes  ']) {
    const { approval, refused } = at({ answer });
    assert.equal(approval.status, 'allow', answer);
    assert.equal(refused, false, answer);
  }
});

test('a call that could not be displayed is refused, and recorded as refused', () => {
  /**
   * The defect this file exists for. The runner denied an undisplayable call and returned early,
   * skipping the bookkeeping - so the response came back with no output and no exit code and was
   * filed as an execution. A refusal counted as a thing that happened, in the report a reviewer
   * reads to find out what happened.
   */
  const { approval, refused } = at({ displayable: false, answer: 'allow' });
  assert.equal(approval.status, 'deny');
  assert.match(approval.reason, /could not be displayed/);
  assert.equal(refused, true, 'a refusal the record does not carry is a refusal the report loses');
});

test('every outcome that is not an allow says it was refused', () => {
  // Stated as a property rather than case by case, because the bug was one branch out of two
  // forgetting to mention it.
  const inputs = [
    { answer: 'deny' },
    { answer: '' },
    { answer: null },
    { answer: 'abort' },
    { answer: 'allow', piped: true },
    { answer: 'allow', denyAll: true },
    { displayable: false },
    { displayable: false, denyAll: true, piped: true, answer: 'yes' },
  ];
  for (const input of inputs) {
    const { approval, refused } = at(input);
    assert.equal(refused, approval.status === 'deny', JSON.stringify(input));
    if (approval.status === 'deny') assert.ok(approval.reason, 'a denial has to say why');
  }
});

test('a pipe may deny but never approve', () => {
  const allowed = at({ piped: true, answer: 'allow' });
  assert.equal(allowed.approval.status, 'deny');
  assert.equal(allowed.refused, true);
  assert.match(allowed.note, /person at a terminal/);

  // And refusal from a script is still refusal, so the piped denial goes through unchanged.
  assert.equal(at({ piped: true, answer: 'deny' }).approval.status, 'deny');
});

test('--deny-all outranks a typed yes, and says which flag refused', () => {
  const { approval, refused } = at({ denyAll: true, answer: 'allow' });
  assert.equal(approval.status, 'deny');
  assert.equal(approval.reason, 'denied by --deny-all');
  assert.equal(refused, true);
});

test('a word that merely starts like yes is not a yes', () => {
  // `abort` used to approve, because the check was on the first letter.
  for (const answer of ['abort', 'a', 'always ask', 'no', 'nope', 'yeah']) {
    assert.equal(at({ answer }).approval.status, 'deny', answer);
  }
});

test('the note is only for the case that needs explaining', () => {
  // A line printed on every denial would bury the one that says why a piped allow was not honoured.
  assert.equal(at({ answer: 'deny' }).note, null);
  assert.equal(at({ answer: 'allow' }).note, null);
  assert.equal(at({ denyAll: true, answer: 'allow' }).note, null);
});
