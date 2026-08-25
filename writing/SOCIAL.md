# Build-in-public posts

The Radio Traffic track is judged on the thread, not one launch post. One a day beats five on the
last day. Tag **@WeMakeDevs @truefoundry @QodoAI** on every one.

Rule for all of them: post the *finding*, not the progress. "Day 3, still building" is invisible.
"Here is a hole in the default approval policy" gets read.

---

**1 — the hook (post first, it is the strongest thing we have)**

> I told my agent, in writing, never to report a test result it hadn't actually run.
>
> Day two it handed me this:
>
> `test_split_evenly ... ok`
>
> It never ran anything. No sandbox, no tool call. It just wrote the line.
>
> It reported stdout, stderr and an exit code. The harness recorded zero executions.
>
> So the check moved somewhere the model cannot reach: the event stream.
>
> Building this on @truefoundry TrueForge this week. Reviewed with @QodoAI.
>
> @WeMakeDevs #AgentHarnessHackathon
>
> github.com/manumishra12/quartermaster

*Attach: `writing/assets/post-01-fabrication.png` - the real answer, the real recorded count, and
the real verdict. Nothing in it is mocked up.*

---

**2 — the fail-open gate**

> TrueForge gates risky tools with `["@write", "@destructive"]`.
>
> Those resolve from annotations the MCP server publishes. A tool that publishes none matches
> neither.
>
> So an unannotated write tool runs with no approval gate — while your config still reads as
> though it's protected.
>
> Wrote a script that fails the build if any reachable tool would run ungated.

*Attach: the audit output.*

---

**3 — the unattended path**

> Small decision, took a while to see:
>
> when my agent's approval prompt has no terminal attached — CI, a pipe, cron — it denies.
>
> A gate that quietly allows when nobody is watching isn't a gate. It's a formality that happens to
> be present when observed.

---

**4 — enforcement, not instructions**

> You can't prompt your way to honesty.
>
> So the claim is now checked against the harness event stream, which the model can't write to:
>
> SUBSTANTIATED — claimed a pass, a real run passed
> UNSUBSTANTIATED — claimed a pass, nothing ever ran
> CONTRADICTED — claimed a pass, the run disagrees
>
> Exits non-zero. Works in CI.

*Attach: the EVIDENCE CHECK terminal block.*

---

**5 — the kill -9**

> Killed the client mid-run with `kill -9`.
>
> The agent kept working server-side. Reattached with the stored session id + sequence number and
> picked up a sandbox execution that finished while nothing was connected.
>
> The session lives on the server. The terminal is just a viewport.

*Attach: a clip of the kill and the resume.*

---

**6 — the demo**

> It doesn't tell you it fixed the test. It shows you the test output, then asks before it pushes.
>
> Deny, and nothing happens.
>
> [60-second clip]

*Post on submission day, with the repo link.*

---

**7 — the write-up**

> Wrote up the whole thing: the agent that lied, the gate with a hole in it, and why the unattended
> path has to be the safe one.
>
> [blog link]
