/**
 * What to tell somebody when a connector cannot be reached.
 *
 * Every failure here used to advise authenticating the connector. For a local server that is
 * simply not running - the usual case, since three of them ship in this repo and have to be
 * started - that is advice which cannot possibly work, sending someone to look for credentials for
 * a process they only needed to start.
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
  'ops-desk': { command: 'npm run ops-desk', port: 8795, portEnv: 'OPS_DESK_PORT' },
  'front-desk': { command: 'npm run front-desk', port: 8796, portEnv: 'FRONT_DESK_PORT' },
  warehouse: { command: 'npm run warehouse', port: 8797, portEnv: 'WAREHOUSE_PORT' },
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * The command that would start *this* connector, or nothing.
 *
 * A name is not enough. A connector called ops-desk could be a deployment of this server on
 * somebody else's host, or the same server on a different port - and in both cases `npm run
 * ops-desk` starts an unrelated process on the default port while the configured one stays exactly
 * as unreachable as it was. The URL has to agree before the command is offered, and when the port
 * differs the command carries that port rather than quietly using another.
 */
function startCommand(name, url) {
  const server = LOCAL_SERVERS[name];
  if (!server || !url) return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // An address this cannot read is not one it may claim to know how to start.
    return null;
  }

  if (!LOOPBACK.has(parsed.hostname)) return null;

  const port = Number(parsed.port);
  if (!port || port === server.port) return server.command;
  return `${server.portEnv}=${port} ${server.command}`;
}

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
export function describeConnectorFailure(name, message, url) {
  const text = String(message ?? '').trim();
  const local = startCommand(name, url);

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
