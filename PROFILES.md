# Profiles

There are two ways to run the observation side of this project, and the default is the one that
needs no accounts.

This document says what each profile is, what changes between them, and - which matters more than
either - which of the two has actually been exercised. One of them has. The other is a documented
path written from upstream documentation, and it is labelled as that throughout rather than
presented as a thing somebody has run.

## Why there are two, rather than one

The hackathon rules ask for two things that pull against each other.

The first, verbatim: **"keep private, personal, and login-protected information out of your repo and
your demo"**. The second: **"A clear README with setup steps"**.

An agent that watches a production estate is the obvious build. It is also the build where the
demonstration is somebody's real Grafana, the setup step is "create a service account", and the
repository grows a URL that points at an organisation's internal monitoring. Every one of those is
the thing the first rule asks you not to do, and each of them makes the second rule harder to
satisfy honestly, because "sign up, provision, wait" is not a setup step a judge with fifteen
minutes can follow.

So the default profile observes something that ships in this repository, and the production profile
is a swap.

## The default profile: fixtures

The agents in `agents/` are configured against MCP servers that live in `mcp/`. They are servers,
not mocks: their read tools return a fixture, and their write tools genuinely mutate state that
cannot be undone from inside the process. An approval gate in front of an operation that does
nothing proves nothing.

| Server | Port | Registered as | Reached by | Started with | Account |
| --- | --- | --- | --- | --- | --- |
| `ops-desk` | 8795 | `ops-desk` | `incident-responder` | `npm run ops-desk` | none |
| `front-desk` | 8796 | `front-desk` | `desk-assistant` | `npm run front-desk` | none |
| `warehouse` | 8797 | `warehouse` | `analytics` | `npm run warehouse` | none |

Those ports are read from the code rather than from prose: each server's default is in its own
source (`OPS_DESK_PORT`, `FRONT_DESK_PORT`, `WAREHOUSE_PORT`), and the same three appear in the
`LOCAL_SERVERS` map in `scripts/lib/connector-advice.mjs`, which is what lets a failed connection
name the command that would fix it. All three bind `127.0.0.1` by default. Each accepts a
`*_HOST` override that prints a warning naming the consequence.

**There is no `observability` server on this branch.** `mcp/` holds `ops-desk`, `front-desk`,
`warehouse` and the shared HTTP shell in `lib/`, and nothing in `README.md`, `TOOLS.md`,
`AGENTS.md`, `agents/` or `scripts/` mentions Grafana or Prometheus. One is being added on another
branch. When it lands it will need a port that does not collide with 8795 to 8797, an entry in
`LOCAL_SERVERS` so a refused connection can name its start command, and a row in this table.
Inventing its port here would be exactly the kind of documentation this project keeps finding to be
wrong.

### What the default profile actually needs

Being precise, because "no accounts" is a claim and this document is about not making claims
loosely.

**It does not need:** a Grafana instance, a Prometheus instance, a service account token, an API key
for any observability vendor, Docker, Kubernetes, or any container at all. Nothing in the observation
path requires a login, so nothing login-protected is in the repository or in the demo.

**It does need:** Node 22.14 or later, Python 3 for one fixture, the TrueForge harness
(`npx @truefoundry/trueforge`), and one model provider key configured in the harness - which may be
a local OpenAI-compatible endpoint such as Ollama rather than a paid account. `warehouse` also wants
its SQLite fixture built once (`cd fixtures/warehouse && sqlite3 warehouse.db < seed.sql`), and it
refuses to start rather than serving an empty database if you have not.

So the honest form of the claim is not that `git clone && npm install && npm run demo` is the whole
of it. It is that **everything the agents observe ships in this repository**, and the only credential
anywhere in the default path is a model key that is configured in the harness and never touches the
repository. Eight of the twelve agents run with no credential beyond that, including five of the
hackathon's six cards. A judge clones, installs, starts three local servers, applies the specs, and
runs.

`npm run demo` walks the demonstration one beat at a time and checks its own preconditions before
anything is on camera: the harness answering, twelve agents applied, both desks running with unspent
fixtures. It prints each command and waits rather than running it, and that is deliberate for the
one that matters - a pipe cannot approve, so a demo script that typed `allow` on your behalf would
be disproving the claim it exists to show.

