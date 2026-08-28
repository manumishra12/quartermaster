# Controls

Five runtime controls, in `scripts/lib/`. Each one exists because of a specific way a run can go
wrong quietly, and each says out loud what it does not cover, because a control that overstates its
reach is worse than an absent one: somebody stops looking for the failure it never caught.

## What is enforced here, and what is not

These are libraries with tests. Nothing in `scripts/run.mjs` calls them yet, so today they enforce
nothing on a live run - they are the mechanism, not the wiring, and the wiring is a separate change.
Read every "stops" below as "stops, once the runner asks it".

Three of the five also have a ceiling that this side of the connection cannot raise. The section at
the end says which.

## `idempotency.mjs` - has this already been done?

**The failure.** An agent calls a destructive tool, the call goes out, the failure comes back, and
nothing on this side can tell whether the action landed. `retry.mjs` resolves that by refusing to
retry anything after an approval. That is correct and it is also a cost: a rate limit that clears in
thirty seconds now ends the run.

**What it stops.** A repeat. A key built from the session, the tool name and the canonicalised
arguments identifies one call across attempts, and the record answers **executed**, **not executed**
or **unknown**. Three states, because "we have no record" is not "it did not happen" - a run killed
between dispatch and result leaves exactly that gap. Only a positive `not executed` makes a repeat
safe; `unknown` escalates.

**Default.** Records go to `evidence/idempotency.jsonl`, append-only JSON lines, one line per state
change. Keys are scoped to the session, so the same rollback during next week's incident is a
different call and is not refused as a repeat.

**How to change it.** Pass a path to `noteCall` and `load`. The session scope is part of `keyFor`;
omitting the session widens it to "ever", which is almost never what anybody wants.

**What it does not buy.** It does not make the underlying tool idempotent. If the remote
`rollback_deploy` rolls back twice when called twice, it still does. This only stops *this* runner
from being the thing that calls it twice.

## `expiry.mjs` - is this still the decision that was made?

**The failure.** A person approves a rollback because of what was true when they were asked. If a
new deploy lands, or the metric recovers on its own, or a fresh alert fires between the ask and the
execution, the thing they approved is not the thing that would now happen.

**What it stops.** An approval outliving its situation. `stamp()` binds an approval to the digest of
the evidence that justified it and to a deadline; `stillValid()` re-checks both and distinguishes
**expired** (the clock) from **stale** (the world). They read the same to a naive implementation and
mean opposite things to the person being re-asked: expired is the same question again, stale is a
different question wearing the same words. When both are true, the change is what gets reported.

**Default.** `DEFAULT_WINDOW_MS` is five minutes. Long enough to read a forty-line call display and
think about it, short enough that it cannot outlive a deploy pipeline, an alert evaluation window or
a pager escalation.

**How to change it.** `stamp({ windowMs })`. A window that is not a positive number falls back to the
default rather than to no deadline, because a typo is not consent to an approval that never expires.

**What it does not buy.** It voids an approval this process is still holding. It cannot recall one
the harness has already forwarded, and it does not decide whether a change was material - a changed
digest sends the question back to a person, which is the point.

## `limits.mjs` - is this still work?

**The failure, twice.** An agent that calls the same thing over and over has stopped learning from
its own results. An agent that runs past what anybody agreed to spend has not finished, and a run
reported as finished when it is not is the same class of lie as a test reported as passing when it
never ran.

**What it stops.** `detectLoop` finds an unbroken run of identical calls, compared on the digest of
the canonicalised arguments rather than the text - a model that reorders its own JSON between
attempts defeats string equality completely, and models do reorder. The rule is *consecutive*, so an
alternating poll (`check`, `act`, `check`, `act`) never trips it. `checkBudget` reports every ceiling
that was passed, not just the first.

**Defaults.** Loop threshold **3**: two in a row is a retry, and retrying once is normal. Budget:
**60** tool calls, **10** approvals, **15 minutes** of wall clock. The approval ceiling is the
smallest deliberately - it spends a person's attention, and by the tenth prompt an operator is
clearing prompts rather than reading calls. A gate in front of somebody who has stopped reading
launders the decision instead of making it, and every other control here depends on that not
happening.

