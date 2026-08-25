/**
 * Call `fn`, retrying on failure.
 *
 * `attempts` is the total number of times `fn` may be called, not the number of retries after
 * the first call. If every attempt fails, the last error is thrown.
 */
export async function retry(fn, attempts = 3, { onAttempt } = {}) {
  if (attempts < 1) throw new RangeError('attempts must be at least 1');

  let lastError;
  for (let i = 1; i < attempts; i++) {
    try {
      onAttempt?.(i);
      return await fn(i);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
