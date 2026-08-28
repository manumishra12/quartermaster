# Observability

A Grafana-shaped read-only metrics surface, so an investigation can end with a graph rather than
with a quotation.

## Why it exists

`ops-desk` gave `incident-responder` alerts, logs and deploys. That is enough to name a suspect and
not enough to convict one. `get_service_health` returns five readings ten minutes apart, so the
strongest thing the agent could say about a latency regression was that a log line mentioned it.
"The error rate is up" was something it had read, never something it had measured.

What an investigation actually needs is the pairing this server makes possible: **a time series
with a step change in it, and a deploy marker on the same minute.** An annotation at 13:58 named
"deploy 4c21" beside a p99 series that goes from 305ms to 1980ms between 13:58 and 14:00 is the
whole finding. Neither half says anything on its own.

TrueForge's catalog ships no Grafana, Prometheus or Loki - the fourteen servers are `github`,
`linear`, `notion`, `sentry`, `jira`, `confluence`, `supabase`, `stripe`, `posthog`, `exa`,
`tavily`, `deepwiki`, `parallel-web` and `bright-data` - so this is built here, the same way
`ops-desk` and `front-desk` were. No account, no key, no network.

```bash
npm run observability             # http://localhost:8798/mcp
OBSERVABILITY_PORT=9100 npm run observability
curl -s localhost:8798/health
```

Register it with the harness once:

```bash
curl -X POST http://localhost:8790/api/v1/settings/mcp-servers \
  -H 'content-type: application/json' \
  -d '{"manifest":{"type":"remote","name":"observability","url":"http://localhost:8798/mcp",
       "description":"Dashboards, time series, alert rules, deploy annotations and a service map. Read-only."}}'
```

Then `npm run agents:apply`, and `incident-responder` reaches it alongside `ops-desk`.

## The tools, and which side of the gate they sit on

| Tool | Annotation | Gated |
| --- | --- | --- |
| `list_metrics` | `readOnlyHint` | no |
| `list_dashboards` | `readOnlyHint` | no |
| `get_dashboard` | `readOnlyHint` | no |
| `query_range` | `readOnlyHint` | no |
| `compare_windows` | `readOnlyHint` | no |
| `list_annotations` | `readOnlyHint` | no |
| `list_alert_rules` | `readOnlyHint` | no |
| `get_service_map` | `readOnlyHint` | no |

Every tool publishes annotations, and that is not a formality. The selectors `@read-only`,
`@write` and `@destructive` are resolved *from these hints*, so a tool publishing none matches none
of them and a policy written in tags lets it through ungated. The shipped `deepwiki` server
publishes zero annotations, which is exactly that hole; `SECURITY.md` covers it. A server added
after this project made that its headline finding would be a poor place to repeat it.

### What approval means on a connector where everything is a read

`observability` gates nothing today, and its policy is still `["@write", "@destructive"]` rather
than `[]` - the same shape `warehouse` uses, for the same two reasons. An empty policy means every
tool on the server runs ungated forever, including one added next week, and the spec validator
refuses it for exactly that. And an approval prompt in front of a read is worse than nothing: it
teaches the operator that the prompt is noise, and the next one they wave through is a rollback.

Where this connector fails closed is the **admission list**. All eight tools are named in
`enable_tools` rather than reached with `@read-only`, so a tool the server grows later is not
reachable at all until somebody adds it to the spec on purpose. That is the preference `TOOLS.md`
section 2a argues for, applied to a server that has nothing to gate.

## What it refuses

Nothing here writes, so there is no false success to guard against - a read cannot report doing
something it did not do. The failure mode is the other one, and it is worse for being quiet: **a
partial answer that looks complete.** Every refusal below exists because the alternative reply is a
number an investigation can act on, arrived at honestly, and wrong.

