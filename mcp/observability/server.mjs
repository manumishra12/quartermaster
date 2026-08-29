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
 *   3. A comparison against a window with nothing in it, or one that spans a moment the world
 *      changed. This is the one that matters for the last step of an investigation. "It recovered"
 *      is a claim about a time series, so `compare_windows` refuses to compute a ratio rather than
 *      dividing by a window it never had, and refuses to average across a rollback rather than
 *      returning a number that describes neither side of it. ops-desk's `resolve_alert` refuses
 *      `no_readings` for the same reason.
 *
 * WHERE THE READINGS AFTER 14:20 COME FROM
 *
 * A metric that cannot move is not a metric, and this store used to be one: its numbers ended at
 * 14:20 whatever happened afterwards, so the last step of an investigation - did the fix work - had
 * no evidence available to it in either direction. An agent could only predict a recovery.
 *
 * The world changes when somebody rolls a deploy back, and ops-desk is where that happens: it holds
 * the clock, what each service is running, and the order things were done in. So this file asks it,
 * on its /health route, and works out what its own series do from the answer. The arithmetic is one
 * comparison and it is the same one the incident is about: checkout-api waits for payment-gateway
 * up to the client timeout its deployed version sets. 4c21 sets 2000ms and this store has never
 * measured the gateway faster than 2388ms; 9ab7 sets 5000ms and it has never measured it slower
 * than 2430ms. So the post-rollback readings are not a healthy series somebody typed in - they are
 * this store's own pre-incident readings, replayed, because the budget is back to what it was when
 * those readings were taken. A remediation that does not restore the budget replays the incident's
 * own settled readings instead, and the verify step reads as a failure, which is the half that
 * makes it a verify step at all.
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
 * Where ops-desk answers, because the state of the world is that desk's fact and not this one's.
 *
 * Unreachable is an ordinary case, not an error: this store is worth reading with no desk running
 * at all, and it behaves then exactly as it did before any of this existed - it ends at 14:20. What
 * it must never do is report that as "nothing has been done", because "nothing has been done" and
 * "I could not ask whether anything has been done" are different sentences and only one of them is
 * true. Every reply that depends on the answer carries a `world` block saying which it got.
 */
const OPS_DESK_URL = (process.env.OPS_DESK_URL ?? "http://127.0.0.1:8795").replace(/\/+$/, "");

/**
 * Long enough for a loopback round trip on a machine that is busy running the rest of the suite,
 * short enough that a desk which accepted the connection and then stopped answering does not hang
 * every query behind it. A query that hangs is worse than one that says it could not ask.
 */
const OPS_DESK_TIMEOUT_MS = 2000;

/**
 * Read once and never mutated. There is no `tick()` here and no journal, because this server still
 * has no verb: reading a graph does not make time pass, and two identical reads with nothing done
 * between them return the same thing. `idempotentHint` is published on all eight tools and nothing
 * in this file may make it a lie.
 *
 * What can differ between two reads is the world, and only because somebody used a gated tool on
 * the other server in between. That is the same thing a real Grafana does, and it is the opposite
 * of a clock: this store never advances itself.
 */
const store = JSON.parse(readFileSync(FIXTURE, "utf8"));

const RETAINED_FROM = Date.parse(store.retention.from);
const RETAINED_TO = Date.parse(store.retention.to);
const RESOLUTION_MS = store.retention.resolution_s * 1000;
const FIXTURE_NOW = Date.parse(store.now);

/** The block that says how the two series the deploy determines carry on past the fixture. */
const RECOVERY = store.recovery;

/**
 * How far past its own last reading this store will follow somebody else's clock.
 *
 * ops-desk advances a minute per remediation, so in practice this is single digits. It is bounded
 * anyway because `now` arrives from another process: a desk reporting a `now` a year ahead would
 * otherwise have this file synthesise half a million readings and serve them as measurements. A
 * store that keeps two hours and twenty minutes does not suddenly hold a week.
 */
const MAX_EXTENSION_POINTS = store.series[RECOVERY.service][RECOVERY.metrics[0]].length;

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

/* -------------------------------------------------------------------------------------------- */
/* The world, which ops-desk owns and this store only reads.                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * The last answer ops-desk gave, kept so /health can say something true.
 *
 * serve.mjs answers /health synchronously and cannot await a fetch, so the alternative is a health
 * line that reports the fixture's span while `list_metrics` reports a longer one - two answers from
 * one server. This is the last thing a query learned, labelled with the desk's own `now` so nobody
 * can mistake it for a reading taken this second.
 */
let lastWorld = null;

const noWorld = (why) => ({
  reachable: false,
  source: `${OPS_DESK_URL}/health`,
  why,
  now: FIXTURE_NOW,
  deployed: {},
  remediations: [],
});

/**
 * Anything that came off the wire, bounded before it is put in a reply an agent will read.
 *
 * These fields are another process's output. ops-desk writes fixed strings into them today; the
 * point of the cap is that this file does not depend on that staying true, because whatever arrives
 * here is echoed back to a model as though this server had said it.
 */
const borrowed = (value) => (typeof value === "string" ? value.slice(0, 80) : null);

