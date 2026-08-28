/**
 * What to tell somebody when the model provider, rather than the agent, is what failed.
 *
 * The turn state carries the provider's own words and the runner printed them unchanged, which is
 * how a real run ended at:
 *
 *   Request failed (429): Quota exceeded for quota metric 'Generate Content API requests per
 *   minute' and limit 'GenerateContent request limit per minute for a region' of service
 *   'generativelanguage.googleapis.com' for consumer 'project_number:...'
 *
 * Everything needed to act on that is in the text, and none of it is easy to find: it is a
 * *per-minute* limit, so it clears on its own in under a minute. A daily quota is the same status
 * code, the same shape of sentence, and a completely different afternoon. Telling the two apart is
 * most of the value here.
 *
 * `connector-advice.mjs` is the same idea for connectors, and it records the mistake to avoid:
 * its first version grouped every failure under one confident cause and sent people to fix things
 * that were not broken. So the rule is the same one. Only what can actually be distinguished gets
 * distinguished, and a message this does not recognise keeps its text and says plainly that no
 * advice goes with it.
 */

/** The agent that needs no provider account at all, and so cannot hit any of this. */
const NO_ACCOUNT = 'npm run agent -- --agent quartermaster-local';

/**
 * Ordered. A rate limit is checked before the generic quota wording because Google's message
 * contains both, and the narrower reading is the one worth printing.
 */
const CAUSES = [
  {
    id: 'rate-limit',
    match: /\b429\b|too many requests|rate.?limit/i,
    /**
     * Per-minute and per-day are the same status code and want opposite responses, so the period
     * is read out of the message rather than assumed. When the provider does not say which it is,
     * this says it does not know instead of picking the cheerful one.
     */
    describe: (text) => {
      if (/per.?(?:minute|min\b)|\/min\b|requests per minute/i.test(text)) {
        return {
          reason: 'the provider is rate limiting by the minute',
          advice: `wait a minute and run it again - this one clears on its own. To keep working now, use the local model: ${NO_ACCOUNT}`,
        };
      }
      if (/per.?day|daily|24.?hour/i.test(text)) {
        return {
          reason: 'the daily quota for this key is used up',
          advice: `waiting will not clear this one before tomorrow - raise the quota, use another key, or run on the local model: ${NO_ACCOUNT}`,
        };
      }
      return {
        reason: 'the provider is refusing further requests for now',
        advice: `it does not say over what period, so try again shortly, and if it repeats immediately treat it as a quota rather than a burst. The local model has neither: ${NO_ACCOUNT}`,
      };
    },
  },
  {
    id: 'credentials',
    match: /\b40[13]\b|unauthori[sz]ed|invalid.{0,12}(?:api.?key|token|credential)|api.?key not valid|permission denied/i,
    reason: 'the provider rejected the key',
    advice:
      'the key configured in the harness is wrong, expired, or not entitled to this model. Replace it in Settings - Model providers. Do not put it in this repository.',
  },
  {
    id: 'unknown-model',
    /**
     * Worth its own case because the mistake behind it is nearly always the same one, and TOOLS.md
     * documents it: TrueForge model FQNs are written with dashes, so `anthropic/claude-sonnet-4-6`
     * and not `anthropic/claude-sonnet-4.6`.
     */
    match: /model.{0,20}not (?:be )?found|unknown model|no such model|does not exist|unsupported model/i,
    reason: 'the provider does not recognise the model name',
    advice:
      'check the FQN against `npm run preflight`, which lists what is actually configured. TrueForge writes versions with dashes, not dots.',
  },
  {
    id: 'too-long',
    match: /context.{0,12}(?:length|window)|maximum context|too many tokens|prompt is too long|reduce the length/i,
    reason: 'the turn outgrew the model context window',
    advice:
      'lower iteration_limit in the spec so the turn ends sooner, or give the agent a narrower task. A long turn is usually an agent re-reading things it already has.',
  },
  {
    id: 'provider-down',
    match: /\b5\d\d\b|overloaded|service unavailable|internal (?:server )?error|temporarily unavailable/i,
    reason: 'the provider failed on its side',
    advice: 'nothing here is wrong - run it again. If it repeats for several minutes, check the provider status page.',
  },
  {
    id: 'timeout',
    match: /timed? ?out|deadline exceeded|ETIMEDOUT/i,
    reason: 'the provider did not answer in time',
    advice: 'run it again. A turn that times out repeatedly is usually one asking for more work than fits in a single turn.',
  },
];

/**
 * Classify a turn failure into something a person can act on, or say that it cannot be.
 * Returns null when there is nothing to classify, so a caller can print the message unchanged.
 */
export function adviseOnFailure(message) {
  const text = String(message ?? '').trim();
  if (!text) return null;

  for (const cause of CAUSES) {
    if (!cause.match.test(text)) continue;
    const described = cause.describe ? cause.describe(text) : cause;
    return { cause: cause.id, reason: described.reason, advice: described.advice };
  }

  /**
   * An agent that ran out of iterations, a tool that threw, a bug in this repository - most turn
   * failures are not the provider's doing and have no generic advice worth printing. Saying so is
   * the honest answer; inventing a suggestion here is how the connector version got it wrong.
   */
  return null;
}

/** The failure and its advice as the two lines the runner prints, or just the failure. */
export function explainFailure(message) {
  const advice = adviseOnFailure(message);
  if (!advice) return String(message ?? '').trim() || null;
  return `${String(message).trim()}\n  ${advice.reason} - ${advice.advice}`;
}