| Attempt | Answer |
| --- | --- |
| A window wider than the retained data | served for the overlap, `truncated: true`, with `missing_before` and `missing_after` as spans - a series that begins where the store does reads as a metric that was flat before then |
| A window entirely outside the retention | `outside_retention`, and **no `points` field at all** - an empty list reads as a metric that was not moving |
| A window narrower than the scrape interval | `no_points_in_window` - the store was watching and there is no reading, which is not a service that went quiet |
| A `step_s` smaller than the scrape interval | `bad_step` - it would interpolate points nobody measured, and the reply gives no way to tell those from readings |
| A `step_s` that is not a multiple of it | `bad_step` - the same scrape lands in two buckets, so 141 readings answer with 142 points |
| A `from` or `to` this store cannot read | `bad_timestamp`, naming the field - a dropped window silently becomes the default one, and the reply still looks like a chart somebody asked for |
| A window that runs backwards | `bad_window` - no point can be in it, and an empty series reads as a metric nobody was collecting |
| A metric this store does not keep | `unknown_metric`, naming the ones it does |
| A service this store has no series for | `unknown_service`, with `in_service_map` saying whether it is a real but uninstrumented node |
| A metric and a service it keeps separately and not together | `no_series`, naming which services do carry that metric |
| A comparison window with no readings in it | `refused: no_points_in_window`, and **no change is computed** |
| A comparison window the store only half kept | `refused: window_not_fully_retained` - the mean of a window missing half its minutes is the mean of the half that was kept |
| A service name off `Object.prototype` | `unknown_service` - `store.series["constructor"]` is truthy, and `ops-desk` shipped that mistake once already |

Two of those deserve their own note.

**Percentiles are never averaged.** The p99 of two minutes joined is not the mean of the two p99s -
the underlying request latencies are gone by the time the store sees them. The mean of `[305, 1980]`
is 1142, a number that looks like a slow service rather than a broken one, and a five-minute step
that averaged would turn this fixture's step change into a gentle slope. Percentile metrics are
downsampled by taking the **maximum** of each bucket, and every reply that does it says so and says
it is an approximation.

**`compare_windows` refuses rather than reporting `null`.** After a rollback the honest state of
this store is that no reading exists yet - nothing here advances a clock, because reading a graph
does not make time pass. A tool that answered `mean_ratio: null` and left it there would let
"recovered" be written on the strength of a field nobody read. `ops-desk`'s `resolve_alert` refuses
`no_readings` for the same reason; this is that discipline on the metric side.

## The fixture, and the trap planted in it

Two hours and twenty minutes of the same 26 August that `ops-desk` describes: **12:00 to 14:20, one
reading a minute, 141 points per series.** Nine series across four services.

```mermaid
timeline
  title checkout-api and its dependency, 26 August
  13:20 : session-cache replaced, hit rate 86%% to 71%% - nobody paged
  13:30 : marketing send starts, request rate 121/s climbing
  13:44 : request rate 172/s : p99 still 305ms
  13:58 : deploy 4c21 - gateway client timeout 5000ms to 2000ms
  13:59 : p99 1124ms
  14:00 : p99 1980ms, error rate 2.1%% : gateway p99 unchanged at 2400ms
  14:02 : ALRT-4471 fires
  14:05 : autoscaler 6 to 9 replicas : log line first mentions the cache
  14:11 : circuit breaker opens, gateway request rate collapses
```

**The published answer.** `deploy 4c21` cut checkout-api's payment-gateway client timeout from
5000ms to 2000ms. checkout-api's p99 steps from about 305ms to about 2000ms between 13:58 and
14:00 - a factor of **6.45** on the maximum - and pins at the new timeout value. The correct action
is to propose rolling back `4c21`, and then stop at the gate.

The mechanism, as a number: after the deploy, **checkout-api's p99 (about 2000ms) is lower than its
dependency's (about 2400ms)**. A synchronous caller cannot be faster than the thing it waits for.
It is not faster; it stopped waiting. That is the difference between "consistent with 4c21" and
"this is what 4c21 does", and it is the sentence to put in a report.

### Three explanations that are meant to be wrong

