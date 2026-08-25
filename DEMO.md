# Demo script

Three minutes. One idea: **the agent does not get to say it worked.**

Record at 1440x900 or larger, dark theme, font scaled up so code is legible on a phone. Have both
fixture repos already cloned in the sandbox before recording - watching `npm install` is not a demo.

---

## 0:00-0:20 — The problem, stated once

> "Every coding agent says 'I fixed it.' Most of the time it never ran anything, and you find out
> in CI twenty minutes later."

Show a real screenshot of that failure. **We have one from this build:** the agent inventing
`test_split_evenly ... ok` with no sandbox and no recorded tool call. Use it. It is the strongest
twenty seconds in the video because it is not hypothetical and it is our own agent.

## 0:20-0:45 — Point it at real work

Type into Quartermaster:

> Both repos have a failing test. Fix them.

Two repos, two languages - Python and JavaScript. Say why that matters:

> "Two independent problems, so the harness fans out to subagents and works on them in parallel.
> Only their conclusions come back."

Show the subagents appearing in the transcript. **This is the Double-O 'work handed to subagents'
beat - do not skip it.**

## 0:45-1:20 — Red, in the sandbox

The rail's **Doing** light goes amber. The transcript shows the clone and the test run.

The **Did** panel fills in with the real failure:

```
AssertionError: 999 != 1000
Ran 5 tests - FAILED (failures=1)
```

Say the line that matters:

> "That output is not the agent describing what happened. It is what the sandbox recorded."

## 1:20-1:50 — The fix, and the proof

The diff appears. Small - two lines in one, one character in the other. Then the re-run, and the
**Did** panel flips green with `OK`.

> "Same panel, same source. It only turns green when a real run turns green."

## 1:50-2:20 — The gate

The agent wants to open a pull request. Everything stops.

Read the approval card aloud: the tool, the repo, the branch. Pause. Then **deny it first.**

> "Deny, and nothing happens. That is the point."

Then run it again and allow. The PR appears on GitHub.

Denying before allowing is worth the ten seconds: anyone can show a button that says Allow.

## 2:20-2:50 — The part nobody else has

Open the terminal and run the same job headless with the verifier on. Show the closing block:

```
── EVIDENCE CHECK ───────────────────────
SUBSTANTIATED
Backed by 2 recorded run(s); the last one passed.
```

Then the honest version - the transcript where the agent claimed a pass with nothing behind it:

```
UNSUBSTANTIATED
The answer claims a passing result, but no recorded tool call ran a test.
```

> "The claim is checked against the harness's event stream, which the model cannot write to.
> It exits non-zero, so it works in CI."

## 2:50-3:00 — Close

> "Sandboxed execution, a gate before anything irreversible, and a verdict the agent cannot fake.
> Quartermaster. Built on TrueForge."

---

## Shot checklist

Every judged criterion, and the second it appears:

| Criterion | Where |
| --- | --- |
| real tools through MCP | 0:20 (GitHub), 1:50 (the PR) |
| code running in a sandbox | 0:45 |
| pause before anything irreversible | 1:50 - denied first, then allowed |
| work handed to subagents | 0:20-0:45 |
| session survives reconnect | mention at 2:20; `--resume` clip if time |
| interface shows doing / waiting / did | the rail, continuously |

## Do not

- Do not narrate what is on screen. Say what it means.
- Do not show a key, a token, or a `.env`. Judges look.
- Do not speed up the test run. The waiting is the product.
- Do not claim a track. Show the work and let them place it.