## The argument: the observation surface is provider-agnostic

What the agents in this repository actually depend on is a shape, not a vendor.

`incident-responder` needs alerts to read, a health series to correlate them against, deploys to
correlate both against, logs to separate two explanations that fit the same evidence, and
remediations that sit behind a gate. `ops-desk` provides that shape from a fixture. Grafana and
Prometheus provide the same shape from a real estate. The agent's instructions name none of them:
they say "errors, events, releases, timings", "establish what changed and when", and "you say what
you want to do, why the evidence supports it, and what happens if you are wrong - then wait."

That is not an accident of writing. Two of these agents were originally built against named vendors
and had to be rebuilt when the vendor turned out to be the dependency. `desk-assistant` was written
against Linear and `incident-responder` against Sentry, and without those accounts `agents:apply`
skipped both - so the two agents the hackathon calls its easiest start and its hero project were
the two nobody could run:

```
skipped  desk-assistant      - Unknown MCP server "linear" - not configured (HTTP 422)
skipped  incident-responder  - Unknown MCP server "sentry" - not configured (HTTP 422)
```

The rebuild kept the shape and dropped the vendor. What the specs gained by it is worth stating,
because it is the second reason the default is the fixture rather than the real thing: `ops-desk`,
`front-desk` and `warehouse` annotate every tool they publish. The approval selectors `@read-only`,
`@write` and `@destructive` are resolved from those annotations, so a server that publishes none
matches none of them and its writes run ungated. The fixture servers are what a correctly annotated
server looks like, and their annotations can be read in this repository rather than trusted.

A third-party server's annotations cannot be. That is the constraint the production profile is
written around.

## The production profile: real Grafana and Prometheus

Everything from here is a **documented path, not an exercised one**. It has not been run. What has
been verified is stated as verified, with its source; everything else is written from the upstream
repositories' own documentation and should be checked against the servers themselves before it is
relied on.

### The two upstream servers

**`grafana/mcp-grafana`** is maintained by Grafana Labs. Verified from its README on 2026-08-28:

- **A live Grafana instance is required**, along with authentication. The README: "If using service
  account token authentication, create a service account in Grafana with enough permissions to use
  the tools you want to use, generate a service account token."
- **Grafana 9.0 or later.** The README: "**Grafana version 9.0 or later** is required for full
  functionality. Some features, particularly datasource-related operations, may not work correctly
  with earlier versions due to missing API endpoints."
- Configured by `GRAFANA_URL` and `GRAFANA_SERVICE_ACCOUNT_TOKEN`. `GRAFANA_API_KEY` is deprecated
  in favour of the service account token; username and password are an alternative.
- Transport: `-t, --transport` takes `stdio`, `sse` or `streamable-http`, defaulting to `stdio`.
  For the HTTP transports, `--address` defaults to `localhost:8000` and `--endpoint-path` defaults
  to `/mcp`.
