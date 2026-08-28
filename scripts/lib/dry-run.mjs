import { describeCall, visible } from './describe-call.mjs';

/**
 * What a call would do, said in a sentence, without doing it.
 *
 * `describe-call.mjs` already solved half of this: it prints every argument in full so nothing is
 * hidden behind a truncation. That is the *contents* of the call. It is not what the call means.
 * An operator looking at
 *
 *     tool: rollback_deploy
 *       deployment_id: 4c21
 *
 * has been shown everything and told nothing. They are approving "roll back checkout from v2.4.1 to
 * v2.4.0" whether or not anybody showed them that sentence, so the sentence is the thing being
 * consented to and it ought to be on the screen.
 *
 * Three parts, and the third is the one usually missing. The target - what gets touched. The change,
 * stated from-and-to where that is knowable. And what would be checked afterwards to know it worked,
 * because an approval given without knowing how it will be verified is an approval given on trust.
 *
 * The rule this file inherits from `describe-call.mjs`: the display never claims more than it has.
 * Where the current value is not known here, it says so rather than quietly writing a sentence with
 * only a destination in it - "would set the version to v2.4.0" reads like a change and is not one.
 *
 * There is no execution path in this module. It imports nothing that can reach a filesystem, a
 * process or a network, and it holds no branch that dispatches anything. That is not an accident of
 * the current implementation, it is the property: a dry run that can run is not a dry run, and the
 * only way to be sure is for the capability to be absent rather than guarded. There is a test that
 * reads this file and asserts it.
 */

/**
 * Verbs, so the sentence reads like English rather than like a function name.
 *
 * Keyed on the first word of the tool name, which is where tool naming conventions put the verb.
 * Anything not in here falls through to a form that names the tool and admits it does not know what
 * the tool does - which is worth saying out loud, because a confident sentence about an unfamiliar
 * tool is exactly the thing that would get waved through.
 */
const VERBS = {
  rollback: 'roll back',
  revert: 'revert',
  restart: 'restart',
  redeploy: 'redeploy',
  deploy: 'deploy',
  scale: 'scale',
  delete: 'delete',
  remove: 'remove',
  drop: 'drop',
  purge: 'purge',
  create: 'create',
  update: 'update',
  set: 'set',
  send: 'send',
  post: 'post',
  push: 'push',
  merge: 'merge',
  close: 'close',
  open: 'open',
  enable: 'enable',
  disable: 'disable',
  cancel: 'cancel',
  approve: 'approve',
  assign: 'assign',
  add: 'add',
  write: 'write',
};

/** Argument names that carry the thing being acted on, most specific first. */
const TARGET_KEYS = [
  'service',
  'service_name',
  'serviceName',
  'deployment_id',
  'deploymentId',
  'deploy_id',
  'release',
  'path',
  'file',
  'filename',
  'repository',
  'repo',
  'branch',
  'table',
  'channel',
  'issue_number',
  'issueNumber',
  'pull_number',
  'number',
  'ticket',
  'id',
  'target',
  'name',
  'to',
  'url',
];

/** Pairs that describe a change rather than a destination. */
const FROM_KEYS = ['from', 'from_version', 'fromVersion', 'old_version', 'oldVersion', 'previous', 'previous_version', 'current', 'before'];
const TO_KEYS = ['to', 'to_version', 'toVersion', 'new_version', 'newVersion', 'target_version', 'targetVersion', 'version', 'after', 'value'];

/**
 * `except` is not optional politeness. `to` names the thing acted on in `send_email({to: ...})` and
 * names the destination of a change in `set_version({to: ...})`, and one argument cannot be both -
 * without this the first reads "would send ops@example.com to ops@example.com", which is a sentence
 * that says something untrue about a call somebody is about to approve.
 */
function firstOf(args, keys, except = new Set()) {
  for (const key of keys) {
    if (except.has(key)) continue;
    const value = args?.[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'object') continue; // a nested object is not a name a person reads
    return { key, value: String(value) };
  }
  return null;
}

/** Arguments as an object, whether they arrived as one or as the text the runner actually holds. */
function argumentsOf(args) {
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {};
}

/** Arguments as text, for the full display that sits underneath the sentence. */
function argumentText(args) {
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return '{}';
  }
}

/** The verb and the rest of the tool name, split where the convention puts the split. */
function verbOf(tool) {
  const name = String(tool ?? '').trim();
  if (!name) return { verb: null, rest: null };
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\-.\s]+/)
    .filter(Boolean);
  const head = words[0]?.toLowerCase() ?? '';
  return { verb: VERBS[head] ?? null, rest: words.slice(1).join(' ').toLowerCase() || null };
}

/**
 * What would be checked afterwards.
 *
 * Derived from the verb, and only where the derivation is honest. Sending a message is the
 * interesting case: nothing this runner can do afterwards establishes that it arrived, and inventing
 * a check for it would be worse than admitting there is none, because the point of naming a check
 * is that somebody can go and perform it.
 */
