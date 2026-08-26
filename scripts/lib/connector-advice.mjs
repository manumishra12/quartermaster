/**
 * What to tell somebody when a connector cannot be reached.
 *
 * Every failure here used to advise authenticating the connector. For a local server that is
 * simply not running - the usual case, since two of them ship in this repo and have to be started
 * - that is advice which cannot possibly work, sending someone to look for credentials for a
 * process they only needed to start.
 *
 * The first fix then over-corrected, which is worth recording because it is the same mistake in the
 * other direction: it grouped DNS failures, resets, timeouts and unreachable routes together with
 * refused connections and called all of them "nothing is listening at its URL". That would tell an
 * operator to start a server that is already running and answering, while throwing away the typed
 * cause they needed to see what was actually wrong.
 *
 * So: only a refused connection means nothing is listening. Everything else keeps its message and
 * gets advice matched to it, and a cause this cannot recognise says so rather than guessing.
 */

/** The servers this repo ships, so a connection failure can name the command that fixes it. */
export const LOCAL_SERVERS = {
  'ops-desk': 'npm run ops-desk',
  'front-desk': 'npm run front-desk',
};

/**
 * Ordered, because several of these appear together in one nested transport error. A refused
 * connection is checked first: it is the only one that means the port is empty.
 */
const CAUSES = [
  {
    id: 'refused',
    match: /ECONNREFUSED/i,
    reason: () => 'nothing is listening at its URL',
    advice: (local) =>
      local ? `start it: ${local}` : 'nothing is listening there - start the server, or check the URL in Settings - Connectors',
  },
  {
    id: 'dns',
    match: /ENOTFOUND|EAI_AGAIN/i,
    reason: (message) => `its host name does not resolve - ${message}`,
    advice: () => 'check the URL in Settings - Connectors',
  },
  {
    id: 'unreachable',
    match: /ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|timed? ?out/i,
    reason: (message) => `the host did not answer in time - ${message}`,
    advice: () => 'check the URL, and whether anything between you and it is blocking the route',
  },
  {
    id: 'reset',
    match: /ECONNRESET|socket hang up|EPIPE/i,
    reason: (message) => `the connection closed before it answered - ${message}`,
    advice: (local) =>
      local
        ? `something is listening but it dropped the connection - check the output of ${local}`
        : 'the server accepted the connection and then dropped it - check its logs',
  },
  {
    id: 'tls',
    match: /certificate|self.signed|TLS|SSL|DEPTH_ZERO/i,
    reason: (message) => `its certificate was rejected - ${message}`,
    advice: () => 'check the URL is https with a certificate this machine trusts',
  },
  {
    id: 'auth',
    match: /\b40[13]\b|unauthori[sz]ed|forbidden|token|credential|api[- ]?key/i,
    reason: (message) => message,
    advice: () => 'authenticate the connector, then re-run',
  },
];

/**
 * Classify a connector failure into something a person can act on.
 * Returns the reason to print and the advice to give, which are not the same thing.
 */
export function describeConnectorFailure(name, message) {
  const text = String(message ?? '').trim();
  const local = LOCAL_SERVERS[name];

  for (const cause of CAUSES) {
    if (cause.match.test(text)) {
      return { cause: cause.id, reason: cause.reason(text), advice: cause.advice(local) };
    }
  }

  /**
   * Unrecognised. `fetch failed` on its own arrives here, and it genuinely could be several
   * things - claiming to know which one is how the first version of this got it wrong.
   */
  return {
    cause: 'unknown',
    reason: text || 'it failed without saying why',
    advice: local
      ? `check that it is running (${local}) and reachable at the URL in Settings - Connectors`
      : 'check the URL and credentials in Settings - Connectors',
  };
}

/** Whether a failure means the port is empty. Only a refused connection does. */
export function isUnreachable(message = '') {
  return describeConnectorFailure(undefined, message).cause === 'refused';
}
