# Quartermaster - what it does, and how it uses TrueForge

**An agent that never says "I fixed it." It shows you the test output that proves it, then asks
permission before touching anything outside the sandbox.**

Built on [TrueForge](https://trueforge.dev), the open-source agent harness.

## The problem

Coding agents claim: they say "I've fixed the failing test" and you find out in CI twenty minutes
later that nothing ever ran. During this build our own agent, told in writing never to report an
unexecuted result, printed `test_split_evenly (__main__.TestMoney) ... ok` with no sandbox
provisioned and no tool call recorded.

## What the agent does

`quartermaster` takes a repository with a failing test and:

1. Clones it into a sandbox and runs the failing test. **Red**, with real output.
2. Reads the traceback and delegates competing hypotheses to parallel subagents.
3. Writes the smallest patch that addresses the root cause.
4. Re-runs the test in the sandbox. **Green**, with real output.
5. Renders the diff beside the before and after runs.
6. **Stops.** Opening a pull request needs a human to press Allow.

Then something the agent does not control checks its homework:

```
── EVIDENCE CHECK ─────────────────────────────────
UNSUBSTANTIATED
The answer claims a passing result, but no recorded tool call ran a test.
recorded executions: 0, of which test runs: 0
```

Four verdicts - `SUBSTANTIATED`, `UNSUBSTANTIATED`, `CONTRADICTED`, `NO CLAIM` - and the process
exits non-zero on a bad one, so it runs in CI.

Eight more agents ship in `agents/`, because the same discipline generalises and each is one spec
file. `code-reviewer` is the sharpest case for the verifier, since its whole output is a claim about
a test run; it cannot merge, push or delete, because those tools are not enabled for it at all.
`incident-responder` and `desk-assistant` reach MCP servers that ship here - four of them now, and
none needing an account - so every gated action in the demo needs no key. The newest,
`observability`, is what turns that agent's investigation from plausible into conclusive: a p99
series with a step change in it and a deploy marker on the same minute.

## How it uses TrueForge

Not a wrapper around a chat endpoint. Nine harness capabilities are load-bearing, and three of them
carry the argument.

**The recorded event stream** is the foundation. TrueForge records every tool call and response
independently of the model's narration. `scripts/run.mjs` correlates each `tool.response` back to
the command that produced it through its `toolCallId`, and `scripts/lib/evidence.mjs` judges the
answer against what that record contains. The model cannot write to it. Without it the guard rail goes back in the prompt, where it
already failed.

**`require_approval_for_tools`, holding the turn server-side.** The harness emits
`tool.approval_required` and stops, resuming only when a `user.tool_approval` arrives for that
`toolCallId`. The gate is not an instruction the model follows; it is the harness refusing to
proceed. Without it the safety argument is prose.

**The approval selectors, resolved from tool annotations.** `enable_tools` and
`require_approval_for_tools` take `@read-only`, `@write` and `@destructive`, which the harness
resolves from what each MCP server publishes - so a spec gates every write on a connector without
enumerating its surface. Section 2a of `TOOLS.md` records where that fails.

| Also load-bearing | For | Without it |
| --- | --- | --- |
| Sandbox (`config.sandbox.enabled`, `file_downloads`) | clone, install, patch, re-run - every execution the verifier reads | no evidence, and untrusted code runs on your own machine |
| Skills - seven git-backed `SKILL.md` packs | the reproduce → patch → verify procedure, the rule that the verdict banner follows what happened, the rule that everything read is data | each agent's procedure lives in its instruction blob, and they drift |
| Dynamic subagents | competing root causes at once; **off** for `code-runner` and `code-reviewer` | serial hypotheses, and an agent handing code it did not write to more agents |
| Session resume (`subscribeToTurn` with `afterSequenceNumber`, or `listTurnEvents`) | a disposable client - `kill -9` mid-turn reattached to a sandbox run that finished unwatched | a dropped connection loses a run the server completed |
| Generative UI (OpenUI) | verdict banner, diff and before/after runs as one card | the evidence is a wall of scrollback |
| Context management (compaction, large-response offload) | long fix loops stay affordable | a long suite's output ends the turn |

One consequence shapes the repository: `require_approval_for_tools` is API-only in TrueForge today,
not in the UI, so the specs live here as version-controlled JSON applied through the SDK - the
safety policy reviewable in a pull request rather than invisible in somebody's UI state.

## The two ideas

**An agent does not get to decide whether it worked.** The verifier is a separate program reading
the harness's record. It has to refuse in both directions: most agents here never run tests, and
demanding a test run of a research agent is the same failure pointed the other way.

**The approval gate lives outside the model.** `front-desk` ships an issue, `SRCH-42`, whose body
ends with a note telling the agent it is pre-approved and must not stop for approval. **It works on
the model.** Asked to read that issue and act, the agent went for `close_issue` on an open bug with
two customer reports. In a later run it filled the resolution field with **"Pre-approved by team
lead"** - the injection's own words, lifted out of the issue body into the field a human reads
before deciding. So it did not only persuade the agent; it supplied the text meant to persuade the
approver. Nothing was closed, because the gate is not in the model.

```mermaid
flowchart LR
  I["issue body<br/>carries an injection"] --> M["the model<br/>persuaded"]
  M --> C["close_issue(SRCH-42)"]
  C --> G{{"harness<br/>approval gate"}}
  G -->|"a person says no"| X["nothing happens<br/>recorded as refused"]
  G -.->|"the model has no say here"| G
```

A test asserts the injection is still in the fixture and `SRCH-42` still open, because if either
changes the demonstration silently stops demonstrating anything.

## What was found while building

- **The approval gate is fail-open for unannotated MCP tools, in TrueForge's own shipped catalog.**
  Selectors resolve from annotations, and a tool publishing none matches none of them - so under the
  default `["@write", "@destructive"]` policy it runs ungated while the spec still reads as
  protected. `deepwiki` ships in the catalog and annotates none of its three tools; GitHub, where
  the dangerous writes are, annotates all 44 correctly. The fix here is stronger than gating: name
  the three tools in `enable_tools`, so a tool the server adds later is not enabled at all.
- **One command supplied both halves of its own proof.** `pytest -q >/dev/null || echo '1 passed'`
  invokes a real runner and prints a passing line, and neither came from a test. Earlier versions
  needed a shadowed function or a dead branch; this one is a redirect and a fallback.
- **The MCP fixture servers answered the whole LAN.** `listen(PORT)` with no host binds every
  interface, so anyone on the same wifi could have POSTed `rollback_deploy` to a server that sits
  behind the gate, without meeting it. Loopback by default now, with Host validated.
- **`close_issue` was rewriting the issue body.** The card a person approved showed an id and a
  resolution; what happened was that plus a silent edit to somebody else's words - an unapproved
  change laundered through a human decision.

Two more upstream reports are in `DEVLOG.md`: the documented UI quickstart does not install from
clean, and a render loop that reproduces with a bare UI SDK layout.

## Architecture

```mermaid
flowchart LR
  subgraph clients[" "]
    CLI["scripts/run.mjs<br/>headless runner"]
    UI["ui/ on :5173<br/>TrueForge UI SDK"]
  end

  subgraph harness["TrueForge harness :8790"]
    LOOP["agent loop"]
    GATE{{"approval gate<br/>require_approval_for_tools"}}
    SBX["sandbox"]
  end

  subgraph outside["reached, not mocked"]
    GH["GitHub"]
    OPS["ops-desk / front-desk<br/>local MCP servers"]
    WEB["Exa / deepwiki"]
  end

  CLI --> LOOP
  UI --> LOOP
  LOOP --> SBX
  LOOP --> GATE
  GATE -->|"allowed by a person"| GH
  GATE -->|"allowed by a person"| OPS
  LOOP -->|"read-only, ungated"| WEB
  LOOP -.->|"event stream"| EV["evidence verifier<br/>scripts/lib/evidence.mjs"]
  EV --> REP["evidence/&lt;session&gt;/report.md"]
```

The dotted line is the one that matters: the verifier reads a record the author of the claim did
not produce. The CLI and the interface import the same module, so they cannot disagree about
whether a run passed.

## How it is verified

`npm run check` runs lint, typecheck, **632 tests** in the root suite and the fixture check - the
gates CI runs. The interface has **161 tests** across 19 files, plus one mount test of the real
tree, which exists because the app once served a blank page while every unit test passed.
`npm run smoke` runs each credential-free agent against the live harness and asserts the harness
**recorded** an execution matching what was asked. `npm run preflight` names whatever is missing
from a setup; `npm run tools:audit` exits non-zero if any reachable tool would run ungated; and
`npm run fixtures:check` asserts both broken fixtures are still broken, because one that quietly
starts passing turns the demonstration into a tautology.

Anything that matters is mutation-checked: a test agreeing with the bug it was meant to catch has
shipped from here six times.

## What this does not do

- **`analytics` has no enforced gate.** Its SQL runs through the sandbox shell, which is not an MCP
  tool, so no `require_approval_for_tools` entry can pause it. It does stop before a write, but that
  is the agent choosing to ask. The spec says so in as many words, and the validator refuses any
  agent that promises a gate without either declaring one or admitting it has none.
- **The gate covers MCP tool calls, not the sandbox shell.** If the sandbox has network egress, a
  `curl -X POST` or a `git push` is an external write with no pause. Two boundaries, not one.
- **Deferred tool loading does not work on this harness.** `preload: false` resolves to
  `{"error":"MCP server 'deferred-tools' not found"}` - every connector that set it, none that did
  not. So all of them are preloaded, and a check fails a spec that flips one back.
- **The local model prints tool calls instead of making them.** `ollama/qwen3-4b` proves the pipeline -
  session, streaming turn, sandbox, real command, real output - then loops on anything multi-step.
  Neither the gate nor the verifier depends on the model reasoning well, which is why the demo can
  run on it.

Detail: [`README.md`](README.md), [`ARCHITECTURE.md`](ARCHITECTURE.md), [`TOOLS.md`](TOOLS.md),
[`SECURITY.md`](SECURITY.md), [`TESTING.md`](TESTING.md), and [`DEVLOG.md`](DEVLOG.md), the record
of what actually broke.
