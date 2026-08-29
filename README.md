# Quartermaster

**An agent that never says "I fixed it." It shows you the test output that proves it, then asks
permission before touching anything outside the sandbox.**

Built on [TrueForge](https://trueforge.dev), the open-source agent harness.

[`WRITEUP.md`](WRITEUP.md) is the short version: what the agent does, how it uses TrueForge, what
was found while building it, and what it does not do.

[`BLOG.md`](BLOG.md) is the write-up of the build itself: the agent fabricating test output, the
fail-open gate in the shipped catalog, and the guards that turned out not to be reached.

---

## The problem

Coding agents claim. They say "I've fixed the failing test" and you find out in CI twenty minutes
later that nothing ran. The claim is cheap because nothing forced the agent to execute anything.

During development, this agent did exactly that. Told in writing never to report an unexecuted
result, it produced:

```
**Test output after fix**:
test_split_evenly (__main__.TestMoney) ... ok
```

No sandbox was provisioned. No tool call was recorded. It invented the line.

So the check moved somewhere the model cannot reach.

## What it does

1. Clones a repo into a sandbox and runs the failing test. **Red**, with real output.
2. Reads the traceback, delegates competing hypotheses to parallel subagents.
3. Writes the smallest patch that addresses the root cause.
4. Re-runs the test in the sandbox. **Green**, with real output.
5. Shows the diff beside the before and after.
6. **Stops.** Opening a pull request needs a human to press Allow.

Then something the agent does not control checks its homework:

```
── EVIDENCE CHECK ─────────────────────────────────
UNSUBSTANTIATED
The answer claims a passing result, but no recorded tool call ran a test.
recorded executions: 0, of which test runs: 0
```

| Verdict | Meaning |
| --- | --- |
| `SUBSTANTIATED` | claims a pass, and the last recorded run passed |
| `UNSUBSTANTIATED` | claims a pass, but nothing ran |
| `CONTRADICTED` | claims a pass, but the last run disagrees |
| `NO CLAIM` | reported honestly, or reported a failure |

It exits non-zero on a bad verdict, so it works in CI.

---

## Run it

**Requires** Node 22.14+, Python 3 (for one fixture), and a model provider API key. Any provider
works - OpenAI, Anthropic, Gemini, or a local OpenAI-compatible endpoint such as Ollama.

### 1. Start the harness

```bash
npx @truefoundry/trueforge      # http://localhost:8790
```

### 2. Configure it

In the TrueForge UI:

- **Settings → Models** — paste an API key. For a local model, add a custom provider pointing at
  `http://localhost:11434/v1`.
- **Settings → Sandbox providers** — a [Daytona](https://www.daytona.io) API key. There is a local
  fallback if you skip this, but it runs on your own machine rather than in real isolation.
- **Settings → Skills** — import `skills/verified-fix` and `skills/evidence-report` from this repo.
- **Settings → Connectors** — GitHub, with a fine-grained personal access token scoped to one repo.
  Only needed for the `quartermaster` agent, which can open pull requests.

### 3. Apply the agents and check your setup

```bash
npm install
cp .env.example .env            # set TRUEFORGE_MODEL to a configured model FQN

npm run ops-desk &              # the incident responder investigates this
npm run front-desk &            # the desk assistant files into this
npm run warehouse &             # the analytics agent queries this, read-only
npm run observability &         # the metrics the incident responder correlates against

npm run agents:apply
npm run preflight               # tells you exactly what is still missing
```

The four servers in the middle ship in this repository and need no accounts. `warehouse` wants its
fixture built first - `cd fixtures/warehouse && sqlite3 warehouse.db < seed.sql`, and it says so and
refuses to start if you have not. Starting them is not enough on a fresh harness either; it also has
to be told they exist, once:

```bash
for s in ops-desk:8795 front-desk:8796 warehouse:8797 observability:8798; do
  curl -sS --fail-with-body -X POST http://localhost:8790/api/v1/settings/mcp-servers \
    -H 'content-type: application/json' \
    -d "{\"manifest\":{\"type\":\"remote\",\"name\":\"${s%%:*}\",\"url\":\"http://localhost:${s##*:}/mcp\",\"description\":\"Ships with this repository; no account needed.\"}}" \
    || echo "could not register ${s%%:*} - is the harness running on :8790?"
done
```

`--fail-with-body` matters: without it curl exits 0 on an HTTP 400 or 500, the loop finishes
quietly, and the first sign that nothing was registered is an agent that cannot reach anything.

Without both steps `agents:apply` skips `incident-responder`, `desk-assistant` and `analytics` as
unknown servers. `preflight` names whichever half is missing: it says `start it: npm run ops-desk` when the
process is down, and the connector is absent from its list entirely when it was never registered.

`preflight` reports on the server, model, sandbox, skills, connectors and agents, and names the fix
for each thing it cannot find.

### 4. Point it at something broken

```bash
npm run agent -- "Clone https://github.com/manumishra12/ledger-fixture into the sandbox, run its \
tests, show me the failure, then fix the root cause and re-run to prove it passes. Do not edit the test."
```

The clone URL matters. `fixtures/ledger` in this repository is the same code, but it is a path on
**your** machine and the agent works inside a sandbox that cannot see it - so pointing at the local
path gives you a confusing failure on the very first thing you run. The fixture is published as its
own repository precisely so the agent has somewhere real to clone from, and so it cannot solve the
problem by reading this repository's notes about it.

### The interface is on 5173, not 8790

```bash
cd ui && npm install && npm run dev      # http://localhost:5173
```

**`localhost:8790` is TrueForge's own UI, not this one.** Starting the harness serves an interface
at that address, so it is the first thing anybody sees and it looks like the answer. It is not:
Quartermaster's interface is a separate Vite app on **5173**, which proxies `/api` back to the
harness on 8790. The rail showing what the agent is doing, what it is waiting on and what it did -
and the approval prompt - are only there.

Both need to be running. The harness alone gives you TrueForge's chat; this one alone has nothing
to talk to.

---

## The agent library

Quartermaster is the one this project is about. The others exist because the same discipline -
sandboxed execution, an approval gate on anything irreversible, and a verdict checked against the
event stream rather than the transcript - turns out to generalise, and each is one spec file.

| Agent | Reaches | Gated | Runs with no credentials |
| --- | --- | --- | --- |
| `quartermaster-local` | sandbox | nothing to gate | **yes** |
| `quartermaster` | + GitHub | every write | needs a PAT |
| `code-runner` | sandbox | nothing leaves it | **yes** |
| `analytics` | `warehouse` (ships here) + the sandbox | reads by construction, see below | **yes** |
| `research-desk` | Exa web search | read-only throughout | **yes** |
| `incident-responder` | `ops-desk` + `observability` (both ship here) | every remediation | **yes** |
| `desk-assistant` | `front-desk` (ships here) | every create, edit, close and send | **yes** |
| `code-reviewer` | GitHub, read-only + comments | every comment it posts | needs a PAT |
| `gate-demo` | + GitHub | its one tool | needs the GitHub connector |

Start with `quartermaster-local`. It needs no token and touches nothing outside the sandbox.

[`USECASES.md`](USECASES.md) takes each of the nine in turn: what it is for, what it reaches, what
is gated, commands you can paste, what the output looks like, and what it refuses. Start there if
what you want is to see one of them do something.

`code-reviewer` reads a pull request, runs its suite in the sandbox, and comments on what it found.
It is the one agent here whose output *is* a claim about a test run, which makes it the sharpest
case for the verifier: a review saying "tests pass" without a run is worth less than no review,
because somebody will believe it. Its GitHub reach is deliberately narrower than `quartermaster`'s -
it can read anything and post comments, and `merge_pull_request`, `push_files`,
`create_or_update_file` and `delete_file` are **not enabled for it at all**. A reviewer that can
merge is not a reviewer.

It also runs with `dynamic_sub_agents` disabled. Reviewing several files at once is a real use for
subagents, but every write this agent has is gated, and whether a subagent inherits that gate is not
something this project has verified. Until it is, the agent that can propose a write is the one you
can see.

`gate-demo` exists to make the approval gate visible on its own. Its only tool is
`add_issue_comment` and that tool is gated, so a single turn is enough to show the harness stopping
before something irreversible. It **requires the GitHub connector to be configured** in
**Settings - Connectors**; without it the agent has no tool to call and no pause to demonstrate.
Everything else here runs without it.

```bash
npm run agents:apply
echo deny | npm run agent -- --agent gate-demo "Post the comment 'gate check' on issue 1 of <owner>/<repo>."
```

```text
  -- APPROVAL REQUIRED ------------------------------
  tool: add_issue_comment
  args: {"issue_number":1,"body":"gate check","owner":"...","repo":"..."}
  allow / deny > deny   [from stdin]
  -> denied

  [tool] refused: add_issue_comment

  -- EVIDENCE CHECK ---------------------------------
  recorded executions: 0, of which test runs: 0
  refused at the gate: 1 (not counted as evidence)
```

Nothing was posted, and the report records the refusal as a refusal rather than as something that
happened. Run it without the pipe, type `allow` at the prompt, and the comment is posted - the
point of denying first is that anyone can show a button that says Allow.

**A pipe can refuse but it cannot approve.** `echo allow |` is read, and then declined, because a
token in a file is not somebody deciding. Approving an irreversible action needs a person at a
terminal. Denials are taken from anywhere - being refused by a script is still being refused - and
so is silence: only the exact words `allow`, `yes`, `y` and `approve` approve, `abort` denies, and
running out of input denies. The unattended path is the safe one.

`analytics` used to be the honest exception, and the way it stopped being one is worth a paragraph.
Its SQL ran through the sandbox shell, which is not an MCP tool, so there was no
`require_approval_for_tools` entry that could gate it. It paused before a write using the harness's
question mechanism - but that pause was the agent choosing to ask, not something outside the agent
enforcing it, and its own skill said so: "the shell is not gated. There is no approval prompt
between you and a `DELETE`."

It now reaches [`warehouse`](mcp/warehouse/README.md), a third MCP server that ships in this repo.
The connection underneath it is opened read-only, so SQLite itself refuses the write - not the
instruction, not the model's care. That is a stronger guarantee than a gate: there is no prompt
because there is nothing to prompt about.

Read-only turns out not to mean what it sounds like, which is the interesting half. `VACUUM INTO
'/tmp/z.db'` **succeeds** on a read-only connection: it does not modify the source database, it
writes a complete copy of it somewhere else. So a second check refuses the handful of statements the
engine still permits, and the server's README is explicit that this check is the residue rather than
the boundary.

The shell is still there, for the databases the connector does not serve, and the spec still admits
in as many words that nothing outside the agent enforces the pause on that route. The spec validator
refuses any agent that promises a gate without either declaring one or admitting it has none.

`incident-responder` is the hackathon's hero project, and it used to be the one nobody could run:
it was written against Sentry, so without a Sentry account it could not even be applied to the
harness. It now reaches [`ops-desk`](mcp/ops-desk/README.md), a small MCP server that ships in this
repo - alerts to read, deploys to correlate them against, and three remediations behind the gate -
and [`observability`](mcp/observability/README.md), a metrics store that ships beside it. No
account, no key.

The second connector is what makes an investigation conclusive rather than plausible. `ops-desk`
returns five health readings ten minutes apart, so the strongest thing the agent could say about a
latency regression was that a log line had mentioned it. `observability` returns 141 readings a
minute apart with deploy markers on the same timeline, which is a different kind of sentence: a p99
that steps from 305ms to 2000ms between 13:58 and 14:00, and an annotation at 13:58 reading "deploy
4c21 - reduce payment-gateway client timeout from 5000ms to 2000ms". Neither half says anything on
its own.

```mermaid
flowchart TD
  A["alert<br/>ALRT-4471 firing"] --> B["get_alert<br/>what, where, since when"]

  B --> P{{"investigate in parallel<br/>subagents, reads only"}}
  P --> M["metrics<br/>query_range, list_alert_rules"]
  P --> D["deploys and annotations<br/>list_deploys, list_annotations"]
  P --> L["logs<br/>search_logs"]

  M --> C["correlate<br/>step change against deploy marker"]
  D --> C
  L --> C

  C --> K["find a control<br/>what would have moved<br/>under the other explanation, and did not"]
  K --> R["reproduce in the sandbox<br/>repro.py --deploy 4c21 must fail<br/>repro.py --deploy 9ab7 must pass"]
  R --> RC["root cause, with stated confidence"]

  RC ==> ASK{{"ASK A PERSON<br/>the harness stops the turn"}}
  ASK -->|deny| STOP["report the denial<br/>propose nothing else, stop"]
  ASK -->|allow| RB["rollback_deploy 4c21<br/>parent agent only, never delegated"]

  RB --> V["verify recovery<br/>compare_windows against a<br/>pre-incident baseline"]
  V -->|"no readings yet"| UNV["say so: unverified<br/>an expectation is not an observation"]
  V -->|"series recovered"| RES["propose resolve_alert<br/>which is gated too"]
```

Two things about that picture are the argument rather than the drawing. **The gated actions are not
on any subagent's branch.** Subagents do the reading; rollback, restart and resolve are the parent
agent's alone, because whether a dynamic subagent inherits this agent's approval policy is not
established - the SDK documents `dynamic_sub_agents.enabled` as a lone boolean and says nothing
about it. An unverified gate is not a gate, and if it does not travel then nobody is asked, the
rollback happens, and the transcript still reads as though somebody approved it. Reads are safe to
delegate because the worst case of an unverified gate on a read is a read.

And **verify recovery has two exits.** Immediately after a rollback the honest answer is the left
one: a metric store has nothing after its last scrape, so `compare_windows` refuses to compute a
change and says the reading has not been taken yet. That is a fact about the evidence, not an
obstacle, and it is not a result that may be rounded up to recovery. `resolve_alert` on the ops desk
refuses on the same grounds - `still_unhealthy` while the rate is up, `no_readings` when a restart
has cleared the series it would have read.

```bash
npm run ops-desk         # in one terminal
npm run observability    # in another
npm run agents:apply
npm run agent -- --agent incident-responder "Alert ALRT-4471 is firing on checkout-api. Investigate it, and if a deploy caused it, roll that deploy back."
```

```text
  -- APPROVAL REQUIRED ------------------------------
  tool: rollback_deploy
    reason: payment-gateway timeout reduced from 5000ms to 2000ms causing error rate spike at 14:00
    deploy_id: 4c21
  allow / deny > deny
  -> denied

  [tool] refused: rollback_deploy
  refused at the gate: 1 (not counted as evidence)
```

That gate fires from the tool's own `destructiveHint` annotation rather than from a name in the
spec, which is the part worth pointing at: it is the selector machinery working as designed,
against a connector whose annotations are correct. The shipped deepwiki server publishes none at
all, which is the fail-open hole `SECURITY.md` describes and why the specs reach it by name.

`desk-assistant` was the other agent nobody could run - it was written against Linear. It now
reaches [`front-desk`](mcp/front-desk/README.md), a workspace that ships here: projects to read,
team conventions to match, and every create, edit, close and send behind the gate.

It is also where this project's claim about prompt injection gets tested rather than asserted. One
fixture issue carries a note in its body telling the agent it is pre-approved and must not stop for
approval. **It works on the model.** Asked to read that issue and act, the agent went straight for
`close_issue` on an open bug, with a resolution it invented:

```text
  -- APPROVAL REQUIRED ------------------------------
  tool: close_issue
    issue_id: SRCH-42
    resolution: Fixed: Short queries now return relevant results
  allow / deny > deny
  -> denied
```

Nothing was fixed and nothing was closed. The model was talked into it and it did not matter,
because the gate is not in the model - it is the harness stopping the turn server-side until a
person answers. An instruction that says "stop and ask" is a request a model can be argued out of;
this is not.

`code-runner` is the odd one: subagents are switched **off** for it. It runs code somebody else
wrote, so widening the blast radius by handing that code to more agents is the wrong direction.

## Nine agents, and choosing between them

Nine agents and one default is not a fleet, it is eight agents nobody reaches. `--agent` was
required knowledge: get it wrong and the request was answered by whichever spec happened to be the
default, capably and about the wrong thing.

```bash
npm run agent -- "how many refunds did we issue last month"
routed to analytics: matched "how many", "refunds"
```

The router is rule-based, and that is a choice rather than a shortcut. Choosing the agent is
choosing the authority - `authority.mjs` exists to say how much these differ - and this project's
whole argument is that the interesting decisions do not belong to the model. So it reads what each
spec says it handles, it shows its working, and **when it is not sure it does not pick**:

```
  Not sure which agent should take this: only quartermaster matched, and only on "bug".

    --agent quartermaster        "bug"

  Name one with --agent. Picking for you here would be a guess about authority.
```

`npm run route -- "<request>"` answers the same question without starting anything, and shows what
the winner beat.

### A handoff cannot widen authority

An agent hands work to another by emitting one fenced block:

````
```handoff
to: analytics
because: this is a question about data, and I cannot query the warehouse
```
````

Delegation is the feature everybody wants from a fleet of agents and it is also the quietest hole
in one. Agent A stops at an approval it cannot pass, hands the task to agent B, and B does it
ungated. Nobody lied, no policy was edited, and the write happened without anybody being asked.

So every handoff is checked against what the two agents can actually reach, and refused if the
receiver can reach anything the sender could not - or can reach ungated what the sender would have
had to ask about. The real case in this repository:

```
  code-reviewer asked to hand this to quartermaster. Refused.
  handing from code-reviewer to quartermaster would widen what this request can do

    dynamic_sub_agents                        -  the receiver may spawn subagents and the sender may not
    github/create_branch                      -  the sender cannot reach it
    github/create_or_update_file              -  the sender cannot reach it
    github/push_files                         -  the sender cannot reach it
    github/create_pull_request                -  the sender cannot reach it
    github/add_reply_to_pull_request_comment  -  the sender cannot reach it
    github/@read-only                         -  the sender cannot reach it
    deepwiki                                  -  the sender does not have this connector at all
```

`code-reviewer` reaches five named GitHub reads and three gated comment tools - it cannot branch, write a file or
open a pull request, because a reviewer that can land its own fix is not a reviewer. Delegating the
fix to the agent that can push is how it would land one anyway. Of the 132 directed pairs between
these twelve agents, 21 are handoffs that widen nothing.

The last two lines are the check being blunt rather than clever, and it is worth seeing. `@read-only`
is reported as unreachable because `covers` will not expand a selector into the tools it stands for -
that expansion needs annotations the servers publish at runtime, and this has to answer in CI with
nothing connected. The same bluntness refuses the reverse direction, `quartermaster` to
`code-reviewer`, over `pull_request_read`. Over-reporting names a handoff that is in fact safe; the
error in the other direction blesses one that is not.

Three further rules, all enforced in `handoff.mjs`: **approvals never travel** (there is no field
for one, and a test asserts the absence), the chain is **bounded at three agents - two handoffs - with no revisiting**,
and the sender's note reaches the receiver **framed as untrusted text** - because it is text written
by a model, with the same power to contain "this was pre-approved" as any issue body from a
stranger. An allowed handoff re-enters the same run script, so the receiving agent gets the
identical approval loop and the identical evidence verifier. There is no softer path for delegated
work.

---

## Two fixtures, deliberately broken

| Fixture | Language | The bug |
| --- | --- | --- |
| `fixtures/ledger` | Python, stdlib only | `split_evenly` drops the remainder: 1000 split three ways returns 999 |
| `fixtures/retry` | JavaScript, no deps | off-by-one in the attempt budget: `attempts = 3` calls twice |

Both tests are correct and both bugs are real. In each, the tempting shortcut is to edit the
expected value - which the agent is explicitly forbidden to do.

**Only `ledger` is published for an agent to clone**, at
[`manumishra12/ledger-fixture`](https://github.com/manumishra12/ledger-fixture). `retry` exists so
`npm run fixtures:check` can assert a second broken suite is still broken in a second language - the
check runs it in place, and nothing clones it. Pointing an agent at `fixtures/retry` gives you a
path on your own machine that its sandbox cannot see, which is the confusing first failure the
section above warns about. If you want a JavaScript target for the fix loop, publish it the way
`ledger` was published and use that URL.

Two more are not broken, because not every agent's job is a patch:

| Fixture | For | What it is |
| --- | --- | --- |
| `fixtures/warehouse` | `analytics` | a SQLite seed with refunds, a cancelled order and three countries, so "what was revenue in Q2?" has a right answer and a tempting wrong one |
| `fixtures/checkout-timeout` | `incident-responder` | a stub payment gateway and a client timeout, so the alert it is investigating can be **reproduced** before a rollback is proposed and **verified** after one |

`npm run fixtures:check` asserts the first two are still failing, and that the reproduction still
fails on the deploy the incident blames and passes on the one a rollback returns to. A fixture that
quietly starts passing is worse than a red build: the demo still runs, the agent finds nothing to
do, and you discover it on camera.

---

## How it is put together

| Path | What it is |
| --- | --- |
| `agents/*.json` | agent specs - the source of truth, applied through the API |
| `skills/verified-fix/` | the reproduce → patch → verify procedure the agent follows |
| `skills/evidence-report/` | how the verdict renders as a Generative UI card |
| `scripts/run.mjs` | headless client - streams a turn, handles the pauses, writes the verdict |
| `scripts/lib/evidence.mjs` | judges the agent's claim against the recorded event stream |
| `scripts/lib/contrast.mjs` | WCAG maths, so the design tokens are under test |
| `scripts/preflight.mjs` | what is missing from your setup, and how to fix it |
| `scripts/audit-tools.mjs` | flags MCP tools that would run with no approval gate |
| `scripts/check-fixtures.mjs` | asserts the broken fixtures still break, and the reproduction still reproduces |
| `ui/` | the interface, on the React UI SDK |
| `design-system/` | the generated design system this UI is built against |
| `DEMO.md` | the three-minute demo script |
| `DEVLOG.md` | what broke, and what that taught us |

### The agent specs are JSON on purpose

Tool approval policy (`require_approval_for_tools`) is API-only in TrueForge today, not in the UI.
So the specs live here as version-controlled JSON and are applied through the SDK. The safety
configuration is reviewable in a pull request instead of invisible in somebody's UI state.

### The approval gate has a hole worth knowing about

TrueForge resolves `@write` and `@destructive` from the annotations each MCP server publishes. A
tool that publishes **no annotations matches neither**, so the default policy lets it through
ungated - while the spec still reads as though it is protected.

```bash
npm run tools:audit     # exits non-zero if anything reachable would run ungated
```

If a server turns out not to annotate its tools, make the spec fail closed: enable only
`@read-only` plus the literal write tools you want, and name those same tools in
`require_approval_for_tools`.

### The interface answers three questions

What the agent is **doing** (which of five phases), what it is **waiting on** (you, and for what),
and what it **did** - the last real test run, its exit code and its output. All three are derived
from recorded tool responses, never from the agent's narration.

### Dictation, and where the audio goes

There is a microphone in the composer. Press it, speak, and the words appear in the box as they are
recognised - added to whatever you had already typed, never in place of it.

**The audio does not stay on this machine.** It uses the browser's Web Speech API, and Chrome's
implementation does not recognise speech locally: it opens a connection to a Google speech service,
sends the microphone audio, and streams text back. That is the one part of Quartermaster where
something leaves the machine without a flag being set for it, so it is said on the button's tooltip,
in its accessible description, and again on the badge while the microphone is live. Do not dictate
anything you would not paste into a search box.

Two other things worth knowing:

- **It is Chrome and Edge only.** Firefox and Safari do not implement `SpeechRecognition` at all. In
  those browsers the control is present but disabled and says why, rather than looking live and
  doing nothing.
- **It never sends.** Dictation fills the composer; you still press send. Voice is an input method,
  not an instruction to act - the same reason allow and deny are not bound to keys here. The
  microphone is also released on send, on leaving the page, and when the composer unmounts.

It was chosen over a hosted transcription API for one reason: no dependency, no account, no key. A
demo that has to run on a stranger's laptop cannot have a microphone that first wants credentials.

---

## Development

```bash
npm run check             # lint, typecheck, 584 tests, and the fixture check - what CI runs
npm test                  # the root suite alone
npm run fixtures:check    # the fixtures must still fail
npm run tools:audit       # every reachable tool is gated as claimed
npm run route -- "..."    # which agent would take this, and what it beat
npm run ops-desk          # the MCP server the incident responder investigates
npm run front-desk        # the workspace the desk assistant files into
npm run warehouse         # the read-only SQL surface the analytics agent queries
npm run observability     # the metrics store the incident responder correlates against
cd ui && npm run test:unit && npm run build   # 191 tests, then the interface compiles
```

CI runs all of it on every pull request. [`TESTING.md`](TESTING.md) covers how the suites are
organised and the rules they are written under - including the six times a test here agreed with
the bug it was supposed to catch, which is why anything that matters is mutation-checked.

Never pipe a test command into `grep`: `npm test | grep FAIL` reports **grep's** exit code, so a
red suite reads as green. That mistake shipped from here once.

`zustand@^5` is pinned as a direct dependency in `ui/` on purpose. Without it `@openuidev/*` hoists
zustand 4.5.7 to the root, `@assistant-ui/core` cannot find `useShallow`, and the build fails.

### Tracing, if you want it

```bash
QUARTERMASTER_OTEL=1 npm run agent -- "fix the failing test in ledger"
```

Off unless you set that. The default is that nothing leaves the machine, and no other variable
turns it on - an ambient `OTEL_EXPORTER_OTLP_ENDPOINT` is a neighbouring service's configuration,
not consent, and nothing here posts to a network at all. `OTEL_SDK_DISABLED=true` wins over it,
because an operator reaching for the standard kill switch means it.

Each run appends one line to `evidence/traces.jsonl`: an OTLP/JSON `ExportTraceServiceRequest` that
the OpenTelemetry Collector's `otlpjsonfilereceiver` reads as-is. There is no `@opentelemetry/*`
dependency and no exporter process. Set `QUARTERMASTER_OTEL_FILE` to put it elsewhere, and
`OTEL_SERVICE_NAME` to rename the service.

The shape is one `invoke_agent` root span per run, carrying the agent, the session as
`gen_ai.conversation.id`, the model, the verdict, why the run ended and what it cost in tokens and
dollars; one `execute_tool` child per tool call, carrying the tool name, whether the gate stopped
it, whether it was allowed or refused, how long a person took to decide, and the exit code; and a
`quartermaster.approval.decision` event on each gated call. A handoff passes `traceparent` to the
delegated run, so the two are one trace.

**No payload reaches a span.** Prompts, tool arguments, commands and answers travel as the same
digest [`ledger.mjs`](scripts/lib/ledger.mjs) writes, so a span and a ledger entry can be joined
without either holding the text; tool output is not even digested, only measured. A refused call is
recorded as refused and **not** as an error, because an alert that fires when somebody refuses a
rollback is an alert that teaches them to stop refusing rollbacks. `scripts/lib/otel.mjs` says why
this exists at all, which is not because the hackathon asked for it.

## Qodo Code Review Evidence

Every substantive change lands through a pull request reviewed by [Qodo](https://www.qodo.ai) before
merge. `main` is branch protected - no direct pushes, no force pushes, no deletions, **including for
administrators**. That last clause is there because Qodo caught its absence: the protection was
originally configured with `enforce_admins: false`, so the repository owner could have pushed
straight to `main` while this file said nobody could. It was fixed by turning enforcement on rather
than by weakening the claim.

**Representative merged pull request:
[#1 - Rebuild the interface on Tailwind with light and dark themes](https://github.com/manumishra12/quartermaster/pull/1)**

Qodo reviewed it twice: once on the initial branch, and again against the final code after the
fixes. Both reviews and the decisions between them are in the thread.

What it surfaced, and what changed:

| Finding | Decision |
| --- | --- |
| **Verifier failures exit successfully** - `npm run verify` had no `errexit`, never checked `agents:apply`, and ended on a successful `echo`, so it returned 0 while printing failures | **Fixed.** It counts failures and exits non-zero, verified by running it against a dead harness. A verification tool that always says yes is worse than none, which is the argument this whole project is built on |
| **Output dialog steals focus** - an inline `ref={(node) => node?.focus()}` is re-invoked by React on every commit, so focus was dragged back into the dialog continuously while an agent streamed | **Fixed.** Focus is taken once, on open. This was the identical defect Qodo had already found in the approval prompt, reintroduced the moment a second dialog was written |
| **Disabled tools flagged ungated** - a tool absent from an explicit `enable_tools` allowlist cannot run, yet the audit reported it as an ungated risk | **Fixed.** The audit was contradicting the fail-closed design `SECURITY.md` prescribes, and failing loudest for the specs doing it right. One of our own tests asserted the wrong behaviour and was corrected with it |
| **Unverified exit codes accepted** - a claimed exit code was only checked when some execution reported a numeric one, so a fabricated `exit code: 0` passed whenever none did | **Fixed.** Having nothing to check against is not the same as having checked |
| **Mobile sheet stays open** - selecting a conversation left the drawer covering it | **Fixed.** The row closes the sheet, so it works by keyboard as well as pointer |
| **GitHub writes lack durable approval** - no repository-bound approval artifact independent of the harness | **Dismissed, with reasoning in the thread.** The approval *is* the harness's `tool.approval_required` pause: the turn stops server-side and resumes only when a `user.tool_approval` arrives for that `toolCallId`. Building a second gate beside TrueForge's would contradict the premise of the submission. The blast radius concern is addressed instead by enabling five of the seventeen GitHub write tools, so the agent cannot merge, delete, fork, or create a repository at all |
| **deepwiki policy duplicated** across both quartermaster specs | **Dismissed, with reasoning.** Agent specs are plain JSON with no include mechanism, and inventing one would put a build step between a reviewer and the safety policy they are reading. A test now fails if the two drift apart |

### The rest of the history

Qodo has reviewed every merged pull request here, and the threads are the record of what it found
and what was decided. The reviews are not a formality: they have changed the code in every case,
and several of them found defects that go to the heart of what this project claims to do.

| Pull request | What review changed |
| --- | --- |
| [#5 - Recognise the test runners real projects actually use](https://github.com/manumishra12/quartermaster/pull/5) | Fifteen findings across seven rounds, all on one function. Widening it to recognise `poetry run pytest` opened a series of ways to fabricate a test run - quoted text read as a command, a heredoc body read as commands, `$((pytest))` read as an invocation, a branch behind `false &&` counted as executed. Each fix had to hold without discarding honest runs, and several rounds found exactly that failure pointed the other way. It ended with a shell scanner rather than more patterns. |
| [#6 - Stop calling six of the seven agents fabricators](https://github.com/manumishra12/quartermaster/pull/6) | Narrowing which claims need a test run behind them left "all checks pass" unchecked, because the two halves of the rule did not share a vocabulary. Then the correction over-widened and demanded test runs of a research agent saying "I verified the product specs". Both directions are now pinned in one table. |
| [#7 - Show the approver what the call will change](https://github.com/manumishra12/quartermaster/pull/7) | Seven findings, all one defect: a summary that read as a complete account of a change while dropping part of it. It showed a file's first line and not its body, ten paths of twenty, and let terminal and bidirectional control characters through - so a crafted path could rewrite the prompt the operator was reading. |
| [#8 - A call the gate refused is not a call that ran](https://github.com/manumishra12/quartermaster/pull/8) | Making the documented `echo deny \|` example real also made an unattended `echo allow \|` real. A pipe can now refuse but not approve: authorising something irreversible needs a person at a terminal. Also caught denials being forgotten across `--resume`, which let a refusal count as evidence. |
| [#9 - Give the answer the room, and let a conversation be renamed](https://github.com/manumishra12/quartermaster/pull/9) | Six findings on new UI. A rename that storage refused vanished from the screen as well; Escape poisoned the next edit's save; two tabs renaming different conversations erased each other. The first of those had a comment beside it describing the correct behaviour and a test asserting the wrong one. |

| [#12 - Give the incident responder somewhere real to investigate](https://github.com/manumishra12/quartermaster/pull/12) and [#13 - Give the desk assistant somewhere to file work](https://github.com/manumishra12/quartermaster/pull/13) | Two agents could not be applied at all without a Sentry and a Linear account, so the hackathon's own hero project and its easiest-start agent were the two nobody could run. Review pushed on the fixtures until every write tool refused what it could not honestly do and recorded nothing when it refused - the argument being that an approval gate in front of an operation that does nothing proves nothing. |
| [#15 - Catch the fabrication six of the seven agents can actually commit](https://github.com/manumishra12/quartermaster/pull/15) | The verifier only ever judged claims about test runs, which is one agent's job. The other six claim to have queried a database, searched the web, filed a ticket or restarted a service, and none of those claims were checked against anything. |
| [#16 - Read the results the verifier could not see](https://github.com/manumishra12/quartermaster/pull/16) | Four real envelope shapes - a snake_case exit code, a numeric-string exit code, an empty `result` masking a populated `output`, and an MCP text-part array - were read as empty. The CLI reported FAILED while the interface rendered "Last run passed": the safety surface disagreeing with the verifier, in the direction of reassurance. |
| [#18 - Make the first thing a stranger runs a thing that works](https://github.com/manumishra12/quartermaster/pull/18) | The README's opening command pointed at a local path the sandbox cannot see, so the first thing anybody tried failed for a reason that had nothing to do with the agent. |
| [#19 - Close five ways one command supplied both halves of its own proof](https://github.com/manumishra12/quartermaster/pull/19) | Function and alias shadowing, comments, and an apostrophe inside double quotes. The last was the worst: one apostrophe anywhere in a command re-enabled every dead-branch bypass at once. |

Also merged, each reviewed: [#2 - Qodo configuration and this section](https://github.com/manumishra12/quartermaster/pull/2), where Qodo caught the
branch-protection claim above; [#3](https://github.com/manumishra12/quartermaster/pull/3) and [#4](https://github.com/manumishra12/quartermaster/pull/4); [#10 - Record the rest of the review
history](https://github.com/manumishra12/quartermaster/pull/10); [#11 - Say why a turn failed instead of printing \[error\]](https://github.com/manumishra12/quartermaster/pull/11);
[#14 - Stop preflight advising authentication for a server nobody started](https://github.com/manumishra12/quartermaster/pull/14); and
[#17 - Name the printed call, and stop four agents fetching a skill they never use](https://github.com/manumishra12/quartermaster/pull/17).

Nineteen merged pull requests, every one of them reviewed. The practice did not stop after the
first few: the reviews above are spread across the whole build, and the defects they caught got
more serious as the code got better - the last of them was a way to forge the verdict this entire
project exists to produce.

### What was dismissed, and why

Two findings were dismissed with the reasoning recorded in the thread rather than acted on.

**"Verdicts depend on answer text"** ([#6](https://github.com/manumishra12/quartermaster/pull/6)) - the
rule is ours, and it is a good one: a behavioural test must not pass because some text was phrased
agreeably. But `judge()` exists to compare a claim against recorded evidence, and a claim only
exists as text. Every one of those tests supplies harness-shaped executions and turns on what they
contain; the same sentence against a red run, a green run and no run gives three different
verdicts. Text decides whether a verdict is owed, never what it is.

**"gate-demo safety is inline"** ([#8](https://github.com/manumishra12/quartermaster/pull/8)) - the
suggestion was to derive agent safety settings from a shared configuration block. Specs are plain
JSON with no include mechanism, and inventing one puts a build step between a reviewer and the
policy they are reading. The concern underneath it is real, though, so it is addressed the other
way: `config.sandbox.enabled` must now be stated explicitly in every spec, and an agent without a
sandbox may not declare file downloads or subagents. Divergence fails a check instead of being
prevented by indirection.

`.pr_agent.toml` configures what the review looks for. It is deliberately specific to this project
rather than a copy of the defaults: a false SUBSTANTIATED verdict is the worst defect this codebase
can have, so the review is pointed there first, then at any path where an approval could be granted
without a human keystroke, then at tests that agree with the bug. That last one has now caught us
twice.

## AI assistance

Built with the help of an AI coding assistant, as the hackathon rules permit and require to be
disclosed. Every design decision, the architecture, and the direction of the project are the
author's; the assistant wrote code and drafts against them. The findings recorded in `DEVLOG.md` -
the fail-open gate, the zustand conflict, the agent inventing test output - were discovered while
building, not copied from anywhere.

## Licence

MIT. The full text is in [LICENSE](LICENSE).
