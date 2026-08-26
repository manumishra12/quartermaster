/**
 * A tool call the model wrote out instead of making, rendered for a person.
 *
 * A small model that cannot call tools prints the JSON it would have sent. That blob reaches the
 * transcript, the evidence report and the interface exactly as emitted - a wall of braces where a
 * sentence should be, and worse, a question the agent is apparently asking that nothing will ever
 * collect an answer to.
 *
 * Both facts have to come across: what it wanted, and that it did not happen. Rendering it prettily
 * without saying the second would be an interface politely presenting a question nobody is
 * listening to.
 */

/** Question-shaped calls are the common case and deserve to read as a question. */
const ASKS = /^ask_user_question$|question/i;

function line(label, value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) {
    return value.length ? [`    ${label}:`, ...value.map((v, i) => `      ${i + 1}. ${one(v)}`)] : [];
  }
  return [`    ${label}: ${one(value)}`];
}

function one(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Render one or more printed calls as lines.
 * Returns `[]` for ordinary prose, so a caller can render the answer normally.
 */
export function renderUnexecutedCalls(calls = []) {
  if (!calls.length) return [];

  const out = [];
  for (const call of calls) {
    const args = call.arguments ?? {};

    if (ASKS.test(call.name) && (args.question || args.prompt)) {
      out.push(`  It wanted to ask: ${one(args.question ?? args.prompt)}`);
      const options = args.options ?? args.choices;
      if (Array.isArray(options) && options.length) {
        out.push(...options.map((o, i) => `      ${i + 1}. ${one(o)}`));
      }
    } else {
      out.push(`  It wanted to call: ${call.name}`);
      for (const [key, value] of Object.entries(args)) out.push(...line(key, value));
    }
  }

  // The part that matters most, and the part a prettier rendering would quietly drop.
  out.push('  It wrote this out as text rather than calling it, so nothing happened and nothing is waiting for an answer.');
  return out;
}