/**
 * Ask ops-desk what has been done, and refuse the answer rather than half-read it.
 *
 * Every branch below returns `reachable: false` with a sentence, and every one of them leaves this
 * store ending where its fixture ends. That is the same output as a desk that has done nothing, and
 * the difference between the two is exactly what the `world` block in each reply is for.
 */
async function readWorld() {
  const source = `${OPS_DESK_URL}/health`;
  let body;
  try {
    const res = await fetch(source, { signal: AbortSignal.timeout(OPS_DESK_TIMEOUT_MS) });
    if (!res.ok) return (lastWorld = noWorld(`ops-desk answered HTTP ${res.status}`));
    body = await res.json();
  } catch (error) {
    return (lastWorld = noWorld(`ops-desk could not be reached: ${String(error?.message ?? error)}`));
  }

  const now = Date.parse(body?.now);
  if (Number.isNaN(now)) {
    return (lastWorld = noWorld("ops-desk answered without a `now` this store can read"));
  }
  /**
   * A desk behind this store's own last reading is describing a different day.
   *
   * Followed rather than refused, it would shorten the retention: a `now` of 13:00 would make every
   * query about the incident itself answer `outside_retention`, and the investigation would
   * conclude the store had no readings for the hour it is about.
   */
  if (now < FIXTURE_NOW) {
    return (lastWorld = noWorld(
      `ops-desk is at ${iso(now)}, before this store's own ${store.now}, so the two are not describing the same window`,
    ));
  }
  if (now > RETAINED_TO + MAX_EXTENSION_POINTS * RESOLUTION_MS) {
    return (lastWorld = noWorld(
      `ops-desk is at ${iso(now)}, which is more than the ${MAX_EXTENSION_POINTS} readings past ${store.retention.to} ` +
        "this store will follow. It keeps two hours and twenty minutes; it does not suddenly hold a week.",
    ));
  }

  if (!Array.isArray(body.remediations)) {
    return (lastWorld = noWorld("ops-desk answered without a `remediations` list"));
  }

  const remediations = [];
  for (const entry of body.remediations) {
    const at = Date.parse(entry?.at);
    if (Number.isNaN(at)) {
      return (lastWorld = noWorld("ops-desk recorded an action with a timestamp this store cannot read"));
    }
    /**
     * Every remediation has to land on a scrape, and it does: ops-desk's clock starts on this
     * store's last reading and ticks whole minutes.
     *
     * Checked rather than assumed, because it is the one thing that keeps a reading unambiguous. A
     * remediation at 14:21:30 would put the change in the middle of the minute the 14:22 scrape
     * covers, and this file would then be attributing a percentile over a mixed minute entirely to
     * one side of it. Better to decline to extend at all than to publish a reading that is half of
     * each world and looks like neither.
     */
    if ((at - RETAINED_FROM) % RESOLUTION_MS !== 0) {
      return (lastWorld = noWorld(
        `ops-desk recorded an action at ${iso(at)}, which is not on this store's ${store.retention.resolution_s}s ` +
          "scrape boundary - a reading covering that minute would be half of each world",
      ));
    }
    remediations.push({
      action: borrowed(entry?.action) ?? "unknown",
      service: borrowed(entry?.service),
      to: borrowed(entry?.to),
      at,
    });
  }
  remediations.sort((a, b) => a.at - b.at);

  const deployed = {};
  if (body.deployed && typeof body.deployed === "object") {
    for (const [service, id] of Object.entries(body.deployed)) deployed[service] = borrowed(id);
  }

  return (lastWorld = { reachable: true, source, now, deployed, remediations });
}

/* -------------------------------------------------------------------------------------------- */
/* What the readings after 14:20 are, and why they are not new numbers.                            */
/* -------------------------------------------------------------------------------------------- */

/** The dependency's own measured spread, which is the whole of the arithmetic below. */
const DEPENDENCY = store.series[RECOVERY.dependency].latency_p99_ms;
const DEPENDENCY_MIN = Math.min(...DEPENDENCY);
const DEPENDENCY_MAX = Math.max(...DEPENDENCY);

/** The readings to replay for one metric under one verdict, taken out of the fixture by instant. */
const replaySpan = (metric, level) => {
  const span = RECOVERY.replay[level];
  const first = Math.round((Date.parse(span.from) - RETAINED_FROM) / RESOLUTION_MS);
  const last = Math.round((Date.parse(span.to) - RETAINED_FROM) / RESOLUTION_MS);
  return store.series[RECOVERY.service][metric].slice(first, last + 1);
};

/** Which version the service is on at an instant, by replaying the desk's own journal onto it. */
function versionAt(world, ms) {
  let version = RECOVERY.deployed_at_window_end;
  for (const entry of world.remediations) {
    if (entry.at > ms) break;
    // Only a rollback moves a version. A restart cycles the instances the same deploy is on, which
    // is exactly why it is the remediation that changes nothing here.
    if (entry.action === "rollback_deploy" && entry.service === RECOVERY.service && entry.to) {
      version = entry.to;
    }
  }
  return version;
}

/**
 * What a deployed version does to the series, as one comparison against a measured number.
 *
 * Both sides are things this store already holds: the budget comes from the fixture's own record of
 * what each deploy set, and the dependency's latency is 141 readings on the chart next door. The
 * middle case is the honest one - a budget inside the spread the dependency actually measured would
 * have let some minutes finish and not others, and nothing here knows which, so it says so instead
 * of picking.
 */