function checksFor(verb, target) {
  const it = target ?? 'the target';
  switch (verb) {
    case 'roll back':
    case 'revert':
    case 'deploy':
    case 'redeploy':
      return [`the running version of ${it}`, `that ${it} is serving traffic again`];
    case 'restart':
      return [`that ${it} came back up`, `the error rate for ${it} after it did`];
    case 'scale':
      return [`the instance count for ${it}`];
    case 'delete':
    case 'remove':
    case 'drop':
    case 'purge':
      return [`that ${it} is gone`, `that nothing else was depending on it`];
    case 'write':
    case 'push':
    case 'update':
    case 'set':
      return [`the contents of ${it} after the write`];
    case 'create':
    case 'open':
      return [`that ${it} exists, and the identifier it came back with`];
    case 'close':
    case 'cancel':
      return [`that ${it} is closed`];
    case 'merge':
      return [`that ${it} is merged, and what the target branch looks like now`];
    case 'send':
    case 'post':
      // Said plainly, because a made-up check here is worse than none.
      return ['nothing on this side can establish that it arrived, only that it was accepted for sending'];
    default:
      return [];
  }
}

/**
 * The plan for one call: the sentence, the parts it was built from, and what it could not work out.
 *
 * `before` is the caller's, because this module cannot go and look. When it is given, the sentence
 * becomes a change; when it is not, the sentence stays a destination and `unknown` says why. Nothing
 * here guesses at a current value - a guessed "from" is a sentence that reads as verified and is
 * fiction.
 */
export function plan({ tool = null, args = null, before = undefined, checks = undefined } = {}) {
  const parsed = argumentsOf(args);
  const { verb, rest } = verbOf(tool);
  const target = firstOf(parsed, TARGET_KEYS);
  // The target claims its argument first, because what is being acted on is the more important of
  // the two readings and TARGET_KEYS is the more specific list.
  const spent = new Set(target ? [target.key] : []);
  const to = firstOf(parsed, TO_KEYS, spent);
  if (to) spent.add(to.key);
  const fromArg = firstOf(parsed, FROM_KEYS, spent);

  const from = before !== undefined && before !== null ? { key: 'observed', value: String(before) } : fromArg;
  const unknown = [];

  const name = String(tool ?? '').trim() || '(unnamed tool)';
  const subject = target ? target.value : null;

  let action;
  if (verb) {
    action = rest && !target ? `${verb} ${rest}` : verb;
  } else {
    // "call X on Y" rather than "call X Y", because an unrecognised tool is the case where the
    // sentence has to read as plainly as possible - it is the one nobody can check against a habit.
    action = subject ? `call ${name} on` : `call ${name}`;
    unknown.push(`nothing here knows what ${name} does, so this describes the call and not its effect`);
  }

  const parts = [`would ${action}`];
  if (subject) parts.push(subject);
  if (from && to) {
    parts.push(`from ${from.value} to ${to.value}`);
  } else if (to) {
    parts.push(`to ${to.value}`);
    unknown.push(
      'the current value is not known here, so this is stated as a destination and not as a change - the approver cannot see what it moves away from',
    );
  } else if (from) {
    parts.push(`away from ${from.value}`);
    unknown.push('the resulting value is not stated in the arguments, so what it becomes is not known here');
  }

  if (!subject) unknown.push('no argument names what this acts on, so the target is whatever the far side decides it is');

  const derived = checks === undefined ? checksFor(verb, subject) : Array.isArray(checks) ? checks.map(String) : [String(checks)];
  if (derived.length === 0) {
    unknown.push('nothing here knows what would confirm this worked, which is worth settling before it is approved and not after');
  }

  return {
    tool: name,
    action,
    target: subject,
    from: from ? from.value : null,
    to: to ? to.value : null,
    // The one line the approval is really about.
    sentence: `${parts.join(' ')}.`,
    checks: derived,
    unknown,
    // The full arguments, unsummarised, from the module that already refuses to hide any of them.
    arguments: describeCall(name, argumentText(args)),
    // Said in the object as well as in the render, so a caller that only reads the structure cannot
    // present a plan as though something had been done.
    executed: false,
  };
}

/** The plan as lines for a terminal, sanitised the same way the approval display is. */
export function renderPlan(planned) {
  if (!planned || typeof planned !== 'object') return [];

  const out = ['  ── WOULD DO ───────────────────────────────────────', `  ${visible(planned.sentence ?? '')}`];

  if (planned.checks?.length) {
    out.push('  Afterwards, to know it worked, check:');
    for (const check of planned.checks) out.push(`    - ${visible(String(check))}`);
  }

  if (planned.unknown?.length) {
    out.push('  Not known here:');
    for (const gap of planned.unknown) out.push(`    ! ${visible(String(gap))}`);
  }

  out.push('  The call itself:', ...(planned.arguments ?? []));
  // The half a tidier rendering would drop, and the half that makes this a dry run rather than a log.
  out.push('  Nothing above has happened. This is what the call would do, not a record of it doing it.');
  return out;
}
