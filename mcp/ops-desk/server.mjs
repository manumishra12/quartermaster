#!/usr/bin/env node
/**
 * Ops Desk - a small operations surface for the incident responder to investigate.
 *
 * The incident responder was written against Sentry and could not be applied at all without a
 * Sentry account, so the one agent the hackathon calls its hero project was the one nobody could
 * run. This exists so that stops being true: it is the same shape of surface - alerts you can read,
 * logs you can search, deploys you can correlate them both against, and remediations you cannot
 * take without a person saying yes - backed by a fixture rather than a company's production estate.
 *
 * It is deliberately not a mock in the testing sense. The read tools return the fixture; the write
 * tools genuinely mutate state and genuinely cannot be undone from inside this process, because an
 * approval gate in front of an operation that does nothing proves nothing.
 *
 * Every tool publishes annotations. That matters more here than anywhere else in the project: the
 * approval selectors `@read-only`, `@write` and `@destructive` are resolved from these hints, and
 * the catalog's own deepwiki server publishes none - which is the fail-open hole SECURITY.md
 * describes. This server is what a correctly annotated one looks like.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serve } from "../lib/serve.mjs";
import { z } from "zod";

const FIXTURE = fileURLToPath(new URL("./incidents.json", import.meta.url));
/**
 * The port every instruction in this repo names. A default that disagrees with the documentation
 * sends anyone following it to a health check that fails and a connector registered at a dead URL.
 */
const PORT = Number(process.env.OPS_DESK_PORT ?? 8795);

/**
 * Loopback, unless someone says otherwise in as many words.
 *
 * These tools are gated by the harness, not by this server. A request that arrives here
 * directly has not passed the gate and will not meet it, so who can reach this port is the
 * whole of the access control. Binding every interface - which is what listen(PORT) alone
 * does - hands that to everyone on the network.
 */
const HOST = process.env.OPS_DESK_HOST ?? "127.0.0.1";

/** Loaded once and then mutated in memory: a rollback has to actually change what the next read sees. */
const state = JSON.parse(readFileSync(FIXTURE, "utf8"));
const journal = [];

/**
 * Whether a field was actually given.
 *
 * A string of spaces satisfies every truthiness check and is not a reason. front-desk has always
 * refused one; this desk accepted `reason: "   "` and wrote it into the journal as the
 * justification for restarting a production service. The record then reads as though somebody
 * explained themselves, which is worse than an obviously missing field.
 */
const given = (value) => typeof value === "string" && value.trim().length > 0;

/**
 * A bound on anything stored, because nothing else bounded it.
 *
 * 100k characters of reason was accepted and kept. Long before that is a problem for this process
 * it is a problem for whoever reads the journal, and a reason nobody can read is not a reason.
 * Generous enough that no honest use meets it.
 */
const REASON = z.string().max(2000);
const ID = z.string().max(200);

/**
 * The levels this desk actually keeps, rather than the levels logging libraries usually offer.
 *
 * `debug` and `trace` were in the enum first and match nothing in the fixture, so asking for them
 * returned an empty list that reads exactly like a quiet service. An enum that names what is here
 * turns that into a schema refusal, which is a fact about the desk rather than a fact about the
 * incident.
 */
const LEVELS = ["info", "warn", "error"];

/** Long enough for any timestamp anybody writes, short enough that nothing is stored from it. */
const WHEN = z.string().max(40);

/**
 * The desk's clock, which has to move.
 *
 * `state.now` was a constant, so every remediation in the journal carried the same timestamp and
 * the record read as though a rollback, a restart and another rollback all happened in the same
 * instant. The order in which somebody did things to a production service is most of what a
 * timeline is for. A minute per action is arbitrary and honest; this is a fixture, and it says so.
 */
function tick() {
  state.now = new Date(Date.parse(state.now) + 60_000)
    .toISOString()
    .replace(".000Z", "Z");
  return state.now;
}

