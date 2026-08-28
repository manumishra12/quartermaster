#!/usr/bin/env python3
"""Reproduces ALRT-4471, and shows what the rollback of 4c21 does about it.

Standard library only - no install step, no network, nothing to clean up. It stands up a stub
payment gateway on loopback that takes the 2.4 seconds the real one has always taken, and calls it
with the timeout the named deploy configured:

    python3 repro.py --deploy 4c21     # what production is running: times out, exits 1
    python3 repro.py --deploy 9ab7     # what a rollback returns to: succeeds, exits 0
    python3 repro.py --both            # both, and checks that the pair still holds

The pair is the point. A run that fails proves a failure; only a run that fails in one
configuration and passes in the other proves which of the two things that changed was the cause.
The incident has two explanations that fit the metrics equally well - the gateway got slower, or
the budget was cut below what the gateway takes - and this holds the gateway still so only the
budget moves.
"""

import argparse
import http.server
import json
import socket
import sys
import threading
import time
import urllib.error
import urllib.request

# What the gateway takes, read off the log lines either side of the deploy: 2404ms and 2371ms
# before it, 2412ms and 2455ms after. It never changed, which is the whole finding.
UPSTREAM_MS = 2400

# The client timeout each deploy shipped. 4c21's summary on the ops desk says "Reduce
# payment-gateway client timeout from 5000ms to 2000ms"; 9ab7 is what it replaced.
TIMEOUTS = {"4c21": 2000, "9ab7": 5000}


class Gateway(http.server.BaseHTTPRequestHandler):
    """The upstream, slow and entirely healthy - which is the part a repro has to get right."""

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        # Drained before the sleep. A request body left in the socket buffer is a reset on some
        # platforms, and a connection reset would fail the 9ab7 run for a reason that is not the one
        # under test.
        self.rfile.read(length)
        time.sleep(UPSTREAM_MS / 1000)

        body = json.dumps({"status": "captured"}).encode()
        try:
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # The client hanging up before this lands is the reproduction working. Letting it print
            # a traceback would put a stack trace in the output of the run that is meant to fail,
            # where it reads as the fixture being broken rather than the incident being reproduced.
            pass

    def log_message(self, *args):
        """Silenced, so the only thing on stdout is the result of the call."""


class Upstream(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # Narrowly, and only for the client going away. Swallowing everything here would hide a real
        # fault in this file behind a fixture that appears to work.
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


def charge(port, timeout_ms):
    """One call to the gateway. Returns whether it completed, and how long it took."""
    started = time.monotonic()
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/charge", data=b"{}", timeout=timeout_ms / 1000
        ) as response:
            response.read()
        return True, round((time.monotonic() - started) * 1000)
    except (TimeoutError, socket.timeout, urllib.error.URLError) as error:
        # urllib wraps the socket's timeout in a URLError, so the reason is what has to be examined.
        # Catching URLError alone would report a refused connection - a fixture that never started -
        # as the timeout this is trying to demonstrate.
        #
        # socket.timeout is named here as well as in the isinstance below, and leaving it out of
        # this tuple was a live break rather than a portability nicety. On 3.10 and later it is an
        # alias of TimeoutError and the tuple reads as redundant; on 3.9 it is a separate OSError
        # subclass, and urllib only wraps the request - the timeout actually fires later, inside
        # getresponse, and escapes unwrapped. Stock macOS still ships 3.9.6 at /usr/bin/python3, so
        # this died on a traceback and took `npm run check` with it for anyone who had not installed
        # their own Python.
        reason = getattr(error, "reason", error)
        if not isinstance(reason, (TimeoutError, socket.timeout)):
            raise
        return False, round((time.monotonic() - started) * 1000)


def run(deploy, port):
    """Call the gateway as the given deploy would, and say what happened in the log's own words."""
    timeout_ms = TIMEOUTS[deploy]
    completed, elapsed = charge(port, timeout_ms)
    if completed:
        print(f"{deploy}  payment-gateway answered in {elapsed}ms, inside the {timeout_ms}ms budget")
    else:
        print(
            f"{deploy}  UpstreamTimeout: payment-gateway did not respond within {timeout_ms}ms; "
            f"the gateway needs about {UPSTREAM_MS}ms and always has"
        )
    return completed


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--deploy",
        choices=sorted(TIMEOUTS),
        default="4c21",
        help="which deploy's client timeout to call with (default: 4c21, what production is running)",
    )
    parser.add_argument(
        "--both",
        action="store_true",
        help="run 4c21 then 9ab7 and check that the first still fails and the second still passes",
    )
    args = parser.parse_args(argv)

    # Port 0, so a stray copy of this script cannot collide with a running one and report a
    # connection error as an incident.
    server = Upstream(("127.0.0.1", 0), Gateway)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    try:
        if not args.both:
            return 0 if run(args.deploy, port) else 1

        before = run("4c21", port)
        after = run("9ab7", port)
        if not before and after:
            print("reproduced on 4c21, recovered on 9ab7")
            return 0

        # Named separately, because the two ways this pair can stop holding send you to different
        # places. A 4c21 that passes means the numbers no longer describe the incident; a 9ab7 that
        # fails usually means this machine is loaded enough to lose 2.6 seconds of slack.
        if before:
            print("4c21 no longer times out - the timeout and the upstream latency no longer disagree")
        if not after:
            print("9ab7 did not complete inside 5000ms, which is a slow machine rather than a finding")
        return 1
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
