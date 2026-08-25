/**
 * Turns a pending tool call into something a person can actually decide about.
 *
 * The gate used to print the first 800 characters of the raw arguments. For a `create_or_update_file`
 * or `push_files` call those arguments carry whole file contents, so the operator saw a truncated
 * JSON blob and typed `allow`. The pause fired correctly and conveyed almost nothing, which is a
 * gate in shape only: the point is not that somebody was asked, it is that they could answer.
 *
 * The rule this file follows is that the display never claims more completeness than it has. A
 * summary that quietly drops the eleventh path, or a file body under its first line, is worse than
 * the raw JSON it replaced: it reads as a full account of the change and is not one. So everything
 * is shown in full, and on the one occasion that is refused - a runaway argument - the refusal is
 * stated in the display itself, with the amount withheld.
 */

/** A runaway guard, not a summarisation budget. Reaching it is reported, never silent. */
const MAX_TOTAL = 40_000;

/** Fields worth showing first, in the order a person reads them. */
const HEADLINE = ['owner', 'repo', 'repository', 'branch', 'base', 'head', 'ref', 'title', 'path', 'query', 'command'];

/**
 * Arguments reach the terminal as text, so they can carry terminal control sequences. A crafted
 * path or title could clear the screen, move the cursor back over what was already printed, or
 * colour a forged line - rewriting the approval prompt the operator is reading. Raw JSON was
 * accidentally safe here, because JSON escapes its own control characters; formatted output has to
 * do it deliberately. Tab and newline survive, since layout is this file's own business.
 */
function visible(value) {
  return String(value).replace(
    // Matching control characters is the whole point here: they are what has to be escaped.
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g,
    (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
}

/** A value on one line: newlines are escaped too, so a value cannot forge extra display lines. */
function oneLine(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return visible(text).replace(/\n/g, '\\n');
}

/**
 * A multi-line value, each line behind a gutter. The gutter is what makes injected text safe to
 * read: content that mimics this file's own labels is still visibly inside the quoted body.
 */
function block(value, indent) {
  return visible(String(value)).split('\n').map((line) => `${indent}| ${line}`);
}

/** UTF-16 code units are not bytes. Reporting them as bytes understates every non-ASCII file. */
function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

function field(label, value) {
  if (value === undefined || value === null || value === '') return [];
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  // Anything that will be published or written is shown whole, on its own lines if it has any.
  if (text.includes('\n') || text.length > 200) {
    return [`    ${label}: ${byteLength(text)} bytes`, ...block(text, '      ')];
  }
  return [`    ${label}: ${oneLine(text)}`];
}

/**
 * A human-readable summary of one pending call.
 * Returns an array of lines so the caller controls indentation and colour.
 */
export function describeCall(toolName, argsText) {
  const out = [`  tool: ${oneLine(toolName ?? 'unknown tool')}`];

  let args;
  try {
    args = JSON.parse(argsText || '{}');
  } catch {
    // Unparseable arguments are themselves worth seeing in full rather than summarised away.
    out.push('    arguments (unparsed):', ...block(String(argsText ?? ''), '    '));
    return cap(out);
  }

  if (!args || typeof args !== 'object') return out;

  for (const key of HEADLINE) {
    if (key in args) out.push(...field(key, args[key]));
  }

  // File writes are the calls where the raw arguments are least readable and the stakes highest.
  const files = Array.isArray(args.files) ? args.files : args.path ? [args] : [];
  if (files.length > 0) {
    out.push(`    writes ${files.length} file(s):`);
    for (const file of files) {
      const path = oneLine(file?.path ?? file?.name ?? '(unnamed)');
      const content = typeof file?.content === 'string' ? file.content : '';
      out.push(`      ${path}  ${byteLength(content)} bytes`);
      // The body itself, not its first line: two unrelated files share a first line every day.
      if (content) out.push(...block(content, '        '));
    }
  }

  // Anything else, so nothing is hidden by the summary.
  const shown = new Set([...HEADLINE, 'files', 'content', 'name']);
  for (const key of Object.keys(args).filter((k) => !shown.has(k))) {
    out.push(...field(key, args[key]));
  }

  return cap(out);
}

/** Enforces the runaway guard by saying what it withheld, so the display stays honest. */
function cap(out) {
  const kept = [];
  let size = 0;
  for (const line of out) {
    if (size + line.length > MAX_TOTAL) {
      const withheld = out.slice(kept.length);
      const chars = withheld.reduce((n, l) => n + l.length + 1, 0);
      kept.push(
        `    !! display incomplete: ${withheld.length} more line(s), ${chars} characters, not shown.`,
        '    !! deny unless you have reviewed this call somewhere it fits.',
      );
      return kept;
    }
    kept.push(line);
    size += line.length + 1;
  }
  return kept;
}
