/**
 * Reading command-line flags without letting the next flag become a value.
 *
 * `argv[argv.indexOf('--agent') + 1]` is the obvious way to do this and it is wrong twice over.
 * `--agent` as the last argument yields `undefined`, which went on to open a session for an agent
 * with no name; and `--agent --deny-all` yields `--deny-all`, so the flag whose whole purpose is
 * to refuse everything was silently consumed as an agent name and never took effect. Both fail
 * quietly, and the second one fails quietly in the direction of approving things.
 *
 * The smoke runner already guarded against this and the runner did not, which is the reason this
 * lives here instead: a rule enforced in one of the two places it applies is a rule nobody can
 * rely on.
 */

/**
 * The value of `--name`, or a problem to report. A missing flag is not a problem - it is the
 * caller's default - but a flag given without a value is, because there is no safe guess.
 */
export function readFlag(argv, name, fallback = null) {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return { value: fallback };
  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) return { problem: `--${name} needs a value` };
  return { value };
}

/**
 * Everything that is not a flag or a flag's value.
 *
 * `valueFlags` has to be given rather than guessed: whether the word after `--deny-all` belongs to
 * it is not something argv can be asked. Naming them keeps the prompt from swallowing an agent
 * name, which is what the hand-written version did when a flag was added and its name was not
 * added to the filter beside it.
 */
export function positionals(argv, valueFlags = []) {
  const consumes = new Set(valueFlags.map((name) => `--${name}`));
  return argv.filter((arg, i) => !arg.startsWith('--') && !consumes.has(argv[i - 1]));
}