function verdictFor(version) {
  if (!version || !Object.hasOwn(RECOVERY.client_timeout_ms, version)) {
    return {
      known: false,
      version: version ?? null,
      why:
        `${RECOVERY.service} is on ${version ?? "no deploy this store can name"}, and this store has no ` +
        `${RECOVERY.dependency} client timeout recorded for it, so it cannot say what its latency does`,
    };
  }
  const budget = RECOVERY.client_timeout_ms[version];
  if (budget > DEPENDENCY_MAX) {
    return { known: true, version, budget_ms: budget, level: "budget_above_dependency" };
  }
  if (budget < DEPENDENCY_MIN) {
    return { known: true, version, budget_ms: budget, level: "budget_below_dependency" };
  }
  return {
    known: false,
    version,
    why:
      `${version} sets a ${budget}ms budget, which sits inside the ${DEPENDENCY_MIN}-${DEPENDENCY_MAX}ms ` +
      `${RECOVERY.dependency} measured. Some minutes would have finished inside it and some would not, and ` +
      "nothing here knows which, so no reading is published for them",
  };
}

/**
 * Which of the two levels a series is on at an instant, or null where this store cannot say.
 *
 * Used to decide whether a window has readings from more than one world in it. It is the level and
 * not the version that matters: a rollback between two deploys that set the same client timeout
 * changes what is running and does not change what the chart does, and refusing to summarise across
 * that would be a refusal protecting nobody from anything.
 */
function levelAt(world, ms) {
  const verdict = verdictFor(versionAt(world, ms));
  return verdict.known ? verdict.level : null;
}

/**
 * The readings past the fixture's last one, for one series.
 *
 * Only the two series the deploy determines get one. The rest of this store stops at 14:20, and a
 * query past it still says `outside_retention` - checkout's request rate after a rollback is not
 * something a client timeout decides, and inventing a continuation for it would be exactly the
 * hardcoded series this whole arrangement exists to avoid.
 */
function continuationOf(service, metric, world) {
  if (!world.reachable) return { values: [], why: "world_unknown" };
  if (service !== RECOVERY.service || !RECOVERY.metrics.includes(metric)) {
    return { values: [], why: "not_determined_by_the_deploy" };
  }

  const minutes = Math.round((world.now - RETAINED_TO) / RESOLUTION_MS);
  if (minutes <= 0) return { values: [], why: "nothing_done_since" };

  /**
   * The desk's own current deploy, checked against what replaying its journal says it should be.
   *
   * Two servers disagreeing about which version is running is worse than one server, because the
   * disagreement is invisible until somebody quotes both - and here it would decide whether this
   * store publishes a recovery. Refused rather than resolved in favour of either.
   */
  const claimed = world.deployed[RECOVERY.service] ?? null;
  const replayed = versionAt(world, world.now);
  if (claimed !== null && claimed !== replayed) {
    return {
      values: [],
      why: "desk_disagrees_with_its_own_journal",
      detail:
        `ops-desk reports ${RECOVERY.service} on ${claimed}, and replaying the actions it recorded gives ` +
        `${replayed}. This store will not choose between them, so it publishes no reading after ${store.retention.to}.`,
    };
  }

  const values = [];
  let level = null;
  let inLevel = 0;
  for (let minute = 1; minute <= minutes; minute += 1) {
    const at = RETAINED_TO + minute * RESOLUTION_MS;
    const verdict = verdictFor(versionAt(world, at));
    if (!verdict.known) {
      // Stop here rather than skipping the minute: a gap in the middle of a series reads as a
      // scrape that failed, and this is a store declining to say, which is a different fact.
      return { values, why: "world_not_describable", detail: verdict.why };
    }
    // Counted from the last time the world changed, so the first minute in a new world replays the
    // first reading this store took in a world like it rather than an arbitrary one.
    inLevel = verdict.level === level ? inLevel + 1 : 0;
    level = verdict.level;
    const span = replaySpan(metric, level);
    values.push(span[inLevel % span.length]);
  }
  return { values, why: null };
}

/**
 * One series as this store can serve it now: the checked-in readings, and any that follow them.
 *
 * `to` is per series rather than per store, because the retention is now per series. checkout-api's
 * latency can run to 14:21 while its request rate stops at 14:20, and a single retention number
 * would have to be wrong about one of them.
 */
function viewOf(service, metric, world) {
  const base = store.series[service][metric];
  const extension = continuationOf(service, metric, world);
  const values = extension.values.length ? [...base, ...extension.values] : base;
  return {
    values,
    to: RETAINED_FROM + (values.length - 1) * RESOLUTION_MS,
    extended: extension.values.length,
    why: extension.why,
    detail: extension.detail ?? null,
  };
}

/** The store's `now`, which is the desk's when the desk answered and the fixture's when it did not. */
const nowOf = (world) => (world.reachable ? world.now : FIXTURE_NOW);

/**
 * Why one series stops where it does, as a sentence rather than as a code.
 *
 * Five different situations end a series at 14:20 and only one of them means "nothing has happened".
 * An agent that reads them all as that one writes "no change after the rollback" into a report,
 * which is the single sentence this whole arrangement exists to make impossible to arrive at by
 * accident.
 */
