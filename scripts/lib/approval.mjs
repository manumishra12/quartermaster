/**
 * What happens at the approval gate, decided in one place.
 *
 * The runner had two exits from the gate and only one of them kept a record. A call that could not
 * be displayed was denied - correctly, since nobody can consent to a blank - and returned early,
 * skipping the line that adds the id to the refused set. Its response then arrived like any other,
 * with no output and no exit code, and was filed as an execution: a call the gate stopped, counted
 * as a thing that happened, in the report a reviewer reads to find out what happened. That is the
 * one direction this project cannot be wrong in.
 *
 * The record of a refusal is not a detail of the branch that refuses, so it is not written per
 * branch. Every outcome comes out of here carrying whether it was refused, and there is no path
 * out of the gate that forgets to say.
 */

/**
 * Exact words only. This used to accept anything starting with "a", so `abort` - the word an
 * operator reaches for when they have just realised they do not want this - approved the call.
 */
const ALLOWING = ['allow', 'yes', 'y', 'approve'];

/**
 * @param displayable  whether the call could be shown to the operator at all
 * @param denyAll      the flag whose whole purpose is that this session approves nothing
 * @param piped        stdin is not a terminal, so nobody is present at the moment of the decision
 * @param answer       what the operator typed, or null when nobody was asked
 */
export function decideApproval({ displayable = true, denyAll = false, piped = false, answer = null } = {}) {
  const deny = (reason, note = null) => ({ approval: { status: 'deny', reason }, refused: true, note });

  // A blank cannot be consented to. Asking somebody to approve one is worse than not asking: it
  // produces the appearance of oversight without any.
  if (!displayable) return deny('The call could not be displayed for approval');
  if (denyAll) return deny('denied by --deny-all');

  const wantedAllow = ALLOWING.includes(String(answer ?? '').toLowerCase().trim());
  /**
   * A pipe can refuse but it cannot approve.
   *
   * Reading piped answers made the documented denial real, and it made an unattended `echo allow`
   * real at the same time - a script authorising an irreversible write with no person present at
   * the moment of the decision. A token in a file is not somebody deciding. Denials are taken from
   * anywhere, because being refused by a script is still being refused.
   */
  if (wantedAllow && piped) {
    return deny('denied by the operator', 'refused: approval has to come from a person at a terminal, not from a pipe');
  }
  if (wantedAllow) return { approval: { status: 'allow' }, refused: false, note: null };
  // Anything unrecognised is a denial, including silence.
  return deny('denied by the operator');
}