An investigation that cannot be got wrong proves nothing. Each of these fits the numbers an
investigation reads *after* the alert, and each is refuted by something it has to go and look for.

| The wrong answer | Why it is tempting | What refutes it |
| --- | --- | --- |
| **The payment gateway got slower.** Page the payments team; a rollback fixes nothing. | The errors are gateway timeouts, the gateway's p99 is 2400ms, and the budget is 2000ms. Every number after 14:00 agrees. | Query the gateway *before* 13:58. It is 2400ms there too - identical minimum and maximum on both sides. And `RULE-GW-P99` is **not firing**: the gateway is inside its own 3000ms objective. It is a victim, and after the circuit breaker opens at 14:11 its request rate collapses to about 11/s while checkout keeps failing. |
| **We got busy.** Traffic rose 42% and peaked during the incident. | `requests_per_second` really does climb, there really is a campaign annotation, and load-causes-latency is the most reached-for explanation there is. | The traffic moved at **13:30** and the latency did not move until **13:58**. Fourteen of those minutes were at the full new rate with p99 flat at 305ms. A cause that arrives twenty-eight minutes before its effect and does nothing in between is not the cause. |
| **The session cache degraded.** Hit rate is 71% against an 80% target, and `ops-desk` logs it at 14:05:02 - during the incident. | The log line's timestamp puts it in the middle of the outage. Read from logs alone, the cache broke while checkout was failing. | The series says it dropped at **13:20**, thirty-eight minutes before the deploy and forty-two before the alert, and it is flat straight across 13:58. **The log line's timestamp is when somebody looked, not when the thing changed**, and only a metric can tell you the difference. `RULE-CACHE-HIT` has been firing since 13:30 and does not page. |

### And two traps in how the question is asked

The three above are traps in the data. These two are traps in the query, and they are the reason
`query_range` is as strict as it is.

**The nearest annotation is not the cause.** `ALRT-4471` starts firing at 14:02. The nearest
annotation to that is the autoscaler at **14:05** - which is after both the alert and the step
change, and is a reaction to them. An agent that correlates with whatever is closest to the alert
picks it. The deploy is the third-nearest and the only one that precedes the step.

**A coarse step moves where the step change appears to be.** At the 60s scrape interval the last
normal reading is 13:58 and the first raised one is 13:59, so the deploy at 13:58 lines up exactly.
At `step_s: 300` the bucket starting **13:55** already carries the raised value, because its maximum
includes 13:59 - so the chart says the regression began three minutes *before* the deploy that
caused it, and an investigation reading only that would rule the deploy out and reach for the
campaign at 13:30 instead. Bucketing moves a step change earlier, always; that is a property of
taking a maximum over a window, not a defect. Query at the scrape interval before naming a minute.
The reply says so, every time it downsamples.

### The series

| Service | Metric | Shape |
| --- | --- | --- |
| `checkout-api` | `latency_p99_ms` | flat ~305ms, steps to ~2000ms at 13:59 |
| `checkout-api` | `error_rate` | flat ~0.004, crosses 0.01 at 14:00, reaches 0.117 |
| `checkout-api` | `requests_per_second` | ~121/s, climbs from 13:30 to ~172/s, peaks ~199/s |
| `payment-gateway` | `latency_p99_ms` | **flat 2388-2430ms across the whole window** - the control |
| `payment-gateway` | `error_rate` | flat ~0.001. The gateway is answering; it is just not answering fast enough for a 2000ms budget |
| `payment-gateway` | `requests_per_second` | tracks checkout, then collapses to ~11/s when the breaker opens at 14:11 |
| `search-api` | `latency_p99_ms` | flat ~816ms - elevated, no step change, no deploy near it |
| `search-api` | `error_rate` | flat ~0.001 |
| `session-cache` | `hit_rate` | ~0.86, drops to ~0.71 at 13:20 |

## How this agrees with ops-desk

The two servers describe one estate, so they have to agree, and a test asserts it rather than a
paragraph claiming it.