function endedBecause(service, metric, view, world) {
  if (view.extended > 0) {
    return (
      `${service}'s ${metric} runs to ${iso(view.to)}: ${view.extended} reading(s) past the fixture's ` +
      `${store.retention.to}, because ops-desk reports a remediation and this metric is one a ${RECOVERY.dependency} ` +
      "client timeout decides."
    );
  }
  switch (view.why) {
    case "world_unknown":
      return `${world.why}. This store therefore ends at ${store.retention.to}, which is not evidence that nothing happened.`;
    case "not_determined_by_the_deploy":
      return (
        `${metric} on ${service} is not something a ${RECOVERY.dependency} client timeout decides, so this store has ` +
        `no basis for a reading after ${store.retention.to} and publishes none. Only ${RECOVERY.service}'s ` +
        `${RECOVERY.metrics.join(" and ")} run past it.`
      );
    case "nothing_done_since":
      return `ops-desk reports nothing done since ${store.retention.to}, so there is nothing after it to read.`;
    default:
      return view.detail ?? `This store ends at ${store.retention.to}.`;
  }
}

/**
 * The remediations a run of points has readings from two different worlds on either side of.
 *
 * Decided from the readings the window actually holds rather than from the clock: a window that
 * stops before the rollback has nothing after it to disagree with, and one that starts after the
 * rollback has nothing before it. Only a window holding both is a summary of two worlds.
 */
function straddlesOf(points, world) {
  const out = [];
  for (const entry of world.remediations) {
    const before = points.filter((p) => Date.parse(p.at) < entry.at);
    const after = points.filter((p) => Date.parse(p.at) >= entry.at);
    if (!before.length || !after.length) continue;
    if (levelAt(world, Date.parse(before.at(-1).at)) === levelAt(world, Date.parse(after[0].at))) continue;
    out.push({ at: iso(entry.at), action: entry.action, service: entry.service, to: entry.to });
  }
  return out;
}

/** The furthest instant any series in this store reaches, which is the fixture's end or later. */
function widestEnd(world) {
  let end = RETAINED_TO;
  for (const metric of RECOVERY.metrics) {
    end = Math.max(end, viewOf(RECOVERY.service, metric, world).to);
  }
  return end;
}

/** Which series run past the fixture, said out loud wherever the retention is published. */
function extendedSeries(world) {
  const out = [];
  for (const metric of RECOVERY.metrics) {
    const view = viewOf(RECOVERY.service, metric, world);
    if (view.extended > 0) {
      out.push({ service: RECOVERY.service, metric, to: iso(view.to), readings: view.extended });
    }
  }
  return out;
}

/**
 * What this store was able to learn about the world, in every reply that depends on it.
 *
 * The unreachable branch is the one that matters. Without it a desk nobody started and a desk that
 * has done nothing produce the same reply, and an agent verifying a rollback would read the first
 * as the second - which is the whole failure this file is arranged against, arrived at by omission.
 */
