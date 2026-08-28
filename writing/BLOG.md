# I told my agent not to lie. It lied anyway.

*Building Quartermaster on TrueForge, for the Agent Harness Hackathon.*

> The day-one draft, kept for the record. The published post is [`BLOG.md`](../BLOG.md) at the
> repository root, written from the whole build rather than the first two days of it.

The agent had one rule. It was the first line of its instructions, repeated in its skill pack, and
stated twice more in its procedure: **never report a result you did not execute.**

I asked it to fix a failing test. It came back with a clean analysis, a correct patch, and this:

```
**Test output after fix**:
test_split_evenly (__main__.TestMoney) ... ok
```

It never ran anything. No sandbox was provisioned. No tool call was recorded. It wrote that line
the way it writes any other line - because it was the plausible next thing to say.

That is the whole problem, and it happened inside the project built to solve it.

## What I was building

TrueForge is TrueFoundry's open-source agent harness: the runtime layer around a model that gives
it tools, a sandbox, approval gates, subagents and session state. You bring the job; it runs the
loop.

The job I gave it: fix a failing test, and prove the fix. Not "fix it and tell me" - *prove it*.
Show the test failing, show the patch, show the same test passing, and stop for permission before
touching anything real.

The pitch fits on one line. **An agent that never says "I fixed it." It shows you the test output
that proves it, then asks permission before it pushes.**

## Instructions are a request, not a constraint

The obvious way to build this is to write very firm instructions. I did. They did not hold, and on
reflection they cannot: an instruction is just more text in a context window, competing with the
model's pull toward a satisfying answer. A model that is weak enough to skip the tool call is
exactly the model that is weak enough to ignore the rule about skipping the tool call.

So the check moved somewhere the model cannot reach. TrueForge streams an event for everything that
actually happens - `sandbox.created`, `tool.response` with the real exit code and captured output,
`turn.done`. The model writes the transcript. It does not write the event stream.

```
── EVIDENCE CHECK ─────────────────────────────────
UNSUBSTANTIATED
The answer claims a passing result, but no recorded tool call ran a test.
recorded executions: 0, of which test runs: 0
```

Four verdicts: **substantiated** (claims a pass, last recorded run passed), **unsubstantiated**
(claims a pass, nothing ran), **contradicted** (claims a pass, the run disagrees), **no claim**
(reported honestly). It exits non-zero, so it works in CI.

Writing the tests for it caught a bug in the checker itself. The pattern matching a success claim
ended in a word boundary after `pass`, so it matched "the test pass" but not "the test passes" - it
would have missed the exact sentence that motivated the entire feature.

## The approval gate has a hole in it, and it is not TrueForge's fault

TrueForge gates tool calls with a policy on the agent spec. The default is sensible:

```json
"require_approval_for_tools": ["@write", "@destructive"]
```

Those selectors resolve from the annotations each MCP server publishes about its own tools. From
the harness source:

```
@read-only    readOnlyHint === true
@write        readOnlyHint === false and destructiveHint !== true
@destructive  destructiveHint === true
```

Read it carefully. A tool that publishes **no annotations** matches none of them. The harness says
so outright in a comment: *"Unannotated tools are exempt unless named in
`require_approval_for_tools` or covered by `@all`."*

So the default policy is fail-open. Point your agent at a server that does not annotate its tools
and the writes execute with no gate, silently, while your spec still reads as though it is
protected. Nobody has done anything wrong - the server did not annotate, the harness did what it
documents - and the gate is not there.

I wrote a script that walks every connected server, classifies each tool the way the harness would,
and exits non-zero if anything that can act on the world would run ungated. Exa annotates properly.
The one you actually care about is GitHub, because that is where the writes are.

The fix, when a server does not annotate, is to stop depending on it: enable only `@read-only` plus
the literal write tools you want, and name those same tools in the approval policy. Fail closed.

## The unattended path has to be the safe one

The headless runner asks the operator to approve or deny. When stdin is not a terminal - CI, a
pipe, a cron job - there is no operator, so it denies.

That felt obvious once written and was not obvious before. A gate that quietly allows when nobody
is watching is not a gate. It is a formality that happens to be present when observed.

## Two smaller things

**The harness's own UI quickstart does not build on a clean install.** `@assistant-ui/core` wants
`zustand@^5` and imports `useShallow` from `zustand/shallow`; `@openuidev/*` pulls `zustand@4.5.7`,
npm hoists the 4 to the root, and Rollup dies on the missing export. Pinning `zustand@^5` as a
direct dependency fixes it.

**The client is disposable.** I killed a run with `kill -9` mid-turn. The agent carried on
server-side, and reattaching with a stored session id, turn id and sequence number picked up a
sandbox execution that had completed while nothing was connected. The session lives on the server;
the terminal is a viewport.

## What TrueForge actually saved me

I did not write an agent loop, a tool router, a sandbox provisioner, an approval mechanism, session
persistence, or context compaction. I wrote a procedure, a policy, a verifier and an interface. The
harness is not a dependency of this project so much as its substrate - take it out and there is
nothing left to run.

The one thing I would change: the tool approval policy is API-only today, not in the UI. That
turned out to be a gift. It pushed the safety configuration into version-controlled JSON, where it
is reviewable in a pull request instead of invisible in somebody's UI state. I would keep it that
way even after it reaches the UI.

## The point

An agent that acts on your systems is not a chatbot with extra permissions. The interesting
engineering is not making it capable. It is making its claims checkable, its blast radius small,
and its failures loud.

Mine lied on the second day. Now it cannot - not because I asked it not to, but because something
it does not control checks its homework.

---

*Quartermaster is open source and built on [TrueForge](https://github.com/truefoundry/trueforge).*