**How to change it.** `detectLoop(calls, { threshold })` and `checkBudget(spent, budget)`. A ceiling
that is absent or unusable falls back to its default rather than to no limit. `Infinity` is how a
caller says "no ceiling" - out loud, in the call, where a reviewer can see it.

**What it does not buy.** Exceeding a ceiling returns **escalate**. Not proceed, and not a silent
stop. It is the caller's job to act on that, and a caller that ignores it has removed the control.
The residue, said plainly: a tight poll of an unchanging endpoint - three identical reads with
nothing in between - does trip the loop rule. That is defensible, because an agent that read the
same value three times and did nothing between the reads is stuck in exactly the way this is looking
for. A caller who genuinely wants a longer unbroken poll raises the threshold and says why.

## `escalation.mjs` - a third outcome

**The failure.** An agent with conflicting evidence, an exhausted budget or a detected loop has a
correct answer available that neither "worked" nor "failed" describes: "I do not know, and here is
what I have." Forcing it into "worked" lies about the work. Forcing it into "failed" throws away
everything that *was* established on the way.

**What it stops.** An unfinished run reporting itself as finished. An escalation carries a reason,
what was established, what was not, and what would settle it - the last being what makes it
actionable rather than a shrug.

**Default.** `runOutcome(escalation)` returns `{ unfinished: true }`, which is spread into the
existing `runExitCode` call. **The exit code is 1.** Not zero, because an escalated run can still be
holding a well-substantiated partial answer and must not exit 0 on the strength of it - `runExitCode`
already asks whether the run finished before it asks whether the answer was any good, which is the
right order. Not a new code either: nothing downstream branches on one, and a third code invites a
wrapper to treat "not 1" as a special kind of fine. If the distinction is ever needed, it belongs in
`report.json` as a field, not in the exit status.

**How to change it.** `escalate({ because, detail, established, notEstablished, next })`. It never
throws: an escalation with no reason is recorded as `unstated` and is still an escalation, because a
throw here would lose it, and a lost escalation is reported downstream as a run that finished.

**What it does not buy.** `buildReport` has no third outcome, so an escalation currently reaches the
written report only as a turn that did not finish, with a reason. Giving it a section of its own is
a change to `report.mjs`.

## `dry-run.mjs` - what would this actually do?

**The failure.** `rollback_deploy({deployment_id: "4c21"})` shows an operator everything and tells
them nothing. They are approving "roll back checkout from v2.4.1 to v2.4.0" whether or not anybody
put that sentence on the screen, so the sentence is the thing being consented to.

**What it stops.** An approval given on a call nobody read as a change. `plan()` returns the tool,
the target, the change stated from-and-to where that is knowable, and what would be checked
afterwards to know it worked. It reuses `describeCall` for the full unsummarised arguments
underneath, and `visible` to escape them, because every value in it is argument-controlled.

**Default.** Where the current value is not known, the sentence stays a destination and the plan
says so out loud. A guessed "from" would be a sentence that reads as verified and is fiction. Where
no check can honestly be named - nothing on this side establishes that an email arrived - it says
that too, because a made-up check is worse than none.

**How to change it.** `plan({ tool, args, before, checks })`. `before` supplies an observed current
value the module cannot go and look up; `checks` overrides the derivation when the caller knows
better.

**What it does not buy.** There is no execution path in the module, by construction: it imports only
`describe-call.mjs`, and a test reads the file and asserts nothing that can reach a filesystem, a
process or a network appears in it. That is the property, not an accident of the current
implementation - a dry run that can run is not a dry run. It also cannot *perform* the checks it
names. Naming one is a promise that somebody can go and do it, and that somebody is not this module.

## What would need the harness

Three things these controls cannot reach from here.

- **A genuinely idempotent tool.** Refusing a repeat on this side is not the same as a far side that
  is safe to call twice. That needs the key travelling with the request and being honoured by the
  connector, which is a change to each MCP server and to what the harness sends.
- **The agent's own iteration limit.** It lives in `agents/*.json` and is enforced by the harness.
  Nothing in `limits.mjs` can raise or lower it, and the two ceilings can disagree.
- **An approval already forwarded.** `expiry.mjs` can refuse to execute on a stale approval that this
  process still holds. Once the approval has gone to the harness, this side has nothing left to
  withhold.