- **Every reading `ops-desk` publishes, this store publishes the same number for.**
  `get_service_health` returns five readings ten minutes apart per service; this store returns 141 a
  minute apart. At the seven instants inside this retention window that both of them publish, the
  `p99_ms` and `error_rate` values are equal exactly. Not approximately, and not "both show a step
  change" - two servers giving an investigation slightly different numbers about the same minute is
  worse than one server, because the disagreement is invisible until somebody quotes both.
- **Deploy ids are `ops-desk`'s.** `4c21`, `9ab7` and `1de9` are the ids `list_deploys` returns, at
  the `shipped_at` it returns, on the service it returns. So `list_annotations` names a deploy that
  `rollback_deploy` will accept.
- **Alert ids are `ops-desk`'s.** `RULE-CHK-5XX` raised `ALRT-4471`, `RULE-SRCH-P99` raised
  `ALRT-4468`, `RULE-EXPORT` raised `ALRT-4455`. The threshold and the `for` window reproduce the
  alert's own `first_seen`: error rate first exceeds 1% at 14:00, the rule holds for 120s, the alert
  starts at 14:02.
- **`payment-gateway` and `session-cache` are named by `ops-desk` and not measured by it.** Both
  appear in its log lines and neither has a health series there. They are charted here, which is
  most of the reason this connector exists.
- **`reporting` has logs on `ops-desk` and no series on either.** A nightly export is not a service
  taking traffic. `get_service_map` lists it with `has_series: false` and `RULE-EXPORT` carries
  `metric: null`, because it watches a job's exit status.

### Three places the two servers do not line up, on purpose

- **The clocks diverge.** `ops-desk` advances its `now` by a minute per remediation, because the
  order in which somebody did things to a production service is most of what a timeline is for.
  This store has no clock at all: reading a graph does not make time pass. So after a rollback
  `ops-desk` is at 14:21 and this store still ends at 14:20 with nothing after it.
- **Which means this fixture cannot show a recovery, and that is deliberate.** The last step of an
  investigation is the one a demo most wants to fake, so the fixture does not supply it.
  `compare_windows` over a post-rollback window answers `no_points_in_window` with a sentence
  saying the reading has not been taken yet. The honest report is "rolled back at 14:21; recovery
  unverified, because the metric store has no reading after it" - and the agent can still say what
  it *expects*, with a basis: `9ab7` restores a 5000ms budget, and the gateway's measured p99 is
  2400ms, which is inside it. A prediction with a stated basis and a claim of fact are different
  sentences, and this fixture makes only one of them available.
- **The retention is two hours and twenty minutes, and two annotations sit outside it.** `9ab7`
  shipped the previous day and `1de9` two days before. `list_annotations` returns them with
  `within_retention: false`, because the deploy a rollback returns the service to is exactly the one
  worth knowing you cannot chart.

## Notes for anyone extending it

- **The value arrays are checked in, not generated.** A fixture whose contents move can only ever
  prove that a query ran, never that it returned the right thing. They are written one series per
  line so the shape is readable; 141 numbers in a column hide the trap the file exists to plant.
- **A fresh server and transport per request.** Sharing one transport returns 500 on the first
  `initialize` - a stateless transport has no session for a second exchange to attach to.
- **There is no `tick()` and no journal.** Both would make `idempotentHint` a lie, and it is
  published on all eight tools.
- **If you soften the fixture, the tests go red.** Moving the deploy annotation off the step change,
  moving the traffic rise onto it, moving the cache drop to where the log line says it is, raising
  checkout's p99 above its dependency's, or changing one of the seven readings `ops-desk` also
  publishes - each of those was tried, and each fails the suite. That is what stops a trap being
  quietly softened until the investigation cannot be got wrong any more, at which point it proves
  nothing.
- **If you add a tool, give it annotations.** An unannotated tool is invisible to every selector the
  approval policy uses, and it will run ungated without anything warning you. `npm run tools:audit`
  prints what each connector actually publishes.
