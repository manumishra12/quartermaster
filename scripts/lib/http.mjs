/**
 * Whether a response is a body worth reading, or an error page pretending to be one.
 *
 * The tool audit called `res.json()` and looked for an `error` field. A server answering 404 or 502
 * does not always put one there - `{"message":"not found"}` and `{"detail":"unauthorised"}` both
 * parse cleanly - and what came back was then walked as the list of tools a connector publishes.
 * An empty list is indistinguishable from a connector with nothing risky on it, so the audit's
 * closing line was "nothing runs ungated" about a server it had never read.
 *
 * That is the reassuring falsehood this whole script exists to catch elsewhere, sitting in the
 * script. The status is checked first, and a status that is not a success is a connector we could
 * not audit rather than a connector we cleared.
 */
export function httpProblem(res, path = '') {
  if (res?.ok) return null;
  const where = path ? `${path}: ` : '';
  const status = res?.status ?? 'no status';
  const statusText = res?.statusText ? ` ${res.statusText}` : '';
  return `${where}HTTP ${status}${statusText}`;
}
