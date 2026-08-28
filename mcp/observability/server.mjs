#!/usr/bin/env node
/**
 * Observability - a Grafana-shaped read-only metrics surface for the incident responder.
 *
 * ops-desk gave that agent alerts, logs and deploys, and it was enough to name a suspect. It was
 * not enough to convict one. `get_service_health` returns five readings ten minutes apart, so the
 * strongest thing the agent could say about a latency regression was that a log line mentioned it.
 * "The error rate is up" was a quotation, never a reading.
 *
 * What an investigation actually needs is the pairing this server exists to make possible: a time
 * series with a step change in it, and a deploy marker sitting on the same minute. An annotation at
 * 13:58 named "deploy 4c21" beside a p99 series that goes from 305ms to 1980ms between 13:58 and
 * 14:00 is the whole finding. Neither half says anything on its own.
 *
 * TrueForge's catalog ships no Grafana, Prometheus or Loki - the fourteen servers are github,
 * linear, notion, sentry, jira, confluence, supabase, stripe, posthog, exa, tavily, deepwiki,
 * parallel-web and bright-data - so this is built here, the same way ops-desk and front-desk were.
 *
 * WHAT THIS SERVER IS ARRANGED AGAINST
 *
 * Every tool is a read, so there is no false success to guard against; a read cannot report doing
 * something it did not do. The failure mode here is the other one, and it is worse for being
 * quiet: a partial answer that looks complete. Three shapes of it, each with a check below.
 *
 *   1. A window wider than the retained data, served as the points that happened to exist. Ask for
 *      the last six hours of a store that keeps two, and a series that begins at 12:00 reads as a
 *      metric that was flat until then. `query_range` serves the overlap and says what it could
 *      not serve, and a window with no overlap at all is an error rather than an empty list.
 *   2. A step coarser than the scrape interval, averaged. You cannot average percentiles: the p99
 *      of two minutes joined is not the mean of the two p99s, and taking the mean is how a 2000ms
 *      spike becomes a 1150ms wobble that nobody investigates. Percentile metrics are downsampled
 *      by max, and the reply says so every time rather than in the documentation.
 *   3. A comparison against a window with nothing in it. This is the one that matters for the last
 *      step of an investigation. "It recovered" is a claim about a time series, and after a
 *      rollback the honest state of this fixture is that no reading exists yet - so
 *      `compare_windows` refuses to compute a ratio rather than dividing by a window it never had.
 *      ops-desk's `resolve_alert` refuses `no_readings` for the same reason.
 *
 * Every tool publishes annotations. That matters more here than the tools do: the approval
 * selectors `@read-only`, `@write` and `@destructive` are resolved from these hints, so a tool
 * publishing none matches no selector and runs ungated. That is this project's headline upstream
 * finding, and a server added after it was made would be a poor place to repeat it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serve } from "../lib/serve.mjs";
import { z } from "zod";

const FIXTURE = fileURLToPath(new URL("./metrics.json", import.meta.url));

/**
 * The port every instruction in this repo names, following ops-desk on 8795, front-desk on 8796
 * and warehouse on 8797. A default that disagrees with the documentation sends anyone following it
 * to a health check that fails and a connector registered at a dead URL.
 */
const PORT = Number(process.env.OBSERVABILITY_PORT ?? 8798);

/**
 * Loopback, unless someone says otherwise in as many words.
 *
 * Nothing here writes, so binding wide does not hand anyone a rollback. It hands them the whole
 * estate's telemetry, which is its own answer: `listen(PORT)` alone binds every interface, and
 * these servers were verified answering on this machine's LAN address before that was fixed.
 */
const HOST = process.env.OBSERVABILITY_HOST ?? "127.0.0.1";

/**
 * Read once and never mutated. There is no `tick()` here and no journal, because this server has
 * no verb: reading a graph does not make time pass and does not change what the next read sees.
 *
 * That is a real divergence from ops-desk worth knowing about rather than hiding. ops-desk's clock
 * advances a minute per remediation, so after a rollback its `now` is 14:21 and this store's is
 * still 14:20 with nothing after it. See the README - it is why the last step of an investigation
 * cannot be faked against this fixture.
 */
const store = JSON.parse(readFileSync(FIXTURE, "utf8"));

const RETAINED_FROM = Date.parse(store.retention.from);
const RETAINED_TO = Date.parse(store.retention.to);
const RESOLUTION_MS = store.retention.resolution_s * 1000;