- It has flags for restricting what it exposes: `--disable-write` ("Disable write tools
  (create/update operations)"), `--disable-query`, and category flags such as `--disable-datasource`,
  `--disable-prometheus` and `--disable-loki`.

On the tool count: the repository's landing page describes 70+ tools across dashboards, datasources,
Prometheus, Loki, alerting and incidents, with many disabled by default. The README gives no single
headline number and says instead that "The list of tools is configurable, so you can choose which
tools you want to make available to the MCP client." That configurability is the fact worth carrying
forward, not the count.

**`prometheus/prometheus-mcp`** is maintained by the Prometheus organisation. Verified from its
README on 2026-08-28:

- **A running Prometheus is required.** The README describes it as "an MCP server to allow LLMs to
  interact with a running Prometheus instance via the API".
- Configured by `--prometheus.url` / `$PROMETHEUS_MCP_SERVER_PROMETHEUS_URL`, defaulting to
  `http://127.0.0.1:9090`.
- Transport: `--mcp.transport` / `$PROMETHEUS_MCP_SERVER_MCP_TRANSPORT`, taking `stdio` or `http`.
  Tool selection is available through `--mcp.tools` / `$PROMETHEUS_MCP_SERVER_MCP_TOOLS`.
- The documented tool tables list 24 tools, plus 3 TSDB Admin API tools behind
  `--dangerous.enable-tsdb-admin-tools` - 27 documented in total. It had 91 stars when checked.

That last flag deserves a note, because it is this project's own argument arriving from upstream:
the destructive tools are behind a flag whose name is `--dangerous`, off by default. Turning it on
is a decision somebody makes out loud. That is the same reasoning as naming tools in `enable_tools`
rather than admitting them with a tag.

### What actually changes

The swap is confined to one entry per connector in one spec, plus the harness registration. The
agent's instructions, its skills, its routing phrases, the approval loop, the evidence verifier and
the reports do not change at all.

Taking `incident-responder` as the worked case. Today its connector entry is:

```json
{
  "name": "ops-desk",
  "enable_tools": ["@read-only", "rollback_deploy", "restart_service", "resolve_alert"],
  "require_approval_for_tools": [
    "@write", "@destructive",
    "rollback_deploy", "restart_service", "resolve_alert"
  ],
  "preload": true
}
```

**Step 1 - run the upstream servers over HTTP.** The harness registers connectors as
`{"type": "remote", "url": "..."}`, so both need an HTTP transport rather than stdio:

```bash
GRAFANA_URL=https://grafana.example.internal \
GRAFANA_SERVICE_ACCOUNT_TOKEN=... \
  mcp-grafana -t streamable-http --address localhost:8801 --endpoint-path /mcp --disable-write

prometheus-mcp --prometheus.url=https://prometheus.example.internal --mcp.transport=http
```

Confirm the URL each one actually serves from its own startup output before registering it. The
Grafana endpoint path is documented as `/mcp`; `prometheus-mcp`'s HTTP path is not something this
document verified, so read it off the server rather than assuming it matches.

`--disable-write` on the Grafana side is worth taking even though the spec also gates writes. Two
independent restrictions is the shape this repository uses everywhere else - `incident-responder`
names its three destructive tools in `require_approval_for_tools` as well as covering them with
`@destructive`, which is redundant while the annotations are correct and is not redundant against
the day they stop.

**Step 2 - register each with the harness, once.** Same shape as the fixture servers:

```bash
curl -sS --fail-with-body -X POST http://localhost:8790/api/v1/settings/mcp-servers \
  -H 'content-type: application/json' \
  -d '{"manifest":{"type":"remote","name":"grafana","url":"http://localhost:8801/mcp",
       "description":"Grafana dashboards, datasources and alerting."}}'
```

`--fail-with-body` matters: without it curl exits 0 on an HTTP 400 or 500, the command finishes
quietly, and the first sign that nothing was registered is an agent that cannot reach anything.

**Step 3 - audit the annotations before writing a single tag into the spec.**

```bash
npm run tools:audit
```

This is the step to not skip, and it is the reason the production entry below names tools rather
than using selectors. TrueForge resolves `@write` and `@destructive` from the annotations a server
publishes, and a tool that publishes none matches neither - so it runs with no gate while the spec
still reads as protected. That is not hypothetical: `deepwiki`, in TrueForge's own shipped catalog,
publishes no annotations on any of its three tools. `THREAT-MODEL.md` covers the mechanism.

**Whether `mcp-grafana` and `prometheus-mcp` annotate their tools has not been checked here**, and
neither has been connected to a harness in this project. Until somebody has run `npm run tools:audit`
against a live instance of each, the only safe configuration is one that does not depend on the
answer.

**Step 4 - rewrite the connector entry, fail-closed.** Names, not tags, for exactly that reason:

```json
{
  "name": "grafana",
  "enable_tools": [
    "list_alert_rules", "get_alert_rule_by_uid",
    "query_prometheus", "list_datasources", "search_dashboards"
  ],
  "require_approval_for_tools": [
    "@write", "@destructive",
    "list_alert_rules", "get_alert_rule_by_uid",
    "query_prometheus", "list_datasources", "search_dashboards"
  ],
  "preload": true
}
```

The tool names above are illustrative of the shape and must be replaced with the names the server
actually publishes, read from `npm run tools:audit` output rather than from a blog post. Gating a
name the server does not publish gates nothing, which is precisely the silent failure this pattern
exists to avoid.

**Step 5 - satisfy the spec validator.** `scripts/lib/spec.mjs` runs on every apply and in CI, and
it will refuse several plausible versions of this edit. Worth knowing before making it rather than
after:

| Rule | Why it is there |
| --- | --- |
| `require_approval_for_tools` must be present, and must not be empty | an omitted policy is silently defaulted; an empty one gates nothing |
| `enable_tools: ["@all"]` with tag-only approvals is refused | the fail-open shape `SECURITY.md` prescribes against |
| `@all` beside named tools is refused | the names read as a restriction and restrict nothing |
| a gated name that is not enabled is refused | a gate on a tool the agent cannot call |
| an unknown approval tag is refused | it matches nothing and gates nothing, silently |
| a selector listed twice is refused | usually the wrong name typed twice, with the intended one missing |
| `preload: false` is refused | deferred loading resolves to a missing-server error on this harness |
| a connector declared twice is refused | one entry's policy would appear to be the whole policy |

**Step 6 - apply and check.**

```bash
npm run agents:apply
npm run preflight
```

`preflight` reports which of harness, model, sandbox, skills, connectors and agents are missing and
names the fix for each. A connector it cannot read is reported as unread rather than cleared - the
check that could not run is not the check that passed.

**Step 7 - re-read the delegation table.** Changing what an agent can reach changes which handoffs
widen authority, and `handoff.mjs` refuses on that comparison. An `incident-responder` that gains a
Grafana connector no longer has the same reach as it did, so pairs that were previously legal may
now be refused and vice versa. `npm run route -- "<request>"` names the agent it would pick and
prints the whole set that agent may hand on to.

### What does not change, and why that is the point

| Unchanged | Why |
| --- | --- |
| the agent's instructions | they describe alerts, deploys, timings and logs, not a vendor |
| the skills | `incident-triage`, `handing-off` and `untrusted-input` are about the work, not the tool |
| `routing.handles` | the router chooses the agent, which is choosing the authority; the connector is downstream of that |
| the approval loop | `approval.mjs` gates MCP tool calls whatever server publishes them |
| the evidence verifier | it reads the harness event stream, which is the same stream |
| the ledger and the reports | `evidence/approvals.jsonl` records a decision, not a vendor |
| `scripts/lib/connector-advice.mjs` | its `LOCAL_SERVERS` map exists to name a start command for a server this repository ships; a remote Grafana is not one, and it correctly stays out |

One thing worth adding to the last row: a connector failure against a remote server falls through
to the generic advice, which names the URL and credentials in Settings rather than a command. That
is the right answer for a server this repository cannot start, and it is worth checking that the
message reads sensibly the first time somebody points this at a real instance.

## What is verified, and what is not

Stated as a table because this is the part somebody will want to check.

| Claim | Status |
| --- | --- |
| the three fixture servers, their ports and their loopback defaults | verified in this repository's source and its tests |
| the fixture servers annotate every tool | verified by a test in each server's suite |
| six of the nine agents need no credential beyond a model key | verified against `agents/` and `AGENTS.md` |
| `deepwiki` publishes no annotations, and `github` annotates all 44 tools | verified against a live harness on 2026-08-23; recorded in `TOOLS.md` |
| `grafana/mcp-grafana` requires a live Grafana 9.0+ and a service account token | verified from its README, 2026-08-28 |
| `prometheus/prometheus-mcp` requires a running Prometheus | verified from its README, 2026-08-28 |
| the flags, transports and environment variables quoted above | verified from the two READMEs, 2026-08-28 |
| whether either upstream server annotates its tools | **not checked** - audit before trusting any tag |
| the exact tool names either server publishes | **not checked** - the JSON above is shape, not content |
| `prometheus-mcp`'s HTTP endpoint path | **not checked** - read it from the server |
| the production profile end to end | **not run**; no Grafana or Prometheus instance was connected |

The last row is the one to keep in view. Nothing in this repository has ever spoken to a Grafana or
a Prometheus. The swap above is written from upstream documentation and from how the three fixture
connectors are registered and configured here, and it is a plausible path rather than a tested one.
Saying otherwise would be the same failure this project spends the rest of its time refusing: a
reassuring statement that is not true is worse than no statement.
