import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_AGENTS = fileURLToPath(new URL('../../agents/', import.meta.url));

/**
 * Which agent should take this request, and why.
 *
 * Nine agents and one default is not a fleet, it is eight agents nobody reaches. `--agent` was
 * required knowledge: get it wrong and the request is answered by whichever spec happened to be
 * the default, competently and about the wrong thing.
 *
 * This is rule-based on purpose, and that is worth defending rather than apologising for. A model
 * would route better in the margins. It would also be a model deciding, unexplainably and
 * differently each time, which set of tools a request gets to touch - and choosing the agent is
 * choosing the authority, because `authority.mjs` exists to say how much these differ. This
 * project's whole argument is that the interesting decisions do not belong to the model. Routing
 * is one of them.
 *
 * So: it reads what each spec says it handles, it shows its working, and **when it is not sure it
 * does not pick**. An ambiguous route returns the candidates and stops. Guessing quietly is the
 * one behaviour worse than asking.
 */

/** How far ahead the winner must be before the answer counts as decided rather than preferred. */
export const MARGIN = 2;

const words = (text) =>
  String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter(Boolean);

/**
 * Does this phrase appear in the request?
 *
 * Whole words, so `pr` does not match `prompt` and `ci` does not match `decision`. A multi-word
 * phrase must appear in order and adjacent - "pull request" should not be satisfied by a sentence
 * containing "pull" in one clause and "request" in another, which is most sentences here.
 */
export function mentions(request, phrase) {
  const haystack = words(request);
  const needle = words(phrase);
  if (needle.length === 0) return false;
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    if (needle.every((w, j) => haystack[i + j] === w)) return true;
  }
  return false;
}

/**
 * Score one agent against a request.
 *
 * A phrase is worth its own length, so "pull request" beats a bare "review" - specific evidence
 * should outrank a word half the specs mention. `avoid` subtracts by the same measure, which is
 * how an agent says "this word will match me and it should not".
 */
export function scoreAgent(request, routing) {
  const matched = [];
  const against = [];
  let score = 0;

  for (const phrase of routing?.handles ?? []) {
    if (mentions(request, phrase)) {
      matched.push(phrase);
      score += words(phrase).length;
    }
  }
  for (const phrase of routing?.avoid ?? []) {
    if (mentions(request, phrase)) {
      against.push(phrase);
      score -= words(phrase).length;
    }
  }

  return { score, matched, against };
}

/**
 * Pick an agent, or decline to.
 *
 * `decided` is the only field a caller should act on without reading the rest. Everything else is
 * there so a person can disagree with the choice, which they must be able to do or the routing is
 * just a default with extra steps.
 */
export function route(request, agents) {
  const scored = agents
    .map((agent) => ({ name: agent.name, ...scoreAgent(request, agent.routing) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const [best, runnerUp] = scored;

  if (!best || best.score <= 0) {
    /**
     * Two different reasons for the same score, and saying the wrong one is worse than saying
     * nothing. The branch tests the net score; the message claimed nothing matched. A request like
     * "run a sql query about the incident deploy pull request" matches three agents and each of
     * them also says to avoid part of it, so every score nets to zero or below - and the runner
     * then printed "nothing matched" while suppressing the candidate list, because that list is
     * filtered to positive scores.
     */
    const touched = scored.filter((s) => s.matched.length > 0);
    return {
      decided: false,
      why: touched.length
        ? `${touched.map((t) => t.name).join(', ')} each matched something and each also says to avoid part of this`
        : 'nothing in the request matched what any agent says it handles',
      candidates: touched.length ? touched : scored.filter((s) => s.score > 0),
      scored,
    };
  }

  if (runnerUp && best.score - runnerUp.score < MARGIN) {
    const close = scored.filter((s) => s.score > best.score - MARGIN && s.score > 0);
    /**
     * Two different reasons to stop, and reporting them as the same one was wrong: a single agent
     * matching weakly is not a tie, and saying "these match about equally" about one agent is both
     * ungrammatical and a lie about what happened. The person is being asked in both cases, but
     * they can only answer well if they are told which case it is.
     */
    return {
      decided: false,
      why:
        close.length > 1
          ? `${close.map((t) => t.name).join(' and ')} match this about equally`
          : `only ${best.name} matched, and only on ${best.matched.map((m) => `"${m}"`).join(', ')}`,
      candidates: close,
      scored,
    };
  }

  return {
    decided: true,
    agent: best.name,
    why: `matched ${best.matched.map((m) => `"${m}"`).join(', ')}`,
    runnerUp: runnerUp?.score > 0 ? runnerUp.name : null,
    candidates: scored.filter((s) => s.score > 0),
    scored,
  };
}

/**
 * The specs, with their routing blocks.
 *
 * `routing` lives beside `manifest` rather than inside it, because the harness is sent the
 * manifest alone - so an agent can say what it handles without that becoming a field TrueForge has
 * to know about. A spec with no routing block is simply never routed to, which is the right
 * default: reaching it needs `--agent`, and nothing is picked by accident.
 */
export function loadAgents(dir = DEFAULT_AGENTS) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }

  const agents = [];
  for (const file of files) {
    try {
      const spec = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      agents.push({ name: spec?.name ?? file.replace(/\.json$/, ''), routing: spec?.routing ?? null });
    } catch {
      // Unreadable specs are the tool audit's problem to report, not the router's to crash on.
    }
  }
  return agents;
}
