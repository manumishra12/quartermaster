import { adviseOnFailure } from './model-advice.mjs';

/**
 * Whether to run a failed turn again, and how long to wait first.
 *
 * The runner already explained a 429 well and then stopped, which left a person re-running by hand
 * the one failure the message itself describes as temporary - "rate limiting by the minute" is a
 * thing that clears without anybody doing anything. Waiting is strictly better than asking.
 *
 * The rule that matters is the one about approvals. A turn that failed after somebody approved a
 * write may or may not have executed it: the call went out, the failure came back, and nothing on
 * this side can tell those two apart. Retrying is then a coin-flip on doing it twice - filing the
 * ticket twice, rolling back twice, sending the email twice. So an approved turn is never retried,
 * and the person is told why rather than being asked to trust a guess. This is the same reasoning
 * as the rest of the project: when the honest answer is "cannot tell", the system says so instead
 * of choosing the convenient reading.
 */

export const MAX_ATTEMPTS = 3;

/**
 * Base waits, which are not one number because the failures are not one failure. Backing off two
 * seconds against a per-minute rate limit just spends the attempts faster and arrives at the same
 * place, so the limit that is measured in minutes is waited out in something closer to one.
 */
const BASE_MS = { 'rate-limit': 30_000, 'provider-down': 2_000, timeout: 2_000 };
const DEFAULT_BASE_MS = 2_000;

/** A wait the provider asked for, if it named one. Its number beats any guess made here. */
export function statedDelay(message) {
  const text = String(message ?? '');
  const seconds =
    text.match(/retry[- ]?(?:after|delay)"?[:=]?\s*"?(\d+(?:\.\d+)?)s?\b/i)?.[1] ??
    text.match(/(?:try|retry) again in (\d+(?:\.\d+)?)\s*second/i)?.[1];
  if (!seconds) return null;
  const ms = Number(seconds) * 1000;
  // A provider asking for an hour is not a wait, it is a refusal wearing a delay.
  return Number.isFinite(ms) && ms > 0 && ms <= 120_000 ? ms : null;
}

/**
 * Decide, and say why either way.
 *
 * `random` is a parameter so the jitter can be pinned in a test. Jitter matters for the same
 * reason it always does - several runs failing together should not all come back at the same
 * instant - and an untestable delay is one nobody checks the bounds of.
 */
export function retryDecision({ failure, attempt = 1, approvals = 0, random = Math.random }) {
  if (approvals > 0) {
    return {
      retry: false,
      why: `something was approved in this turn, and a failed turn cannot say whether the approved call took effect - running it again risks doing it twice`,
    };
  }

  const advice = adviseOnFailure(failure);
  if (!advice) return { retry: false, why: 'the failure is not one that running it again would clear' };
  if (!advice.retryable) return { retry: false, why: advice.reason };

  if (attempt >= MAX_ATTEMPTS) {
    return { retry: false, why: `${advice.reason}, and it has already been tried ${attempt} times` };
  }

  const base = statedDelay(failure) ?? (BASE_MS[advice.cause] ?? DEFAULT_BASE_MS) * 2 ** (attempt - 1);
  // Jitter up to a quarter, so concurrent runs separate rather than arriving together again.
  const waitMs = Math.round(base * (1 + random() * 0.25));

  return { retry: true, waitMs, why: advice.reason, cause: advice.cause, attempt: attempt + 1 };
}
