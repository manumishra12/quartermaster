/**
 * Turns a pending tool call into something a person can actually decide about.
 *
 * The gate used to print the first 800 characters of the raw arguments. For a `create_or_update_file`
 * or `push_files` call those arguments carry whole file contents, so the operator saw a truncated
 * JSON blob and typed `allow`. The pause fired correctly and conveyed almost nothing, which is a
 * gate in shape only: the point is not that somebody was asked, it is that they could answer.
 *
 * This renders what the call will change - the repository, the branch, the paths, the sizes, the
 * title - and keeps the raw arguments available underneath for anything it does not recognise.
 */

const MAX_VALUE = 120;

/** Fields worth showing first, in the order a person reads them. */
const HEADLINE = ['owner', 'repo', 'repository', 'branch', 'base', 'head', 'ref', 'title', 'path', 'query', 'command'];

function short(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text == null) return '';
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}… (${text.length} chars)` : text;
}

function lines(label, value) {
  return value === undefined || value === null || value === '' ? [] : [`    ${label}: ${short(value)}`];
}

/**
 * A human-readable summary of one pending call.
 * Returns an array of lines so the caller controls indentation and colour.
 */
export function describeCall(toolName, argsText) {
  const out = [`  tool: ${toolName ?? 'unknown tool'}`];

  let args;
  try {
    args = JSON.parse(argsText || '{}');
  } catch {
    // Unparseable arguments are themselves worth seeing in full rather than summarised away.
    out.push('    arguments (unparsed):', `    ${String(argsText ?? '').slice(0, 600)}`);
    return out;
  }

  if (!args || typeof args !== 'object') return out;

  for (const key of HEADLINE) {
    if (key in args) out.push(...lines(key, args[key]));
  }

  // File writes are the calls where the raw arguments are least readable and the stakes highest.
  const files = Array.isArray(args.files) ? args.files : args.path ? [args] : [];
  if (files.length > 0) {
    out.push(`    writes ${files.length} file(s):`);
    for (const file of files.slice(0, 10)) {
      const path = file?.path ?? file?.name ?? '(unnamed)';
      const content = typeof file?.content === 'string' ? file.content : '';
      const bytes = content.length;
      const first = content.split('\n')[0] ?? '';
      out.push(`      ${path}  ${bytes} bytes`);
      if (first) out.push(`        first line: ${short(first)}`);
    }
    if (files.length > 10) out.push(`      … and ${files.length - 10} more`);
  }

  // Anything else, so nothing is hidden by the summary.
  const shown = new Set([...HEADLINE, 'files', 'content', 'name']);
  const rest = Object.keys(args).filter((k) => !shown.has(k));
  for (const key of rest) out.push(...lines(key, args[key]));

  return out;
}
