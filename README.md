# Quartermaster

**An agent that never says "I fixed it." It shows you the test output that proves it, then asks
permission before touching anything outside the sandbox.**

Built on [TrueForge](https://trueforge.dev), the open-source agent harness.

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
npm run agents:apply
npm run preflight               # tells you exactly what is still missing
```

`preflight` reports on the server, model, sandbox, skills, connectors and agents, and names the fix
for each thing it cannot find.

### 4. Point it at something broken

```bash
npm run agent -- "Fix the failing test in fixtures/ledger. Run it first and show me what breaks."
```

Or open the interface:

```bash
cd ui && npm install && npm run dev      # http://localhost:5173
```

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
| `analytics` | sandbox + a SQLite warehouse | instruction-only, see below | **yes** |
| `research-desk` | Exa web search | read-only throughout | **yes** |
| `incident-responder` | Sentry | every remediation | needs Sentry |
| `desk-assistant` | Linear | every create, edit and close | needs Linear |

Start with `quartermaster-local`. It needs no token and touches nothing outside the sandbox.

`analytics` is the honest exception. Its SQL runs through the sandbox shell, which is not an MCP
tool, so there is no `require_approval_for_tools` entry that could gate it. It does pause before a
write, using the harness's question mechanism - but that pause is the agent choosing to ask, not
something outside the agent enforcing it. The spec says so in as many words, and the spec validator
now refuses any agent that promises a gate without either declaring one or admitting it has none.

`incident-responder` and `desk-assistant` can currently only read. Their write tools are not
enabled, because those two connectors' annotations have not been audited and this project's own
rule is not to rely on selectors it has not verified.

`code-runner` is the odd one: subagents are switched **off** for it. It runs code somebody else
wrote, so widening the blast radius by handing that code to more agents is the wrong direction.

## Two fixtures, deliberately broken

| Fixture | Language | The bug |
| --- | --- | --- |
| `fixtures/ledger` | Python, stdlib only | `split_evenly` drops the remainder: 1000 split three ways returns 999 |
| `fixtures/retry` | JavaScript, no deps | off-by-one in the attempt budget: `attempts = 3` calls twice |

And one that is not broken, for the analytics agent: `fixtures/warehouse` is a SQLite seed with
refunds, a cancelled order and three countries, so "what was revenue in Q2?" has a right answer and
a tempting wrong one.

Both tests are correct and both bugs are real. In each, the tempting shortcut is to edit the
expected value - which the agent is explicitly forbidden to do.

`npm run fixtures:check` asserts they are both still failing. A fixture that quietly starts passing
is worse than a red build: the demo still runs, the agent finds nothing to do, and you discover it
on camera.

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
| `scripts/check-fixtures.mjs` | asserts the fixtures are still broken |
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

---

## Development

```bash
npm test                  # 37 tests: evidence rules, contrast, report rendering
npm run fixtures:check    # the fixtures must still fail
npm run tools:audit       # every reachable tool is gated as claimed
cd ui && npm run build    # the interface compiles
```

CI runs all of it on every pull request.

`zustand@^5` is pinned as a direct dependency in `ui/` on purpose. Without it `@openuidev/*` hoists
zustand 4.5.7 to the root, `@assistant-ui/core` cannot find `useShallow`, and the build fails.

## Code review

Every change lands through a pull request reviewed by [Qodo](https://www.qodo.ai). `main` is branch
protected: no direct pushes, no force pushes, no deletions, **including for administrators**.

That last clause is there because Qodo caught its absence. The protection was originally configured
with `enforce_admins: false`, so the repository owner could have pushed straight to `main` while the
README said nobody could. A governance statement that is true for everyone except the person most
able to break it is not a governance statement. Enforcement now applies to admins too.

`.pr_agent.toml` configures what the review looks for. It is deliberately specific to this project
rather than a copy of the defaults - a false SUBSTANTIATED verdict is the worst defect this codebase
can have, so the review is pointed at that first, and at any path where an approval could be granted
without a human keystroke. Inline comments are limited to findings that must change, because this
project's own review turned up the lesson that an alarm which fires on everything is one nobody
reads.

Representative reviewed pull requests:

<!-- Filled in as reviews land. Each entry: what changed, what the review found, what was done. -->

| PR | Change | What the review surfaced, and what was done |
| --- | --- | --- |
| [#2](https://github.com/manumishra12/quartermaster/pull/2) | Qodo configuration and this section | Flagged the README claiming `main` was fully protected while `enforce_admins` was false. Fixed by turning enforcement on for admins rather than by weakening the claim. |
| [#1](https://github.com/manumishra12/quartermaster/pull/1) | Interface rebuild, dual themes, UI tests | _review in progress_ |

## AI assistance

Built with the help of an AI coding assistant, as the hackathon rules permit and require to be
disclosed. Every design decision, the architecture, and the direction of the project are the
author's; the assistant wrote code and drafts against them. The findings recorded in `DEVLOG.md` -
the fail-open gate, the zustand conflict, the agent inventing test output - were discovered while
building, not copied from anywhere.

## Licence

MIT.