/**
 * A millisecond count as this store spells a timestamp.
 *
 * `toISOString()` writes `2026-08-26T12:00:00.000Z` and every string in the fixture is written
 * `2026-08-26T12:00:00Z`. Both are the same instant and they are not the same string, so a reply
 * carrying computed and stored timestamps side by side hands the reader two spellings and invites
 * a comparison between them that fails. One spelling, everywhere this file emits one.
 */
const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");

/** The instant of point `i` in every series, which is start + i * step rather than a stored field. */
const instantOf = (index) => iso(RETAINED_FROM + index * RESOLUTION_MS);

/** Long enough for any timestamp anybody writes, short enough that nothing is stored from it. */
const WHEN = z.string().max(40);
const ID = z.string().max(200);

/**
 * The default window when none is asked for: the hour ending at the store's `now`.
 *
 * Optional rather than required, because an agent that has to construct two ISO timestamps for
 * every call makes more of them wrong than right - and a refused `bad_timestamp` costs a round
 * trip. What keeps the default honest is that the reply always echoes the window it actually
 * served, so nobody has to remember what the default was.
 */
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

const text = (value) => ({
  content: [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

/**
 * Every registered name, collected as they register.
 *
 * The startup banner and /health both read from this rather than from a hand-written list. Both of
 * the older servers carried a typed count and both were already wrong, which is a small lie of
 * exactly the kind this project spends the rest of its time refusing.
 */
const registered = new Set();

const register = (server, name, meta, handler) => {
  registered.add(name);
  return server.registerTool(name, meta, handler);
};

/**
 * Every tool on this server is a read, so every one carries the same annotations.
 *
 * `readOnlyHint: true` is what `@read-only` resolves from, and it is true in the strongest sense
 * available here: there is no code path in this file that assigns to `store`.
 */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/* -------------------------------------------------------------------------------------------- */
/* Reading the store, with the guards the other two servers learned to want.                       */
/* -------------------------------------------------------------------------------------------- */

const SERVICES = Object.keys(store.series);
const METRICS = Object.keys(store.metrics);

/** Every service the map names, which is a wider set than the one this store has series for. */
const MAPPED = store.service_map.map((node) => node.service);

/**
 * Whether this store keeps a series, using `Object.hasOwn` rather than a truthiness check.
 *
 * ops-desk learned this the expensive way: `state.health["constructor"]` is a function inherited
 * from Object.prototype and therefore truthy, so the desk answered for a service that does not
 * exist with something that is not a series. Every name on the prototype chain did it - toString,
 * valueOf, hasOwnProperty, __proto__ - and here the same mistake would answer a `query_range` for
 * `toString` with a chart.
 */
const holdsService = (service) => Object.hasOwn(store.series, service);
const holdsSeries = (service, metric) =>
  holdsService(service) && Object.hasOwn(store.series[service], metric);

/** Which services carry a given metric, so a `no_series` refusal can say where to look instead. */
const servicesWith = (metric) => SERVICES.filter((service) => holdsSeries(service, metric));

/**
 * Parse a window, or say which field could not be read. Returns `{ error }` or `{ from, to }`.
 *
 * ops-desk's `search_logs` compared ISO strings directly at first, so `since: "14:00"` - which is
 * how a person says it, and therefore how a model says it - sorted below every line in the file
 * and the tool answered with all of them. A filter that is silently dropped answers a question
 * nobody asked, and the reply still looks like a searched window that came back busy. Here it
 * would be worse: a dropped `from` turns a two-hour chart into whatever the store happens to hold,
 * and the agent reads the shape of the retention as the shape of the metric.
 */
function windowOf(from, to, { defaultTo = store.now, defaultSpanMs = DEFAULT_WINDOW_MS } = {}) {
  const parsed = {};
  for (const [field, value] of [
    ["from", from],
    ["to", to],
  ]) {
    if (value === undefined) continue;
    const at = Date.parse(value);
    if (Number.isNaN(at)) {
      return {
        error: {
          error: "bad_timestamp",
          message:
            `${field} was ${JSON.stringify(value)}, which is not a time this store can read. Nothing was ` +
            "queried, because a window that is quietly dropped answers with whatever the store happens to hold - " +
            "and the shape of the retention then reads as the shape of the metric.",
          field,
          example: store.now,
        },
      };
    }
    parsed[field] = at;
  }

  const upper = parsed.to ?? Date.parse(defaultTo);
  const lower = parsed.from ?? upper - defaultSpanMs;

  /**
   * Backwards is refused rather than answered with nothing.
   *
   * No point can be in that window, and "no points" is exactly what an investigation reads as a
   * metric that was not being collected. Naming the mistake costs a call; hiding it inside an
   * empty series costs the root cause.
   */
  if (lower > upper) {
    return {
      error: {
        error: "bad_window",
        message:
          `from (${iso(lower)}) is after to (${iso(upper)}). No point ` +
          "can be in that window, and an empty series would read as a metric nobody was collecting.",
      },
    };
  }

  return { from: lower, to: upper, defaulted: { from: from === undefined, to: to === undefined } };
}

/**
 * What the store can and cannot serve for a window, said out loud.
 *
 * This is the check the whole file is arranged around. A store that keeps two hours, asked for
 * six, has three honest answers and only one of them is "here are the points I have": it also has
 * to say which part of the question it could not answer, because a series that begins at 12:00
 * reads as a metric that was flat before then to anybody who does not know when the store starts.
 */
function coverageOf(from, to) {
  const overlapFrom = Math.max(from, RETAINED_FROM);
  const overlapTo = Math.min(to, RETAINED_TO);

  return {
    covered: overlapFrom <= overlapTo,
    from: overlapFrom,
    to: overlapTo,
    /** The spans asked for and not held, as spans rather than as a boolean. */
    missingBefore:
      from < RETAINED_FROM
        ? { from: iso(from), to: store.retention.from }
        : null,
    missingAfter:
      to > RETAINED_TO ? { from: store.retention.to, to: iso(to) } : null,
  };
}

const retentionBlock = () => ({
  from: store.retention.from,
  to: store.retention.to,
  resolution_s: store.retention.resolution_s,
  now: store.now,
});

/**
 * The raw points of one series inside a window, with their indices.
 *
 * Inclusive at both ends, which is a choice and is stated in every tool description. A window of
 * 14:00 to 14:20 holds 21 points, not 20, and an agent comparing two adjacent windows would
 * otherwise count the boundary minute twice without either reply saying so.
 */
function rawPoints(service, metric, from, to) {
  const values = store.series[service][metric];
  const out = [];
  const firstIndex = Math.max(0, Math.ceil((from - RETAINED_FROM) / RESOLUTION_MS));
  for (let i = firstIndex; i < values.length; i += 1) {
    const at = RETAINED_FROM + i * RESOLUTION_MS;
    if (at > to) break;
    out.push({ at: instantOf(i), value: values[i] });
  }
  return out;
}

/**
 * Summarise a run of points, and be honest about what a summary of a percentile means.
 *
 * `mean` over a p99 series is the average of ninety-ninth percentiles, which is not a percentile of
 * anything. It is a summary of the chart, and it is reported under a name that says so. `max` is
 * the statistic that survives the objection, and it is the one to compare windows on.
 */
function summarise(points, metric) {
  if (points.length === 0) return null;
  const values = points.map((p) => p.value);
  const total = values.reduce((sum, v) => sum + v, 0);
  return {
    points: points.length,
    first: values[0],
    last: values[values.length - 1],
    min: Math.min(...values),
    max: Math.max(...values),
    // Rounded to six places because floating point sums of 0.004 produce a mean nobody wants to
    // read, and a mean printed to seventeen digits invites somebody to quote all of them.
    mean_of_points: Number((total / values.length).toFixed(6)),
    from: points[0].at,
    to: points[points.length - 1].at,
    percentile_metric: store.metrics[metric].percentile === true,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* The tools.                                                                                     */
/* -------------------------------------------------------------------------------------------- */

function buildServer() {
  const server = new McpServer({ name: "observability", version: "1.0.0" });

  register(
    server,
    "list_metrics",
    {
      title: "List the metrics",
      description:
        "Every metric this store keeps, with its unit, how it downsamples, and which services carry it. " +
        "Also the retention window and the scrape interval, which bound every query_range answer.",
      annotations: READ_ONLY,
    },
    async () =>
      text({
        retention: retentionBlock(),
        /**
         * The unit is published because a unit nobody published is a unit somebody guesses.
         * `latency_p99_ms` says milliseconds in its name and `error_rate` says nothing at all about
         * whether 0.117 is a fraction or a percentage - and 11.7% against a 1% threshold and 0.117%
         * against the same one are opposite findings.
         */
        metrics: METRICS.map((name) => ({
          name,
          ...store.metrics[name],
          services: servicesWith(name),
        })),
        note:
          "A metric and a service are separate lookups: this store keeps hit_rate and it keeps " +
          "checkout-api, and there is no hit_rate for checkout-api. query_range says which of the " +
          "three it is rather than answering with an empty series.",
      }),
  );

  register(
    server,
    "list_dashboards",
    {
      title: "List the dashboards",
      description:
        "Every dashboard, with the panels on it. Each panel names the metric and the service it charts, so a panel is a query_range call you can make.",
      annotations: READ_ONLY,
    },
    async () =>
      text({
        count: store.dashboards.length,
        dashboards: store.dashboards.map((board) => ({
          id: board.id,
          title: board.title,
          description: board.description,
          annotations_overlaid: board.annotations_overlaid,
          panels: board.panels.length,
        })),
      }),
  );

  register(
    server,
    "get_dashboard",
    {
      title: "Read one dashboard",
      description:
        "The panels on one dashboard in full: for each, the metric, the service, the unit and whether deploy markers are drawn on it.",
      inputSchema: { dashboard_id: ID },
      annotations: READ_ONLY,
    },
    async ({ dashboard_id }) => {
      const board = store.dashboards.find((d) => d.id === dashboard_id);
      // An unknown id is a fact about the world, not a crash - and it is still JSON, because a
      // tool that answers with an object on the happy path and prose on the sad one makes every
      // caller parse twice.
      if (!board) {
        return text({
          error: "not_found",
          message: `No dashboard with id ${dashboard_id}.`,
          known: store.dashboards.map((d) => d.id),
        });
      }

      return text({
        ...board,
        panels: board.panels.map((panel) => ({
          ...panel,
          unit: store.metrics[panel.metric]?.unit ?? null,
          /**
           * Whether the panel would draw anything, checked rather than assumed.
           *
           * A dashboard is a document; the series behind it may not exist. A panel that charts a
           * metric this store has no data for renders empty in Grafana too, and an agent reading
           * the panel list as a list of available series would call query_range and get a refusal
           * it has no way to interpret.
           */
          has_series: holdsSeries(panel.service, panel.metric),
        })),
      });
    },
  );

  register(
    server,
    "query_range",
    {
      title: "Query a metric over a window",
      description:
        "The time series for one metric on one service, between two instants, at a step. Returns numbers, not prose. " +
        "Both ends of the window are inclusive. The store keeps a fixed retention window: a query wider than it is " +
        "served for the overlap and flagged `truncated`, and one entirely outside it is an error rather than an empty " +
        "series, because no points reads as a flat metric. Check `truncated` before treating what came back as the whole picture.",
      inputSchema: {
        metric: ID,
        service: ID,
        from: WHEN.optional(),
        to: WHEN.optional(),
        step_s: z.number().int().min(1).max(86_400).optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ metric, service, from, to, step_s }) => {
      /**
       * Three different empties, answered as three different errors.
       *
       * A metric this store does not keep, a service it does not keep, and a pair it does not
       * keep are three separate facts and three separate next moves. Collapsing them into one
       * "no data" is how an investigation concludes that checkout-api has no latency, and that
       * conclusion is indistinguishable from a healthy service on a dashboard.
       */
      if (!Object.hasOwn(store.metrics, metric)) {
        return text({
          error: "unknown_metric",
          message: `This store keeps no metric called ${JSON.stringify(metric)}.`,
          known_metrics: METRICS,
        });
      }
      if (!holdsService(service)) {
        return text({
          error: "unknown_service",
          message:
            `This store keeps no series for ${JSON.stringify(service)}.` +
            (MAPPED.includes(service)
              ? " It is a real node in the service map - the map is wider than this store - so this is an absence of instrumentation, not an absence of the service."
              : ""),
          known_services: SERVICES,
          in_service_map: MAPPED.includes(service),
        });
      }
      if (!holdsSeries(service, metric)) {
        return text({
          error: "no_series",
          message:
            `This store keeps ${metric} and it keeps ${service}, and it has no ${metric} for ${service}. ` +
            "That is not a metric that was zero.",
          metric,
          service,
          services_with_this_metric: servicesWith(metric),
          metrics_for_this_service: Object.keys(store.series[service]),
        });
      }

      const asked = windowOf(from, to);
      if (asked.error) return text(asked.error);

      /**
       * The step has to be a whole number of scrape intervals, and never smaller than one.
       *
       * Smaller means inventing points between measurements, and an interpolated point is
       * indistinguishable in the reply from one somebody measured. Not a multiple means buckets
       * that straddle scrapes, so the same minute lands in two of them and a series with 141
       * readings answers with 142 points that sum to more than the traffic there was.
       */
      const step = step_s ?? store.retention.resolution_s;
      if (step < store.retention.resolution_s || step % store.retention.resolution_s !== 0) {
        return text({
          error: "bad_step",
          message:
            `step_s must be a whole multiple of the ${store.retention.resolution_s}s scrape interval, and ${step}s is not. ` +
            "A smaller step would interpolate points that nobody measured, and the reply gives no way to tell those " +
            "from readings. A step that is not a multiple puts the same scrape in two buckets.",
          resolution_s: store.retention.resolution_s,
          nearest_valid: [
            store.retention.resolution_s * Math.max(1, Math.floor(step / store.retention.resolution_s)),
            store.retention.resolution_s * Math.max(1, Math.ceil(step / store.retention.resolution_s)),
          ],
        });
      }

      const cover = coverageOf(asked.from, asked.to);

      /**
       * A window with no overlap at all is an error, not an empty series.
       *
       * This is the single most important refusal on this server. Ask for yesterday, get `points:
       * []`, and the honest reading - "this store does not go back that far" - is exactly as
       * available as the wrong one - "the metric was not moving then". An agent building a
       * baseline picks the wrong one, because the wrong one lets it finish.
       */
      if (!cover.covered) {
        return text({
          error: "outside_retention",
          message:
            `This store holds ${store.retention.from} to ${store.retention.to} and the window asked for lies ` +
            "entirely outside it. No points are returned, and that is reported as an error rather than as an " +
            "empty series, because an empty series reads as a metric that was not moving.",
          requested: {
            from: iso(asked.from),
            to: iso(asked.to),
          },
          retention: retentionBlock(),
        });
      }

      const raw = rawPoints(service, metric, cover.from, cover.to);

      /**
       * The fourth empty: a window inside retention with no scrape in it.
       *
       * `from: 14:00:10, to: 14:00:50` overlaps the retained span perfectly and contains no
       * reading, because readings are taken on the minute. Served as `points: []` with
       * `truncated: false` it is the most misleading reply this server could give - it says, in
       * effect, that the store was watching and saw nothing, which is what a healthy quiet service
       * looks like. Found by reading the coverage check rather than by anybody asking for it.
       */
      if (raw.length === 0) {
        return text({
          error: "no_points_in_window",
          message:
            `This store scrapes every ${store.retention.resolution_s}s and the window ${iso(asked.from)} to ` +
            `${iso(asked.to)} contains no scrape. That is a window narrower than the resolution, not a metric ` +
            "that went quiet, and the two would be indistinguishable if this answered with an empty series.",
          requested: { from: iso(asked.from), to: iso(asked.to) },
          retention: retentionBlock(),
        });
      }

      const definition = store.metrics[metric];
      const bucketMs = step * 1000;
      const downsampled = step !== store.retention.resolution_s;

      /**
       * Downsampling, and the one honest way to do it for a percentile.
       *
       * A p99 over a union of minutes is not any function of the per-minute p99s - the underlying
       * request latencies are gone by the time this store sees them. The maximum of the buckets it
       * merged is an approximation, and it is the one that fails safe: the mean of [305, 1980] is
       * 1142, which is a number that looks like a slow service rather than like a broken one, and
       * a five-minute step would have turned the step change this fixture is built around into a
       * gentle slope. Reported as an approximation, in the reply, every time.
       */
      const points = [];
      if (downsampled) {
        const buckets = new Map();
        for (const point of raw) {
          const start = Math.floor((Date.parse(point.at) - RETAINED_FROM) / bucketMs) * bucketMs + RETAINED_FROM;
          if (!buckets.has(start)) buckets.set(start, []);
          buckets.get(start).push(point.value);
        }
        for (const [start, values] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
          const value =
            definition.aggregation === "max"
              ? Math.max(...values)
              : Number((values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(6));
          points.push({
            at: iso(start),
            value,
            merged: values.length,
          });
        }
      } else {
        points.push(...raw);
      }

      const truncated = Boolean(cover.missingBefore || cover.missingAfter);

      return text({
        metric,
        service,
        unit: definition.unit,
        requested: {
          from: iso(asked.from),
          to: iso(asked.to),
          step_s: step,
          // Said out loud, because a window nobody asked for is a window nobody remembers.
          defaulted: asked.defaulted,
        },
        served: {
          from: points[0]?.at ?? null,
          to: points[points.length - 1]?.at ?? null,
          step_s: step,
          points: points.length,
        },
        retention: retentionBlock(),
        /**
         * The flag, named so it cannot be skimmed past, and paired with the spans it is about.
         * warehouse does the same for a page of rows, and for the same reason: a partial result
         * treated as the whole one is a false number arrived at honestly.
         */
        truncated,
        missing_before: cover.missingBefore,
        missing_after: cover.missingAfter,
        downsampled,
        aggregation: downsampled ? definition.aggregation : "none",
        note: [
          truncated
            ? "This is not the whole window you asked for. The spans in missing_before and missing_after are " +
              "outside what this store retains, and nothing may be concluded about them - in particular they " +
              "are not flat, and they are not zero."
            : null,
          downsampled && definition.percentile
            ? `Downsampled to ${step}s by taking the maximum of each bucket. A p99 over merged buckets is not ` +
              "any function of the p99s inside them, so this is an approximation and an upper one. Query at the " +
              `${store.retention.resolution_s}s scrape interval before quoting a number in a report.`
            : downsampled
              ? `Downsampled to ${step}s by taking the mean of each bucket; \`merged\` says how many readings each point is.`
              : null,
          "Both ends of the window are inclusive.",
        ]
          .filter(Boolean)
          .join(" "),
        points,
      });
    },
  );

  register(
    server,
    "compare_windows",
    {
      title: "Compare one metric across two windows",
      description:
        "Summarise one metric on one service over a baseline window and a comparison window, and report the change between them. " +
        "This is the call for 'is it worse than it was' and for 'did it recover'. It refuses to compute a change when either " +
        "window is empty or is not fully retained, because a ratio against a window that was never measured is a number arrived " +
        "at honestly and wrong.",
      inputSchema: {
        metric: ID,
        service: ID,
        baseline_from: WHEN,
        baseline_to: WHEN,
        compare_from: WHEN,
        compare_to: WHEN,
      },
      annotations: READ_ONLY,
    },
    async ({ metric, service, baseline_from, baseline_to, compare_from, compare_to }) => {
      if (!Object.hasOwn(store.metrics, metric)) {
        return text({ error: "unknown_metric", message: `This store keeps no metric called ${JSON.stringify(metric)}.`, known_metrics: METRICS });
      }
      // The same three empties query_range distinguishes, distinguished here too. A comparison
      // that cannot say which of them it hit is a comparison somebody will read as "no change".
      if (!holdsService(service)) {
        return text({
          error: "unknown_service",
          message: `This store keeps no series for ${JSON.stringify(service)}.`,
          known_services: SERVICES,
          in_service_map: MAPPED.includes(service),
        });
      }
      if (!holdsSeries(service, metric)) {
        return text({
          error: "no_series",
          message: `This store keeps ${metric} and it keeps ${service}, and it has no ${metric} for ${service}.`,
          services_with_this_metric: servicesWith(metric),
          metrics_for_this_service: Object.keys(store.series[service]),
        });
      }

      const windows = {};
      for (const [name, from, to] of [
        ["baseline", baseline_from, baseline_to],
        ["compare", compare_from, compare_to],
      ]) {
        const parsed = windowOf(from, to);
        if (parsed.error) return text({ ...parsed.error, window: name });
        windows[name] = parsed;
      }

      const summaries = {};
      for (const [name, asked] of Object.entries(windows)) {
        const cover = coverageOf(asked.from, asked.to);
        const points = cover.covered ? rawPoints(service, metric, cover.from, cover.to) : [];
        summaries[name] = {
          requested: {
            from: iso(asked.from),
            to: iso(asked.to),
          },
          retained: cover.covered && !cover.missingBefore && !cover.missingAfter,
          missing_before: cover.missingBefore,
          missing_after: cover.missingAfter,
          ...(summarise(points, metric) ?? { points: 0 }),
        };
      }

      /**
       * Why a change is refused rather than computed, in the reply rather than in a comment.
       *
       * An empty window is the case that matters. The last step of an investigation is "did the
       * rollback help", and the honest answer immediately after a rollback is that no reading
       * exists yet - this store ends at its `now` and nothing advances it. A tool that answered
       * `mean_ratio: null` and left it at that would let "recovered" be written on the strength of
       * a field nobody read; a tool that answers with a reason cannot be misquoted so easily.
       *
       * A partly-retained window is refused for a smaller reason that goes the same way. The mean
       * of a window missing half its minutes is the mean of the half that was kept, and nothing in
       * the number says which half.
       */
      const blocked = Object.entries(summaries)
        .filter(([, w]) => w.points === 0 || !w.retained)
        .map(([name, w]) => ({
          window: name,
          why: w.points === 0 ? "no_points_in_window" : "window_not_fully_retained",
          detail:
            w.points === 0
              ? `This store holds ${store.retention.from} to ${store.retention.to} and has no readings in ${w.requested.from} to ${w.requested.to}. ` +
                "If you are checking whether something recovered after an action, the reading you want has not been taken yet - " +
                "which is a fact about the evidence, not a result you may round up to recovery."
              : "Part of this window is outside what the store retains, so a mean over it is a mean over the part that was kept, " +
                "and nothing in the number says which part.",
        }));

      const change =
        blocked.length === 0
          ? {
              max_delta: Number((summaries.compare.max - summaries.baseline.max).toFixed(6)),
              max_ratio: summaries.baseline.max === 0 ? null : Number((summaries.compare.max / summaries.baseline.max).toFixed(4)),
              mean_delta: Number((summaries.compare.mean_of_points - summaries.baseline.mean_of_points).toFixed(6)),
              mean_ratio:
                summaries.baseline.mean_of_points === 0
                  ? null
                  : Number((summaries.compare.mean_of_points / summaries.baseline.mean_of_points).toFixed(4)),
            }
          : null;

      return text({
        metric,
        service,
        unit: store.metrics[metric].unit,
        baseline: summaries.baseline,
        compare: summaries.compare,
        change,
        refused: blocked.length ? blocked : null,
        retention: retentionBlock(),
        note:
          (change === null
            ? "No change was computed. See `refused` - the reason is a fact about the evidence, and the honest report is that this comparison could not be made. "
            : "") +
          (store.metrics[metric].percentile
            ? "This is a percentile metric, so mean_of_points is the average of ninety-ninth percentiles and is not itself a percentile. " +
              "Compare on max, and quote max in a report. "
            : "") +
          "A change is arithmetic on two windows. It is not a cause, and neither window knows what happened between them - " +
          "list_annotations does.",
      });
    },
  );

  register(
    server,
    "list_annotations",
    {
      title: "List annotations on the timeline",
      description:
        "The deploy markers, config changes, scaling events and campaign starts drawn on these dashboards, in time order. " +
        "This is what makes correlation possible: an annotation on the same minute a series steps is the finding, and neither " +
        "half says anything alone. Deploy annotations carry the ops-desk deploy id, so the two servers can be cross-checked.",
      inputSchema: {
        from: WHEN.optional(),
        to: WHEN.optional(),
        service: ID.optional(),
        kind: z.enum(["deploy", "config", "scale", "campaign"]).optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ from, to, service, kind }) => {
      /**
       * A wider default than query_range's, because annotations are cheap and a deploy outside the
       * metric window is exactly the one worth seeing.
       *
       * The metric store keeps two hours. The deploy that a rollback returns the service to shipped
       * the previous day, and an agent that only ever sees the retained window would never learn
       * that it exists. Annotations are not bounded by retention and the reply says which of them
       * fall outside it.
       */
      const asked = windowOf(from, to, { defaultSpanMs: 7 * 24 * 60 * 60 * 1000 });
      if (asked.error) return text(asked.error);

      const held = store.annotations;
      const matched = held
        .filter((note) => {
          const at = Date.parse(note.at);
          if (at < asked.from || at > asked.to) return false;
          if (service && note.service !== service) return false;
          return !kind || note.kind === kind;
        })
        .sort((a, b) => a.at.localeCompare(b.at))
        .map((note) => ({
          ...note,
          /**
           * Whether `query_range` can show you the series at this instant.
           *
           * Without it, an agent reads "deploy 9ab7 at 2026-08-25T11:20:00Z", queries the metric
           * around it to see whether that deploy moved anything, and gets `outside_retention` -
           * which it then has to interpret. Saying so on the annotation turns a round trip and a
           * possible misreading into a field.
           */
          within_retention: Date.parse(note.at) >= RETAINED_FROM && Date.parse(note.at) <= RETAINED_TO,
        }));

      return text({
        // Echoed back beside how many annotations exist at all. `matched: 0` on its own reads as a
        // timeline with nothing on it - which is what an agent concludes when it means "nothing
        // shipped, so this is not a deploy" - and `matched: 0` beside `held: 6` reads as a filter.
        searched: {
          from: iso(asked.from),
          to: iso(asked.to),
          service: service ?? null,
          kind: kind ?? null,
        },
        held: held.length,
        matched: matched.length,
        retention: retentionBlock(),
        note:
          "An annotation beside a step change is a correlation and not a cause. Before you name one, check whether the " +
          "series moved before it too, and whether anything else on this list is nearer. Annotations are kept beyond " +
          "the metric retention window: within_retention says whether query_range can show you the series at that moment.",
        annotations: matched,
      });
    },
  );

  register(
    server,
    "list_alert_rules",
    {
      title: "List the alert rules",
      description:
        "Every rule, its threshold, how long the condition must hold, and whether it is firing now. " +
        "A rule that pages carries the ops-desk alert id it raised. A rule that is NOT firing is evidence too: " +
        "a dependency inside its own objective is a dependency nobody should be paged about.",
      inputSchema: {
        state: z.enum(["firing", "ok", "all"]).optional(),
        service: ID.optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ state = "all", service }) => {
      const held = store.alert_rules;
      const matched = held.filter(
        (rule) => (state === "all" || rule.state === state) && (!service || rule.service === service),
      );

      return text({
        searched: { state, service: service ?? null },
        held: held.length,
        matched: matched.length,
        rules: matched.map((rule) => ({
          ...rule,
          /**
           * Whether the series behind the rule is one this store can show you.
           *
           * RULE-EXPORT watches a job's exit status and has no metric at all, and RULE-SRCH-P99 has
           * been firing since 09:40 - three and a half hours before this store's earliest reading.
           * Both would answer a "let me look at the graph" with a refusal, and it is cheaper to say
           * so here than to let the agent discover it one call later.
           */
          has_series: rule.metric ? holdsSeries(rule.service, rule.metric) : false,
          /**
           * `null` when the rule is not firing, rather than `false`.
           *
           * A rule that is `ok` has no `since`, and `since_within_retention: false` reads as "the
           * moment it started is too old to look at" - which is a statement about a firing rule.
           * The gateway rule is the one this matters for, and it is the most important row on this
           * whole server: reporting it as anything other than "not firing, nothing to look at"
           * hands an investigation a reason to think the dependency has a history.
           */
          since_within_retention:
            rule.since === null
              ? null
              : Date.parse(rule.since) >= RETAINED_FROM && Date.parse(rule.since) <= RETAINED_TO,
        })),
        note:
          "`pages: false` means the rule fires onto a dashboard and raises no alert, so it will not appear in ops-desk. " +
          "`alert_id` is the ops-desk alert this rule raised, where it raised one.",
      });
    },
  );

  register(
    server,
    "get_service_map",
    {
      title: "Read the service map",
      description:
        "What calls what. Given a service, its immediate upstreams and downstreams; given nothing, the whole map. " +
        "The map names more services than this store has metrics for - `has_series` says which - because a dependency " +
        "you can name is not the same as a dependency you can measure.",
      inputSchema: { service: ID.optional() },
      annotations: READ_ONLY,
    },
    async ({ service }) => {
      const describe = (name) => {
        const node = store.service_map.find((n) => n.service === name);
        return {
          service: name,
          role: node?.role ?? null,
          /** Downstream: what this service calls, and therefore what can make it slow. */
          calls: node?.calls ?? [],
          /** Upstream: what calls this service, and therefore what its slowness reaches. */
          called_by: store.service_map.filter((n) => n.calls.includes(name)).map((n) => n.service),
          has_series: holdsService(name),
          metrics: holdsService(name) ? Object.keys(store.series[name]) : [],
        };
      };

      if (service === undefined) {
        return text({
          services: store.service_map.map((node) => describe(node.service)),
          note:
            "has_series false means this store has no metrics for that service, not that the service is idle. " +
            "Four nodes here are named and not instrumented, which is a fact about the telemetry and worth saying " +
            "in a report rather than working around.",
        });
      }

      if (!MAPPED.includes(service)) {
        return text({
          error: "not_found",
          message: `${JSON.stringify(service)} is not on this map.`,
          known: MAPPED,
        });
      }

      const node = describe(service);
      return text({
        ...node,
        /** One hop out in both directions, because "checkout is slow" is usually about a neighbour. */
        neighbours: [...node.calls, ...node.called_by].map(describe),
        note:
          "A service is only ever as fast as what it waits for. If this service's latency is at or below a " +
          "downstream's, it is not waiting for that downstream any more - which is a different finding from " +
          "being fast, and usually means a deadline was cut rather than a dependency improving.",
      });
    },
  );

  return server;
}

serve({
  name: "observability",
  buildServer,
  port: PORT,
  host: HOST,
  // Read from the registry rather than restated, so the banner and /health cannot drift from what
  // is actually registered. Building one server populates it.
  tools: () => {
    if (registered.size === 0) buildServer();
    return [...registered];
  },
  describe: () => ({
    read_only: true,
    services: SERVICES.length,
    metrics: METRICS.length,
    retention: `${store.retention.from} to ${store.retention.to}`,
  }),
});
