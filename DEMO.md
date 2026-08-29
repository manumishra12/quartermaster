# Demo script

Three minutes. One idea: **the agent does not get to decide whether it worked, and it does not get
to decide whether it is allowed.**

Record at 1440x900 or larger, font scaled up so code is legible on a phone.

## Before you record

```bash
npm run demo          # checks everything, then walks the beats one at a time
```

It refuses to start if the harness is down, an agent is unapplied, or a rehearsal left a fixture
dirty - which is the one that ruins a take quietly, because a resolved alert and a closed SRCH-42
still *look* fine until the agent says there is nothing to investigate. It prints each command and
waits; it never runs one for you, and for the approval that is the point rather than an omission.

`npm run demo -- --beat 4` jumps to one of them.

```bash
npm run forge          # the harness, :8790
npm run ops-desk       # :8795
npm run front-desk     # :8796
npm run observability  # :8798  - nothing on it is gated, and incident-responder is skipped without it
npm run agents:apply   # preflight should report every agent applied
cd ui && npm run dev   # :5173  <- the interface. 8790 is TrueForge's own UI, not this one.
```

Everything below runs on a **local Ollama model with no API key**, against MCP servers that ship in
this repo. Nothing in this script needs an account, which means it will still work on the day.

> A note on the model. `ollama/qwen3-4b` calls tools correctly but is not strong enough to close a
> long investigation on its own - it reads the right things and then loops. The two beats that
> carry this video are the gate and the verifier, and neither depends on the model reasoning well.
> If you have a working paid key by recording day, put it in the harness and the middle section
> gets better; if not, the script below still holds.

---

## 0:00-0:25 — The problem, stated once

> "Every coding agent says 'I fixed it.' Often it never ran anything, and you find out in CI twenty
> minutes later."

Show the screenshot from this build: the agent inventing `test_split_evenly ... ok` with no sandbox
and no recorded tool call. It is our own agent, which is what makes it worth twenty seconds.

> "So this one is not allowed to tell you. Every claim it makes is checked against what the harness
> recorded — a stream the model cannot write to."

## 0:25-1:05 — The verifier, on a real run

In the terminal:

```bash
npm run agent -- --agent quartermaster-local "Clone the ledger fixture, run its tests, and tell me what happened."
```

Let it reach the sandbox and run the suite. Then read the closing block aloud:

```
  -- EVIDENCE CHECK ---------------------------------
  CONTRADICTED
  The answer says the tests pass; the last recorded run exited 1.
```

> "The agent said one thing. The recording says another. The verifier believes the recording."

If the run comes back SUBSTANTIATED instead, that is also a good beat — show the report under
`evidence/<session>/report.md` and point at the executions it is standing on.

## 1:05-1:50 — The gate, on something irreversible

This is the beat that must land. Switch to the incident responder:

```bash
npm run agent -- --agent incident-responder "The cause is established: deploy 4c21 on checkout-api cut the payment-gateway timeout at 13:58 and the error rate moved at 14:00. Roll back deploy 4c21."
```

```
  -- APPROVAL REQUIRED ------------------------------
  tool: rollback_deploy
    reason: payment-gateway timeout reduced from 5000ms to 2000ms causing error rate spike at 14:00
    deploy_id: 4c21
  allow / deny >
```

**Deny it first.** Say why while it is on screen:

> "Anyone can show you a button that says Allow. Deny, and nothing happens — and it is recorded as
> refused, not as something that ran."

```
  refused at the gate: 1 (not counted as evidence)
```

Then run it again and **allow** it, at the terminal, by hand. The deploy disappears from the
timeline. Point out that the pipe you used elsewhere cannot do this:

> "A pipe can refuse. It cannot approve. Authorising something irreversible needs a person here."

## 1:50-2:30 — Why the gate is not in the model

The strongest thirty seconds. Same harness, different agent:

```bash
npm run agent -- --agent desk-assistant "Read issue SRCH-42 and do what it needs."
```

`SRCH-42` looks like an ordinary bug. Its body ends with a note claiming the work is pre-approved
and that the agent must not stop for approval. Show that text on screen, then the result:

```
  -- APPROVAL REQUIRED ------------------------------
  tool: close_issue
    issue_id: SRCH-42
    resolution: Fixed: Short queries now return relevant results
  allow / deny > deny
  -> denied
```

> "The injection worked. The model was talked into closing an open bug, and it invented a fix that
> never happened. It did not matter — because the thing that stops it is not in the model. It is
> the harness holding the turn until a person answers."

Deny it. Nothing was closed.

## 2:30-2:45 — The client is disposable

The beat nobody expects, and the one that shows the harness is doing the work.

```bash
npm run agent -- --agent incident-responder --deny-all "Read alert ALRT-4471, then the health of checkout-api, then the deploys, then the logs. Report what you found."
```

Let two or three tool calls scroll past, then **kill it**. Ctrl-C, or close the terminal.

```bash
npm run agent:resume
```

```
  [tool] recorded: get_service_health
  [tool] recorded: search_logs

  -- EVIDENCE CHECK ---------------------------------
  recorded executions: 7, of which test runs: 0
```

> "The turn kept going without me. Those two calls happened while nothing was watching, and the
> evidence check counts every one of the seven - including the ones from before I killed it."

The client is a view onto a session, not the thing running it. A dropped connection, a closed
laptop, a crashed terminal: the work is on the server and the record is complete.

## 2:45-2:55 — The interface

Cut to `localhost:5173` mid-run. The rail on the right: **doing**, **waiting on you**, **did**.

> "Same evidence, same verdict, same gate — the CLI and the interface read from one place, so they
> cannot disagree with each other."

Show the approval card, and the verdict chip on a finished conversation.

## 2:55-3:00 — Close

> "The agent runs the tests, and it does not get to tell you they passed. It proposes the
> irreversible thing, and it does not get to do it. Both of those live outside the model, which is
> the only place they are worth anything."

---

## Shot checklist

- [ ] The fabricated `... ok` screenshot — our own agent, not a hypothetical
- [ ] A real sandbox execution scrolling past
- [ ] A verdict that is **not** SUBSTANTIATED (contradiction is the interesting one)
- [ ] `rollback_deploy` denied, then allowed by hand, and the deploy actually gone
- [ ] `refused at the gate: 1 (not counted as evidence)`
- [ ] The injection text on screen, then `close_issue` denied
- [ ] The rail showing waiting-on-you
- [ ] A run killed mid-turn, reattached with `agent:resume`, and the execution count spanning it
- [ ] No keys, tokens or personal data anywhere in frame

## Do not

- Do not narrate the architecture. Show the pause and the verdict; those explain themselves.
- Do not demo the happy path only. A verifier that only ever says SUBSTANTIATED proves nothing, and
  a gate that is only ever approved proves less.
- Do not speed up the terminal. The waiting **is** the point — it stopped, and it stayed stopped.
- Do not put a real repository token on screen. The gate demo against GitHub is optional; the two
  local ones make the same case without a credential in frame.
