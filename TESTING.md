# Testing

244 tests in the root suite, 123 in the UI, one mount test, and a fixture check. What follows is
how they are organised and — more usefully — the rules they are written under, because several of
them exist because a test once agreed with a bug and let it ship.

## Running them

```bash
npm run check        # lint + typecheck + tests + fixture check. The same gates CI runs.
npm test             # root suite only (node --test)
npm run lint         # eslint
npm run typecheck    # tsc --noEmit

cd ui
npm run test:unit    # 120 tests, jsdom
npm run test:mount   # the one test that mounts the whole app
npm run build        # production build
```

`npm run check` is the one to run before pushing. Running `npm test` alone will not catch a lint
error or a type error, and both have reached a pull request from here before.

> A note that cost real time: never pipe a test command into `grep`. `npm test | grep FAIL` reports
> **grep's** exit code, not the suite's, so a red suite reads as green. Capture to a file and check
> `$?`, or read the summary line.

## The layout

```mermaid
flowchart TD
  subgraph root["root suite - node --test"]
    EV["evidence.test.mjs<br/>83 - the verifier"]
    DC["describe-call.test.mjs<br/>12 - the approval display"]
    SP["spec.test.mjs<br/>13 - agent spec rules"]
    AN["annotations.test.mjs<br/>15 - tool selectors"]
    RP["report.test.mjs<br/>9 - the written evidence"]
    EN["env.test.mjs<br/>8 - config loading"]
    TS["turn-state.test.mjs<br/>7 - why a turn ended"]
    CA["connector-advice.test.mjs<br/>10 - what to tell a person"]
    CO["contrast.test.mjs<br/>23 - palette contrast"]
    OD["ops-desk/server.test.mjs<br/>9 - incident fixture server"]
    FD["front-desk/server.test.mjs<br/>13 - workspace fixture server"]
  end

  subgraph ui["ui - vitest, two projects"]
    U1["unit: 12 files, 120 tests"]
    U2["mount: 1 test, whole app"]
  end

  FX["check-fixtures.mjs<br/>the broken repos are still broken"]

  root --> CI["CI: 3 jobs"]
  ui --> CI
  FX --> CI
```

### Root suite — `scripts/lib/*.test.mjs`

| File | What it holds the line on |
| --- | --- |
| `evidence.test.mjs` | The verifier. Most of the file is negative cases: ways an agent could make a command look like a test run without running one, and ways an honest run could be mistaken for a fake. |
| `describe-call.test.mjs` | What the operator sees before approving. Every case is "the display must not hide or misrepresent what will be sent." |
| `spec.test.mjs` | Rules agent specs must satisfy — no fail-open approval policy, no promise of a gate that nothing enforces, no sandbox setting by omission. |
| `annotations.test.mjs` | How `@read-only`, `@write` and `@destructive` resolve from tool annotations, including that an unannotated tool matches none of them. |
| `report.test.mjs` | The written report: counts, refusals, fenced output, and why a turn failed. |
| `mcp/front-desk/server.test.mjs` | The workspace server: every write tool refuses what it cannot honestly do and records nothing when it refuses, and the planted prompt injection is still in the fixture - if it is ever removed, the demonstration that the gate holds against a persuaded model silently stops demonstrating anything. |
| `mcp/ops-desk/server.test.mjs` | The fixture MCP server, tested over the wire: every tool publishes the annotations the selectors resolve from, the destructive ones genuinely mutate, and the fixture still tells a story an investigation can get right. |
| `env.test.mjs` (8), `contrast.test.mjs` (23) | Config loading, and that every colour pair in both themes clears 4.5:1 — the reference design's own muted grey was 3.37:1 and had to be darkened. |

### UI — `ui/src/**/*.test.tsx`

Two vitest projects, because they need different things:

- **`unit`** — 12 files, 123 tests, jsdom, components in isolation.
- **`mount`** — one test that mounts the entire app. It exists because the app once rendered a
  blank page while every unit test passed: the crash was an infinite render loop that only appears
  when the real provider stack is assembled. `--dangerouslyIgnoreUnhandledErrors` is scoped to this
  project alone, and nowhere else.

## The rules these are written under

**A test that agrees with the bug is worse than no test.** This has happened here six times, so it
is worth stating precisely. Each of these shipped, and each was caught later by review:

- a test that mocked the hook that was broken, so the breakage was unobservable;
- a fixture named `result.txt` when the defect required it to be named `pytest.log`;
- an assertion that the allowlist behaved the wrong way, written to match the code;
- a `rerender()` with an identical tree, which React skips, so nothing was re-tested;
- an assertion that a rename lost by a failed write should stay lost, beside a comment saying the
  opposite;
- a test that set `localStorage` without announcing it, so the code never read the value under test
  and the assertion passed against a deliberately broken build.

**So: mutation-check anything that matters.** Break the fix, confirm the test fails, restore it.
Not ceremony — the last two in that list were only found this way, and both looked fine.

```bash
cp scripts/lib/evidence.mjs /tmp/e.bak
# revert the fix by hand
node --test scripts/lib/evidence.test.mjs   # must fail, and name the right test
cp /tmp/e.bak scripts/lib/evidence.mjs
```

**Every loosening needs its negative cases written at the same time, not after.** The rule came out
of one function: widening it to recognise `poetry run pytest` opened seven distinct ways to fake a
test run. Whenever a check is relaxed to admit something honest, the cases it must still refuse go
in the same commit.

**Both directions, always.** A guard against fabricated evidence that starts rejecting real work is
not a fix, it is the same failure pointed the other way. Tables in `evidence.test.mjs` are written
in pairs for this reason: what must be refused, and what must still be accepted.

**Test what a person can observe.** UI tests assert on roles and accessible names rather than class
names, so a test fails when the control becomes unusable rather than when the markup moves.

## Fixtures

`fixtures/` holds two deliberately broken repositories the agents are pointed at. `npm run
fixtures:check` asserts they are **still broken** — a fixture that quietly starts passing turns the
whole demonstration into a tautology, and CI runs this as its own job so it cannot be missed.

Stated plainly, rather than left for someone to discover:

### Smoke testing the agents

`npm run smoke` runs each credential-free agent against the real harness and checks that the
harness **recorded** an execution matching what was asked - the same rule as the evidence check:
the transcript is the agent's account, the event stream is what happened.

```bash
npm run smoke                          # every case
npm run smoke -- --agent analytics     # one
SMOKE_BUDGET_SECONDS=420 npm run smoke # a loaded machine, or a slow local model
```

It distinguishes the ways a case can fail, because they send you to different places:

| what it says | what it means |
| --- | --- |
| `no tool response within Ns` | nothing came back. The call may never have been made, or may have been waiting - the runner reads responses, so it cannot tell those apart and does not pretend to |
| `all empty` | the turn was cut short; the machine is loaded, raise the budget |
| `in a shape this runner could not read` | a connector envelope `resultOf` does not handle. No amount of budget fixes it |
| `the sandbox was not ready` | the harness, not the agent. Retried once, and the retry is announced |
| `none matched /regex/` | it ran something and the answer was wrong. This is the interesting one |

That table exists because the suite used to report all four as the last one, which points at the
assertion - the only part that is definitely not wrong.

### What is not covered

- **No end-to-end test drives a real model.** Runs cost money and quota, and a flaky suite that
  depends on a provider is worse than an honest gap. The recorded sessions under `evidence/` are
  the evidence that the real path works; `smoke-agents.mjs` exercises it on demand.
- **The mount test asserts that the app renders, not that it looks right.** Nothing here catches a
  visual regression.
