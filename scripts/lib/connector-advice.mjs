/**
 * What to tell somebody when a connector cannot be reached.
 *
 * Every failure here used to advise authenticating the connector. For a local server that simply
 * is not running - the usual case, since two of them ship in this repo and have to be started -
 * that is advice which cannot possibly work, sending someone to look for credentials for a process
 * they only needed to start.
 *
 * Being confidently unhelpful is the failure this whole project is about. It does not get a pass
 * in the tool that checks for it.
 */

/** The servers this repo ships, so a connection failure can name the command that fixes it. */
export const LOCAL_SERVERS = {
  'ops-desk': 'npm run ops-desk',
  'front-desk': 'npm run front-desk',
};

/** Whether the message describes a connection that never landed, rather than one that was refused. */
export function isUnreachable(message = '') {
  return /ECONNREFUSED|fetch failed|ENOTFOUND|ECONNRESET|socket hang up|EHOSTUNREACH|ETIMEDOUT/i.test(
    String(message),
  );
}

export function connectorAdvice(name, message) {
  if (!isUnreachable(message)) return 'authenticate the connector, then re-run';

  const local = LOCAL_SERVERS[name];
  return local
    ? `start it: ${local}`
    : 'the server at its URL is not reachable - start it, or check the URL in Settings - Connectors';
}

/** What to print as the reason, which is not the same thing as what to do about it. */
export function connectorReason(message) {
  return isUnreachable(message) ? 'nothing is listening at its URL' : String(message);
}