function worldBlock(world) {
  if (!world.reachable) {
    return {
      source: world.source,
      reachable: false,
      why: world.why,
      note:
        `This store ends at ${store.retention.to} because it could not ask ops-desk whether anything has been ` +
        "done since. That is not the same as knowing nothing has been done, and it may not be read as such.",
    };
  }
  const extended = extendedSeries(world);
  return {
    source: world.source,
    reachable: true,
    now: iso(world.now),
    deployed: world.deployed[RECOVERY.service] ?? null,
    remediations: world.remediations.length,
    note: world.remediations.length
      ? `ops-desk reports ${world.remediations.length} remediation(s), the last at ${iso(world.remediations.at(-1).at)}. ` +
        (extended.length
          ? `${RECOVERY.service}'s ${RECOVERY.metrics.join(" and ")} run to ${extended[0].to}; every other series in this ` +
            `store still ends at ${store.retention.to}, because a client timeout does not decide what they do.`
          : `No series runs past ${store.retention.to} even so - query_range's \`why_it_ends_here\` names the reason.`)
      : `ops-desk reports nothing done since ${store.retention.to}, so this store ends where its fixture ends.`,
  };
}

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
function windowOf(from, to, { defaultTo, defaultSpanMs = DEFAULT_WINDOW_MS } = {}) {
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

  /**
   * The default upper bound is the store's `now`, and the store's `now` follows ops-desk.
   *
   * It was the fixture's 14:20, which was correct until a rollback could put a reading after it.
   * Left there, `list_annotations` with no window would have filtered out the rollback it was
   * called to find, and the default `query_range` window would have ended one minute before the
   * only readings an agent was verifying against.
   */
  const upper = parsed.to ?? defaultTo;
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
function coverageOf(from, to, endMs) {
  const overlapFrom = Math.max(from, RETAINED_FROM);
  const overlapTo = Math.min(to, endMs);

  return {
    covered: overlapFrom <= overlapTo,
    from: overlapFrom,
    to: overlapTo,
    /** The spans asked for and not held, as spans rather than as a boolean. */
    missingBefore:
      from < RETAINED_FROM
        ? { from: iso(from), to: store.retention.from }
        : null,
    missingAfter: to > endMs ? { from: iso(endMs), to: iso(to) } : null,
  };
}

/**
 * Where the store starts, where this series stops, and what the clock says - in one block.
 *
 * `to` is the end of the series being asked about and `in_fixture` is where the checked-in numbers
 * stop. They differ only after a remediation, and when they differ the difference is the answer to
 * the question the caller is asking, so it is published rather than left to be worked out.
 */
const retentionBlock = (world, view = null) => ({
  from: store.retention.from,
  to: iso(view ? view.to : RETAINED_TO),
  resolution_s: store.retention.resolution_s,
  now: iso(nowOf(world)),
  in_fixture: store.retention.to,
  // Only where there is one series to count it for. On a store-wide reply `extended_by: 0` beside a
  // list of extended series is two answers to one question.
  ...(view ? { extended_by: view.extended } : {}),
});

/**
 * The raw points of one series inside a window, with their indices.
 *
 * Inclusive at both ends, which is a choice and is stated in every tool description. A window of
 * 14:00 to 14:20 holds 21 points, not 20, and an agent comparing two adjacent windows would
 * otherwise count the boundary minute twice without either reply saying so.
 */
function rawPoints(view, from, to) {
  const values = view.values;
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
        "Also the retention window and the scrape interval, which bound every query_range answer, and whether " +
        "any series runs past the end of that window because a remediation on ops-desk moved the world on.",
      annotations: READ_ONLY,
    },
    async () => {
      const world = await readWorld();
      const extended = world.reachable ? extendedSeries(world) : [];
      return text({
        /**
         * The retention is per series now, so the store-wide block says where the fixture stops and
         * `extended` names anything that goes further. Published together rather than as one number,
         * because a single retention end would have to be wrong about one of the two.
         */
        retention: { ...retentionBlock(world), extended },
        world: worldBlock(world),
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
          "three it is rather than answering with an empty series. " +
          (extended.length
            ? `${extended.map((s) => `${s.service} ${s.metric}`).join(" and ")} run to ${extended[0].to}, past the ` +
              `${store.retention.to} the fixture stops at, because ops-desk reports a remediation since. Every other ` +
              "series still stops there."
            : `Every series stops at ${store.retention.to}.`),
      });
    },
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
        "Both ends of the window are inclusive. The store's retention is per series: a query wider than it is " +
        "served for the overlap and flagged `truncated`, and one entirely outside it is an error rather than an empty " +
        "series, because no points reads as a flat metric. Check `truncated` before treating what came back as the whole picture. " +
        "Two series - checkout-api's latency_p99_ms and error_rate - run past the fixture's last reading once ops-desk " +
        "reports a remediation, because a client timeout decides what they do; `world` says what this store was told.",
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

      const world = await readWorld();
      const view = viewOf(service, metric, world);

      const asked = windowOf(from, to, { defaultTo: nowOf(world) });
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

      const cover = coverageOf(asked.from, asked.to, view.to);

      /**
       * A window with no overlap at all is an error, not an empty series.
       *
       * This is the single most important refusal on this server. Ask for yesterday, get `points:
       * []`, and the honest reading - "this store does not go back that far" - is exactly as
       * available as the wrong one - "the metric was not moving then". An agent building a
       * baseline picks the wrong one, because the wrong one lets it finish.
       *
       * A window after the end has a second reading now and it is the more dangerous one: "there is
       * no reading yet" and "the rollback did nothing" are the same empty chart. So the message says
       * which series ends where and why this one ends where it does.
       */
      if (!cover.covered) {
        return text({
          error: "outside_retention",
          message:
            `This store holds ${store.retention.from} to ${iso(view.to)} for ${metric} on ${service}, and the window ` +
            "asked for lies entirely outside it. No points are returned, and that is reported as an error rather than " +
            "as an empty series, because an empty series reads as a metric that was not moving.",
          requested: {
            from: iso(asked.from),
            to: iso(asked.to),
          },
          /** Which of the reasons this series stops where it does, rather than leaving it to be guessed. */
          why_it_ends_here: endedBecause(service, metric, view, world),
          retention: retentionBlock(world, view),
          world: worldBlock(world),
        });
      }

      const raw = rawPoints(view, cover.from, cover.to);

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
          retention: retentionBlock(world, view),
          world: worldBlock(world),
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
        /**
         * Buckets start at the first reading served, not at the store's retention origin.
         *
         * Anchored to `RETAINED_FROM`, a window whose lower bound was not on the bucket grid got
         * its first bucket stamped *before the window it asked for*: `from: 12:00:30Z` with
         * `step_s: 300` returned a point at 12:00:00Z and reported it as `served.from`, beside
         * `truncated: false` and `missing_before: null` - a reply claiming to have served exactly
         * the window asked for, with a timestamp outside it at the front. On this server that is
         * the whole class of failure being defended against: the number is arrived at honestly and
         * is wrong, and nothing in the reply says so.
         *
         * The global grid looked like it bought comparability between two queries. It did not:
         * that first bucket held four minutes rather than five, so the same label carried a
         * different value in a differently-bounded query - which is worse than an offset grid,
         * because it is invisible.
         *
         * The first served reading is used rather than `cover.from` so that every `at` this server
         * emits stays an instant something was actually scraped at. `rawPoints` already starts at
         * the first scrape on or after the lower bound, so this is inside the requested window by
         * construction, and the documented step-change trap - the 13:55 bucket at `step_s: 300`
         * from an aligned 13:40 - is unmoved, because an aligned window anchors where it did.
         */
        const origin = Date.parse(raw[0].at);
        const buckets = new Map();
        for (const point of raw) {
          const start = Math.floor((Date.parse(point.at) - origin) / bucketMs) * bucketMs + origin;
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
        retention: retentionBlock(world, view),
        world: worldBlock(world),
        /**
         * The flag, named so it cannot be skimmed past, and paired with the spans it is about.
         * warehouse does the same for a page of rows, and for the same reason: a partial result
         * treated as the whole one is a false number arrived at honestly.
         */
        truncated,
        missing_before: cover.missingBefore,
        missing_after: cover.missingAfter,
        /**
         * The instants somebody changed the world inside the served span, so a step change in these
         * points has its marker beside it the same way the 13:58 deploy does.
         *
         * A recovery is a step change downwards, and a step change with nothing next to it is the
         * half of a finding that says nothing on its own - which is the sentence this whole store
         * opens with.
         */
        remediations_in_window: world.remediations
          .filter((entry) => entry.at >= cover.from && entry.at <= cover.to)
          .map((entry) => ({ at: iso(entry.at), action: entry.action, service: entry.service, to: entry.to })),
        downsampled,
        aggregation: downsampled ? definition.aggregation : "none",
        note: [
          truncated
            ? "This is not the whole window you asked for. The spans in missing_before and missing_after are " +
              "outside what this store retains, and nothing may be concluded about them - in particular they " +
              "are not flat, and they are not zero."
            : null,
          view.extended > 0
            ? `The last ${view.extended} reading(s) are after ${store.retention.to}. They exist because ops-desk ` +
              `reports a remediation, and they are what this store's own readings were the last time ${RECOVERY.service} ` +
              `ran with the ${RECOVERY.dependency} client timeout it is running with now.`
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
        "window is empty, is not fully retained, or spans a moment somebody changed the world - a ratio against a window that " +
        "was never measured, or one averaged across a rollback, is a number arrived at honestly and wrong. Put the comparison " +
        "window entirely after the remediation you are verifying.",
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

      const world = await readWorld();
      const view = viewOf(service, metric, world);

      const windows = {};
      for (const [name, from, to] of [
        ["baseline", baseline_from, baseline_to],
        ["compare", compare_from, compare_to],
      ]) {
        const parsed = windowOf(from, to, { defaultTo: nowOf(world) });
        if (parsed.error) return text({ ...parsed.error, window: name });
        windows[name] = parsed;
      }

      const summaries = {};
      for (const [name, asked] of Object.entries(windows)) {
        const cover = coverageOf(asked.from, asked.to, view.to);
        const points = cover.covered ? rawPoints(view, cover.from, cover.to) : [];
        summaries[name] = {
          requested: {
            from: iso(asked.from),
            to: iso(asked.to),
          },
          retained: cover.covered && !cover.missingBefore && !cover.missingAfter,
          missing_before: cover.missingBefore,
          missing_after: cover.missingAfter,
          /** Every remediation inside this window, whether or not it moved the series. */
          remediations_inside: world.remediations
            .filter((entry) => points.some((p) => Date.parse(p.at) >= entry.at) && points.some((p) => Date.parse(p.at) < entry.at))
            .map((entry) => ({ at: iso(entry.at), action: entry.action, service: entry.service, to: entry.to })),
          /**
           * The ones this window has readings from two different worlds either side of.
           *
           * A window from 14:15 to 14:21 around a rollback at 14:21 holds six minutes at 2000ms and
           * one at 305ms. Its mean is 1756ms, a number that describes neither and reads as a
           * service half way better; its max is whichever world was worse. Nothing in either says
           * the window was two windows, so a summary across it is refused rather than served.
           *
           * A restart is not one of these. It changes what the instances are and does not change
           * what this store's arithmetic says the series does, so the readings either side of it
           * are one world - and refusing there would deny the verify step the number it most needs,
           * which is the one showing that nothing improved.
           */
          straddles: straddlesOf(points, world),
          ...(summarise(points, metric) ?? { points: 0 }),
        };
      }

      /**
       * Why a change is refused rather than computed, in the reply rather than in a comment.
       *
       * An empty window is still the case that matters. The last step of an investigation is "did
       * the rollback help", and until ops-desk reports one this store ends where its fixture does.
       * A tool that answered `mean_ratio: null` and left it at that would let "recovered" be
       * written on the strength of a field nobody read; a tool that answers with a reason cannot be
       * misquoted so easily.
       *
       * A partly-retained window is refused for a smaller reason that goes the same way. The mean
       * of a window missing half its minutes is the mean of the half that was kept, and nothing in
       * the number says which half.
       *
       * A straddling window is the third, and it only became possible once these readings could run
       * past a rollback. It is the same failure in a new place: a mean over a window with the
       * remediation inside it is a mean of two different worlds, and it lands somewhere between
       * them - which is a number that shows a partial recovery that nothing partially recovered.
       */
      const blocked = Object.entries(summaries)
        .filter(([, w]) => w.points === 0 || w.straddles.length > 0 || !w.retained)
        .map(([name, w]) => {
          /**
           * A straddle outranks a short window, because the two are usually both true of the same
           * ask and only one of them is dangerous. "14:15 to 14:35" around a rollback at 14:21 runs
           * past the last reading *and* spans the rollback; told only the first, an agent trims the
           * end and asks again, and the second refusal is the one it needed.
           */
          const why =
            w.points === 0
              ? "no_points_in_window"
              : w.straddles.length > 0
                ? "window_straddles_remediation"
                : "window_not_fully_retained";
          return {
            window: name,
            why,
            /**
             * The window this store could actually have answered, where there is one.
             *
             * `bad_step` names `nearest_valid` for the same reason: a refusal that does not say what
             * would have worked costs a round trip, and the round trip is where an agent starts
             * inventing a window instead of reading one.
             */
            retained_part:
              w.points > 0 && !w.retained ? { from: w.from, to: w.to } : null,
            detail:
              why === "no_points_in_window"
                ? `This store holds ${store.retention.from} to ${iso(view.to)} for ${metric} on ${service} and has no ` +
                  `readings in ${w.requested.from} to ${w.requested.to}. ${endedBecause(service, metric, view, world)} ` +
                  "If you are checking whether something recovered after an action, this is a fact about the evidence, " +
                  "not a result you may round up to recovery."
                : why === "window_straddles_remediation"
                  ? `${w.straddles.map((r) => `${r.action} at ${r.at}`).join(", ")} falls inside this window, and there are ` +
                    "readings on both sides of it. A summary across it is a summary of two different worlds and lands " +
                    "between them, which reads as a partial recovery that nothing partially recovered. Move this window " +
                    "so it lies entirely on one side of the remediation you are verifying."
                  : w.missing_before
                    ? "This window reaches back before the store does, so a mean over it is a mean over the part that was " +
                      "kept, and nothing in the number says which part."
                    : `This window runs past ${iso(view.to)}, the last reading this store has for ${metric} on ${service}. ` +
                      `The part it does hold is ${w.from} to ${w.to} - ask for that if it is the window you meant. A summary ` +
                      "of the readings that exist, presented under the window you asked for, reads as though the rest were " +
                      "measured and flat.",
          };
        });

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
        retention: retentionBlock(world, view),
        world: worldBlock(world),
        note:
          (change === null
            ? "No change was computed. See `refused` - the reason is a fact about the evidence, and the honest report is that this comparison could not be made. "
            : "") +
          (store.metrics[metric].percentile
            ? "This is a percentile metric, so mean_of_points is the average of ninety-ninth percentiles and is not itself a percentile. " +
              "Compare on max, and quote max in a report. "
            : "") +
          /**
           * How thin the new half of the evidence is, said before anybody quotes it.
           *
           * ops-desk's clock advances a minute per remediation, so the window after a rollback is
           * one reading long unless more was done. One scrape is one scrape: it is a real
           * observation and it is not a trend, and the difference matters most in exactly the
           * sentence somebody is about to write with it.
           */
          (change !== null && summaries.compare.points <= 2 && Date.parse(summaries.compare.from) > RETAINED_TO
            ? `The comparison window is ${summaries.compare.points} reading(s) taken since the remediation. That is an ` +
              "observation rather than a trend, and it should be quoted as the number of readings it is. "
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
        "The deploy markers, config changes, scaling events and campaign starts drawn on these dashboards, in time order, " +
        "and the remediations ops-desk reports having taken. This is what makes correlation possible: an annotation on the " +
        "same minute a series steps is the finding, and neither half says anything alone - which is as true of a recovery " +
        "as of a regression. Deploy annotations carry the ops-desk deploy id, so the two servers can be cross-checked.",
      inputSchema: {
        from: WHEN.optional(),
        to: WHEN.optional(),
        service: ID.optional(),
        /**
         * `remediation` is its own kind and is not folded into `deploy`.
         *
         * A rollback changes what is deployed and it is not a deploy: `list_deploys` on ops-desk has
         * no row for it, so an agent filtering `kind: "deploy"` and cross-checking every id against
         * that desk would be handed one that does not resolve. The `deploy_id` on it is the version
         * the service was returned to, which does resolve.
         */
        kind: z.enum(["deploy", "config", "scale", "campaign", "remediation"]).optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ from, to, service, kind }) => {
      const world = await readWorld();

      /**
       * A wider default than query_range's, because annotations are cheap and a deploy outside the
       * metric window is exactly the one worth seeing.
       *
       * The metric store keeps two hours. The deploy that a rollback returns the service to shipped
       * the previous day, and an agent that only ever sees the retained window would never learn
       * that it exists. Annotations are not bounded by retention and the reply says which of them
       * fall outside it.
       */
      const asked = windowOf(from, to, {
        defaultTo: nowOf(world),
        defaultSpanMs: 7 * 24 * 60 * 60 * 1000,
      });
      if (asked.error) return text(asked.error);

      /**
       * The remediations, drawn on the same timeline as everything else.
       *
       * A recovery is a step change downwards, and a step change with no marker beside it is the
       * half of a finding that says nothing on its own. These are the marker. They are labelled
       * with where they came from, because this store did not observe them - ops-desk reported
       * them, and a reader deciding how much to trust a correlation should know which.
       */
      const reported = world.remediations.map((entry, index) => ({
        id: `ACT-${String(index + 1).padStart(2, "0")}`,
        at: iso(entry.at),
        kind: "remediation",
        service: entry.service,
        deploy_id: entry.to,
        title:
          entry.action === "rollback_deploy"
            ? `${entry.action} - ${entry.service} returned to ${entry.to}`
            : `${entry.action} on ${entry.service}`,
        text:
          "Taken on ops-desk, not observed here. This store draws it because a series that steps beside it is the " +
          "only evidence a remediation worked.",
        source: "ops-desk",
      }));

      const held = [...store.annotations, ...reported];
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
           *
           * Measured against the furthest any series runs, not against the fixture's end: a
           * rollback at 14:21 is exactly the annotation somebody wants to chart, and reporting it
           * as unchartable when checkout-api's latency does run to 14:21 would send them away from
           * the one query that answers their question.
           */
          within_retention: Date.parse(note.at) >= RETAINED_FROM && Date.parse(note.at) <= widestEnd(world),
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
        reported_by_ops_desk: reported.length,
        retention: retentionBlock(world),
        world: worldBlock(world),
        note:
          "An annotation beside a step change is a correlation and not a cause. Before you name one, check whether the " +
          "series moved before it too, and whether anything else on this list is nearer. Annotations are kept beyond " +
          "the metric retention window: within_retention says whether query_range can show you the series at that moment. " +
          "Anything with `source: ops-desk` is a remediation that desk reports having taken; this store did not observe it.",
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
        "Every rule, its threshold, how long the condition must hold, and what it was doing at the moment this store " +
        "was written. A rule that pages carries the ops-desk alert id it raised. A rule that is NOT firing is evidence too: " +
        "a dependency inside its own objective is a dependency nobody should be paged about. `still_breaching` re-reads " +
        "the threshold against the latest reading, which is the honest way to ask whether a remediation worked.",
      inputSchema: {
        state: z.enum(["firing", "ok", "all"]).optional(),
        service: ID.optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ state = "all", service }) => {
      const world = await readWorld();
      const held = store.alert_rules;
      const matched = held.filter(
        (rule) => (state === "all" || rule.state === state) && (!service || rule.service === service),
      );

      /**
       * The threshold, read again against whatever the latest reading now is.
       *
       * `state` is what the rule was doing at the fixture's own `now`, and it stays that: a stored
       * fact this server did not compute and must not quietly rewrite. But after a rollback that
       * stored fact is the wrong answer to "is it still broken", and a server that publishes only
       * the stored one hands an investigation a firing rule beside a recovered series and lets it
       * pick. Both are published, and the note says which is which.
       */
      const latestFor = (rule) => {
        if (!rule.metric || !holdsSeries(rule.service, rule.metric)) return null;
        const view = viewOf(rule.service, rule.metric, world);
        const at = iso(view.to);
        const value = view.values[view.values.length - 1];
        const breaching = rule.comparator === "<" ? value < rule.threshold : value > rule.threshold;
        return { at, value, breaching };
      };

      return text({
        searched: { state, service: service ?? null },
        held: held.length,
        matched: matched.length,
        rules: matched.map((rule) => {
          const latest = latestFor(rule);
          return {
          ...rule,
          /** The most recent reading behind this rule, and whether it still breaches the threshold. */
          latest,
          still_breaching: latest?.breaching ?? null,
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
              : Date.parse(rule.since) >= RETAINED_FROM && Date.parse(rule.since) <= widestEnd(world),
          };
        }),
        retention: retentionBlock(world),
        world: worldBlock(world),
        note:
          "`pages: false` means the rule fires onto a dashboard and raises no alert, so it will not appear in ops-desk. " +
          "`alert_id` is the ops-desk alert this rule raised, where it raised one. `state` is what the rule was doing at " +
          `${store.now}; \`still_breaching\` is the threshold read against the latest reading, which is later than that ` +
          "once ops-desk reports a remediation. They disagree exactly when something has changed, and that disagreement " +
          "is the finding. `null` means the rule has no series to read - RULE-EXPORT watches a job's exit status.",
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
  describe: () => {
    /**
     * /health is answered synchronously, so it cannot ask ops-desk - it reports what the last query
     * was told, labelled with that desk's own clock rather than with a wall time.
     *
     * The alternative was a health line that keeps saying "to 14:20" while `list_metrics` says
     * "to 14:21", which is one server giving two answers about its own retention. Stale and
     * labelled is a fact; current-looking and wrong is the thing this whole file is against.
     */
    const world = lastWorld ?? noWorld("no tool call has asked ops-desk yet");
    const extended = world.reachable ? extendedSeries(world) : [];
    return {
      read_only: true,
      services: SERVICES.length,
      metrics: METRICS.length,
      retention: `${store.retention.from} to ${iso(widestEnd(world))}`,
      retention_in_fixture: `${store.retention.from} to ${store.retention.to}`,
      extended_series: extended.map((s) => `${s.service} ${s.metric} to ${s.to}`),
      world_as_last_read: world.reachable
        ? `ops-desk at ${iso(world.now)}, ${world.remediations.length} remediation(s)`
        : world.why,
    };
  },
});