/** What a service is running now: the newest deploy for it. */
function currentDeploy(service) {
  return state.deploys
    .filter((d) => d.service === service)
    .sort((a, b) => b.shipped_at.localeCompare(a.shipped_at))[0];
}

const text = (value) => ({
  content: [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

/**
 * A fresh server and transport per request.
 *
 * Sharing one transport across requests returns 500 on the very first `initialize`: a stateless
 * transport has no session to attach a second exchange to, so the connection the harness opens
 * has nowhere to live. The state these tools read and mutate is module-level and outlives them,
 * which is what makes a rollback in one request visible to the next.
 */
/**
 * Every registered name, collected as they register.
 *
 * The startup banner and /health both used to carry a hand-written list and a hand-written
 * count. Both drift, and a server that misreports its own surface is a poor place to stand an
 * argument about honest reporting on.
 */
const registered = new Set();

const register = (server, name, meta, handler) => {
  registered.add(name);
  return server.registerTool(name, meta, handler);
};

function buildServer() {
  const server = new McpServer({ name: "ops-desk", version: "1.0.0" });

  register(
    server,
    "list_alerts",
    {
      title: "List alerts",
      description: "Every alert the desk knows about, firing or resolved.",
      inputSchema: { status: z.enum(["firing", "resolved", "all"]).optional() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ status = "all" }) => {
      const alerts = state.alerts.filter(
        (a) => status === "all" || a.status === status,
      );
      return text({ now: state.now, count: alerts.length, alerts });
    },
  );

  register(
    server,
    "get_alert",
    {
      title: "Read one alert",
      description:
        "Full detail for a single alert, including when it started and a sample error.",
      inputSchema: { alert_id: z.string() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ alert_id }) => {
      const alert = state.alerts.find((a) => a.id === alert_id);
      // An unknown id is a fact about the world, not a crash. It is also still JSON: a tool that
      // answers with an object on the happy path and prose on the sad one makes every caller parse
      // twice, and the one place that matters is an agent deciding what it just learned.
      return alert
        ? text(alert)
        : text({
            error: "not_found",
            message: `No alert with id ${alert_id}.`,
            known: state.alerts.map((a) => a.id),
          });
    },
  );

  register(
    server,
    "list_deploys",
    {
      title: "List recent deploys",
      description:
        "Recent deploys, newest first, so an alert can be correlated with what shipped.",
      inputSchema: { service: z.string().optional() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ service }) => {
      const deploys = state.deploys
        .filter((d) => !service || d.service === service)
        .sort((a, b) => b.shipped_at.localeCompare(a.shipped_at));
      return text({ now: state.now, count: deploys.length, deploys });
    },
  );

  register(
    server,
    "get_service_health",
    {
      title: "Read service health",
      description:
        "Error rate and p99 latency over the recent window for one service.",
      inputSchema: { service: z.string() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ service }) => {
      /**
       * Object.hasOwn, not a truthiness check on the lookup.
       *
       * `state.health["constructor"]` is a function inherited from Object.prototype, which is
       * truthy - so this answered `{"service":"constructor"}` with a series that is not a series
       * and no error at all. Every name on the prototype chain did it: toString, valueOf,
       * hasOwnProperty, __proto__.
       */
      if (!Object.hasOwn(state.health, service)) {
        return text({
          error: "not_found",
          message: `No health series for ${service}.`,
          known: Object.keys(state.health),
        });
      }
      return text({ service, series: state.health[service] });
    },
  );

  register(
    server,
    "search_logs",
    {
      title: "Search a service's logs",
      description:
        "Log lines for one service, narrowed by time window, level and substring. An empty result means nothing matched the filter, not that the service was quiet.",
      inputSchema: {
        service: ID,
        since: WHEN.optional(),
        until: WHEN.optional(),
        level: z.enum(LEVELS).optional(),
        contains: z.string().max(200).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ service, since, until, level, contains }) => {
      /**
       * The read the responder was missing, and the one that separates two remediations.
       *
       * Health says the error rate moved and deploys says what shipped near it. Neither says what
       * the service was doing, so an investigation could name a suspect without ever seeing the
       * failure in its own words - and the two explanations that fit those numbers want opposite
       * actions. "The upstream got slower" is somebody else's page; "we cut the budget below what
       * the upstream has always taken" is a rollback. The lines here carry the upstream's own
       * latency either side of the deploy, which is what tells those apart.
       */
      // Object.hasOwn, for the reason get_service_health gives above: every name on
      // Object.prototype is truthy, and answering for `constructor` with an empty list would read
      // as a service this desk watches and found nothing wrong with.
      if (!Object.hasOwn(state.logs, service)) {
        return text({
          error: "not_found",
          message: `This desk keeps no logs for ${service}.`,
          known: Object.keys(state.logs),
        });
      }

      /**
       * A window that does not parse is refused, not ignored.
       *
       * The first version compared the ISO strings directly, so `since: "14:00"` - which is how a
       * person says it, and therefore how a model says it - sorted below every line in the file
       * and the tool answered with all of them. A filter that is silently dropped answers a
       * question nobody asked, and the reply still looks like a searched window that came back busy.
       */
      const bounds = {};
      for (const [field, value] of [
        ["since", since],
        ["until", until],
      ]) {
        if (value === undefined) continue;
        const parsed = Date.parse(value);
        if (Number.isNaN(parsed)) {
          return text({
            error: "bad_timestamp",
            message: `${field} was ${JSON.stringify(value)}, which is not a time this desk can read. Nothing was searched, because a window that is quietly dropped answers with every line there is.`,
            field,
            example: state.now,
          });
        }
        bounds[field] = parsed;
      }

      /**
       * Backwards is refused rather than answered with nothing.
       *
       * `since` after `until` matches no line, and "no matching lines" is exactly what an
       * investigation reads as "the service was quiet then". Naming the mistake costs a call;
       * hiding it inside an empty list costs the root cause.
       */
      if (
        bounds.since !== undefined &&
        bounds.until !== undefined &&
        bounds.since > bounds.until
      ) {
        return text({
          error: "bad_window",
          message: `since (${since}) is after until (${until}). No line can be in that window, and an empty result would read as a quiet service.`,
        });
      }

      /**
       * Case-insensitive, because the alternative fails silently and in the wrong direction.
       *
       * The sample error on ALRT-4471 says `UpstreamTimeout`; a responder that reasonably searches
       * for `timeout` got nothing back from a service whose logs are nothing but timeouts.
       */
      const needle = contains?.toLowerCase();
      const held = state.logs[service];
      const lines = held.filter((entry) => {
        const at = Date.parse(entry.at);
        if (bounds.since !== undefined && at < bounds.since) return false;
        if (bounds.until !== undefined && at > bounds.until) return false;
        if (level && entry.level !== level) return false;
        return !needle || entry.message.toLowerCase().includes(needle);
      });

      return text({
        service,
        now: state.now,
        // What was asked for, echoed back beside how many lines the service has at all. `matched: 0`
        // on its own reads as a quiet service; `matched: 0` beside `held: 12` reads as a filter that
        // excluded everything, which is the true statement and a different next move.
        searched: {
          since: since ?? null,
          until: until ?? null,
          level: level ?? null,
          contains: contains ?? null,
        },
        held: held.length,
        matched: lines.length,
        lines,
      });
    },
  );

  register(
    server,
    "rollback_deploy",
    {
      title: "Roll back a deploy",
      description:
        "Revert a service to the deploy that preceded the given one. This is not reversible from here.",
      inputSchema: { deploy_id: ID, reason: REASON },
      // The hint that puts this behind the gate. Getting it wrong is the whole failure mode.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ deploy_id, reason }) => {
      const deploy = state.deploys.find((d) => d.id === deploy_id);
      if (!deploy) {
        return text({
          error: "not_found",
          message: `No deploy with id ${deploy_id}.`,
          known: state.deploys.map((d) => d.id),
        });
      }

      /**
       * Only what is running can be reverted.
       *
       * Rolling back an older deploy used to remove it and report that the service had returned to
       * whatever preceded *it*, while the deploy actually serving traffic carried on untouched.
       * That is a reassuring operator-facing record of something that did not happen - the precise
       * failure this project exists to refuse, sitting in the tool it demonstrates with.
       */
      const current = currentDeploy(deploy.service);
      if (current.id !== deploy_id) {
        return text({
          error: "not_current",
          message: `${deploy_id} is not what ${deploy.service} is running; ${current.id} is. Rolling it back would change nothing and say otherwise.`,
          current: current.id,
        });
      }

      if (!given(reason)) {
        return text({
          error: "missing_reason",
          message:
            "A rollback needs a reason. Whitespace is not one, and it lands in the journal as though it were.",
        });
      }

      /**
       * You cannot honestly report a revert to a version you have no record of.
       *
       * Rolling back 4c21 reverts to 9ab7, which this desk knows. Rolling back 9ab7 then reported
       * `ok: true, to: "77f0"` - a deploy that appears nowhere in the fixture - and left the
       * timeline empty. A responder reading that would believe checkout-api was serving 77f0.
       * Nothing was serving anything. Two rollbacks is not an exotic path; it is what happens when
       * the first one does not help.
       */
      const previous = deploy.previous
        ? state.deploys.find((d) => d.id === deploy.previous)
        : null;
      if (!previous) {
        return text({
          error: "unknown_previous",
          message:
            `${deploy_id} names ${deploy.previous ?? "no"} previous deploy, and this desk has no record of it. ` +
            "Rolling back would leave the service on a version nobody here can describe, so it is refused rather " +
            "than reported as a revert to something imaginary.",
          previous: deploy.previous ?? null,
          known: state.deploys.map((d) => d.id),
        });
      }

      // Actually mutate. A gate in front of an operation that does nothing proves nothing.
      state.deploys = state.deploys.filter((d) => d.id !== deploy_id);
      const entry = {
        action: "rollback_deploy",
        deploy_id,
        service: deploy.service,
        to: previous.id,
        reason,
        at: tick(),
      };
      journal.push(entry);
      return text({
        ok: true,
        ...entry,
        note: "The deploy is gone from the timeline. This process cannot put it back.",
      });
    },
  );

  register(
    server,
    "restart_service",
    {
      title: "Restart a service",
      description:
        "Restart every instance of a service. In-flight requests are dropped.",
      inputSchema: { service: ID, reason: REASON },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ service, reason }) => {
      /**
       * A typo is not a restart.
       *
       * Any name at all used to come back `ok: true` with "Instances cycled", and the empty health
       * series it created then read back as a real service to everything downstream. An operator
       * approving a restart of `checkout-ap` would have been told it worked.
       */
      if (!Object.hasOwn(state.health, service)) {
        return text({
          error: "not_found",
          message: `This desk does not know a service called ${service}. Nothing was restarted.`,
          known: Object.keys(state.health),
        });
      }

      if (!given(reason)) {
        return text({
          error: "missing_reason",
          message:
            "A restart needs a reason. Whitespace is not one, and it lands in the journal as though it were.",
        });
      }

      const entry = {
        action: "restart_service",
        service,
        reason,
        at: tick(),
      };
      journal.push(entry);
      // Health readings do not survive a restart, which is part of why it is not a free action.
      state.health[service] = [];
      return text({
        ok: true,
        ...entry,
        note: "Instances cycled. The health series for this service was reset.",
      });
    },
  );

  register(
    server,
    "resolve_alert",
    {
      title: "Resolve an alert",
      description:
        "Mark an alert resolved, with the reason. The on-call rotation stops watching it.",
      inputSchema: { alert_id: ID, resolution: REASON },
      /**
       * Destructive, and the annotation is not a formality.
       *
       * Resolving is the one remediation that changes nothing about the system and everything
       * about who is looking at it. An alert resolved while the problem is live is worse than an
       * alert nobody resolved: the page stops, the rotation moves on, and the thing it was
       * watching carries on failing unobserved. There is no undo for the attention.
       */
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ alert_id, resolution }) => {
      const alert = state.alerts.find((a) => a.id === alert_id);
      if (!alert) {
        return text({
          error: "not_found",
          message: `No alert with id ${alert_id}. Nothing was resolved.`,
          known: state.alerts.map((a) => a.id),
        });
      }

      if (!given(resolution)) {
        return text({
          error: "missing_reason",
          message:
            "Resolving an alert needs a reason. It is the only record of why somebody stopped watching.",
        });
      }

      if (alert.status === "resolved") {
        return text({
          error: "already_resolved",
          message: `${alert_id} is already resolved. Resolving it again would change nothing and say otherwise.`,
        });
      }

      /**
       * The check that makes this tool worth having.
       *
       * You cannot honestly resolve an alert while the thing it watches is still bad. An agent
       * that has just proposed a rollback is exactly the agent most likely to resolve the alert in
       * the same breath - before any evidence that the rollback helped - and the fixture should
       * refuse that rather than reward it. The gate would have asked a person either way; this is
       * the server declining to offer them a decision founded on nothing.
       */
      const series = Object.hasOwn(state.health, alert.service)
        ? state.health[alert.service]
        : [];
      const latest = series[series.length - 1];

      /**
       * No readings is not a recovered service.
       *
       * `restart_service` empties the health series - which is honest, the readings really do not
       * survive a restart - and this check used to skip entirely when there was nothing to read.
       * So restarting first walked straight through it, and that is not an exotic order: it is
       * exactly what an agent does when its first remediation is a restart. Two gated calls, both
       * approved, and the second one reporting an incident closed on the evidence of a series that
       * had been deleted by the first.
       *
       * A desk that cannot see the service cannot say it recovered.
       */
      if (!latest) {
        return text({
          error: "no_readings",
          message:
            `There are no health readings for ${alert.service} - a restart clears them - so this desk cannot ` +
            "see whether it recovered. Wait for the series to refill and read it before resolving.",
          service: alert.service,
        });
      }

      if (latest.error_rate > 0.01) {
        return text({
          error: "still_unhealthy",
          message:
            `${alert.service} is still at ${(latest.error_rate * 100).toFixed(1)}% errors as of ${latest.at}. ` +
            "Resolving now would stop the rotation watching a service that is still failing. " +
            "Fix it, confirm the health series has recovered, then resolve.",
          error_rate: latest.error_rate,
          at: latest.at,
        });
      }

      alert.status = "resolved";
      alert.resolved_at = tick();
      alert.resolution = resolution;
      const entry = {
        action: "resolve_alert",
        alert_id,
        service: alert.service,
        reason: resolution,
        at: alert.resolved_at,
      };
      journal.push(entry);
      return text({
        ok: true,
        ...entry,
        note: "Resolved. The rotation stops watching it, and this desk cannot reopen it.",
      });
    },
  );

  register(
    server,
    "list_actions_taken",
    {
      title: "What this desk has done",
      description: "The remediations performed in this session, in order.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => text({ count: journal.length, actions: journal }),
  );

  return server;
}

serve({
  name: "ops-desk",
  buildServer,
  port: PORT,
  host: HOST,
  // Read from the registry rather than restated, so the banner and /health cannot drift
  // from what is actually registered. Building one server populates it.
  tools: () => {
    if (registered.size === 0) buildServer();
    return [...registered];
  },
  describe: () => ({
    actions: journal.length,
  }),
});
