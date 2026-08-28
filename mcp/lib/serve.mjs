/**
 * The HTTP shell both fixture servers sit behind.
 *
 * It was copied between them, and so were its faults. The worst one was not visible from either
 * file: `listen(PORT)` with no host binds every interface, and these servers were verified
 * answering on the machine's LAN address -
 *
 *     curl http://192.168.0.120:8795/health   ->  200
 *
 * - which on conference wifi means a stranger can POST `rollback_deploy` straight at the server.
 * The approval gate that makes that tool safe lives in the *harness*. A request that never goes
 * through the harness never meets it. So the one demonstration this whole project is built around
 * could be walked past by anyone on the same network, and nothing in either server would have
 * noticed or recorded it.
 *
 * Loopback is therefore the default, and binding wider has to be asked for out loud.
 */

import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/** Names that mean "this machine", and so are the only Host values a loopback server should answer to. */
/**
 * Written as they arrive after the port is stripped. The unbracketed IPv6 spellings could never
 * match: the non-bracket branch splits on ':' and yields an empty string for both, so they were
 * two entries that looked like coverage and were not.
 */
const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "[0000:0000:0000:0000:0000:0000:0000:0001]",
]);

/**
 * Whether a Host header is one this server should answer.
 *
 * This is the DNS-rebinding check. A page in the user's browser can resolve a name it controls to
 * 127.0.0.1 and then post to it; the browser will not let the page *read* the reply cross-origin,
 * but a rollback does not need to be read to have happened. The Host header is what distinguishes
 * that request from a local one, because the attacker's page cannot forge it - it is set by the
 * browser from the address it was told to fetch.
 *
 * An absent Host is rejected rather than allowed. HTTP/1.1 requires one, and the only clients that
 * omit it here are not the harness.
 */
export function hostAllowed(header, extra = []) {
  if (typeof header !== "string" || !header.trim()) return false;

  // Strip the port, taking care not to cut an IPv6 literal in half: [::1]:8795 is host [::1].
  const value = header.trim();
  const host = value.startsWith("[")
    ? value.slice(0, value.indexOf("]") + 1)
    : value.split(":")[0];

  // The host is lower-cased, so what it is compared against has to be too: an operator who set
  // OPS_DESK_HOST=Ops.Internal was refused by their own allow-list.
  const wanted = host.toLowerCase();
  return (
    LOOPBACK_HOSTS.has(wanted) ||
    extra.some((allowed) => String(allowed).toLowerCase() === wanted)
  );
}

/**
 * The path, without the query string and without a trailing slash.
 *
 * `req.url.startsWith('/mcp')` was the old test, which routed `/mcp-anything` into the MCP handler
 * as well - verified, it answered 406 rather than 404. Nothing dangerous followed from it, but a
 * server that cannot say which of its own routes was asked for is not one to bolt an approval
 * story onto.
 */
export function routeOf(url) {
  try {
    const { pathname } = new URL(url ?? "/", "http://localhost");
    return pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  } catch {
    return null;
  }
}

/**
 * Start one of these servers.
 *
 * `tools` is the live list of registered names rather than a number typed into two places. Both
 * servers used to print a hand-written banner and report a hand-written count from /health, and
 * both were already one tool out of date - which is a small lie of exactly the kind this project
 * spends the rest of its time refusing.
 */
export function serve({
  name,
  buildServer,
  port,
  host,
  tools,
  extraHosts = [],
  describe,
}) {
  /**
   * The Host check guards loopback, and only loopback.
   *
   * It exists because a browser can reach 127.0.0.1 from a page an attacker controls, and Host is
   * the one part of that request the page cannot choose. An operator who has deliberately bound to
   * a wider address has opened the port on purpose: anyone who can reach it can reach it directly,
   * so refusing them on a header defends nothing and breaks exactly what they asked for. The first
   * version checked unconditionally, so setting the variable the 403 named bound the server wider
   * and then refused every request that arrived there - the health check included. An escape hatch
   * that does not open is worse than none.
   */
  const onLoopback = host === "127.0.0.1" || host === "::1";

  const http = createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (onLoopback && !hostAllowed(req.headers.host, extraHosts)) {
      // Said plainly, because the person who trips this is usually the operator reaching the
      // server from another machine, not an attacker.
      return send(403, {
        error: "forbidden_host",
        message: `${name} answers to localhost only. Set ${name.toUpperCase().replace(/-/g, "_")}_HOST to bind wider, and read why in the server source before you do.`,
        host: req.headers.host ?? null,
      });
    }

    const route = routeOf(req.url);

    if (route === "/mcp") {
      void (async () => {
        const server = buildServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        // Closing on the way out matters: without it every request leaks a transport and the
        // listeners attached to it, and a long investigation is a lot of requests.
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res);
        } catch (error) {
          // A transport failure must not take the process down and leave the agent on a dead socket.
          console.error(`${name} request failed:`, error);
          if (!res.headersSent)
            res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(error?.message ?? error) }));
        }
      })();
      return;
    }

    if (route === "/health")
      return send(200, {
        ok: true,
        tools: tools().length,
        ...(describe?.() ?? {}),
      });

    send(404, { error: "not_found", routes: ["/mcp", "/health"] });
  });

  /**
   * A port already in use is the ordinary case here, not an exceptional one. The README says to
   * start the server and then register the connector, so starting it twice is what happens when
   * somebody follows the instructions and forgets the first one is running. Without a listener
   * that is an unhandled 'error' event, which ends the process on a stack trace rather than a
   * sentence naming the one thing they need to do.
   */
  http.on("error", (error) => {
    if (error?.code === "EADDRINUSE") {
      console.error(
        `${name} cannot start: something is already listening on port ${port}.`,
      );
      console.error(
        "  If that is another copy of this server, use it - the state is in memory and",
      );
      console.error(
        "  a second copy would not share it. Otherwise pick another port:",
      );
      console.error(
        `  ${name.toUpperCase().replace(/-/g, "_")}_PORT=<other> npm run ${name}`,
      );
    } else {
      console.error(`${name} could not start:`, error?.message ?? error);
    }
    process.exit(1);
  });

  http.listen(port, host, () => {
    // With PORT=0 the OS assigns a free one, so report what we actually got rather than what we asked for.
    const bound = http.address().port;
    /**
     * Printed as `localhost` when bound to loopback, because that is the address every README,
     * every curl and the connector registration in this repo actually use. Announcing 127.0.0.1
     * instead is not more accurate to a reader - it is a second spelling of the same place, and it
     * silently stopped matching the URL the tests and the docs are written against.
     */
    const shown = host === "127.0.0.1" ? "localhost" : host;
    console.log(`${name} listening on http://${shown}:${bound}/mcp`);
    if (host !== "127.0.0.1") {
      console.log(
        `  WARNING: bound to ${host}, not loopback. Anything that can reach this port can call these tools`,
      );
      console.log(
        "  without ever passing the harness, and so without ever meeting the approval gate.",
      );
    }
    console.log(`  ${tools().length} tools: ${tools().join(", ")}`);
  });

  return http;
}
