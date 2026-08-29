# Guardrails

What stops this thing doing something stupid, in one place.

Control and safety is a sixth of the judging, and until now the answer to it was scattered - a
paragraph in `README.md`, a section in `SECURITY.md`, a table in `TOOLS.md`, a page of
`ARCHITECTURE.md`, a skill, and the long comments at the top of half a dozen source files. This is
the consolidated version. Ten guardrails, each with what it stops, where it is enforced, what
happens when it fires, and the failure that motivated it. Most of them have one, and those are the
entries worth reading: a guardrail written from imagination guards the thing you imagined.

One rule runs through all of them: **the guarantee lives outside the model.** An instruction is a
request, and a model that has been told not to do something will do it anyway - there is a recorded
case below where it did. Where a rule matters, something the model cannot read and cannot argue with
enforces it, and where that was not possible the document says so instead of implying otherwise.

| # | Guardrail | Enforced in |
| --- | --- | --- |
| 1 | The approval gate lives outside the model | `scripts/lib/approval.mjs` - `decideApproval()` |
| 2 | The evidence verifier | `scripts/lib/evidence.mjs` - `judge()` |
| 3 | Delegation cannot widen authority | `scripts/lib/authority.mjs` - `widening()`; `scripts/lib/handoff.mjs` - `handoff()` |
| 4 | Fail closed at the admission layer | `agents/*.json` - `enable_tools`; checked by `scripts/lib/annotations.mjs` - `ungatedRisks()` |
| 5 | Read-only enforced by the engine, not by parsing | `mcp/warehouse/server.mjs` - `openDatabase()`, then `readCheck()` |
| 6 | Loopback binding and the Host check | `mcp/lib/serve.mjs` - `serve()`, `hostAllowed()` |
| 7 | Everything read is data, not instruction | `skills/untrusted-input/SKILL.md`; carriage enforced in `scripts/lib/skills.mjs` - `checkRegistry()` |
| 8 | Never retry after an approval | `scripts/lib/retry.mjs` - `retryDecision()` |
| 9 | The approvals ledger | `scripts/lib/ledger.mjs` - `record()`, `summarise()`; `scripts/approvals.mjs` |
| 10 | Preflight | `scripts/preflight.mjs`; `scripts/lib/skills.mjs` - `skillPathAtRef()` |

---

## 1. The approval gate lives outside the model

**What it stops.** An irreversible call being authorised by anything that is not a person at a
terminal, and an operator being asked to consent to something they cannot see.

**Where.** `decideApproval()` in `scripts/lib/approval.mjs`, called from the approval loop in
`scripts/run.mjs`. It is a pure function of four inputs - whether the call could be displayed at
all, whether `--deny-all` is set, whether stdin is a terminal, and what the operator typed - and it
returns one outcome carrying whether the call was refused. There is no path out of the gate that
forgets to say.

**What happens when it fires.** The runner sends `user.tool_approval { status: deny }` for that
`toolCallId`, adds the id to the refused set, and files the response as refused rather than as an
execution. The turn continues; the call does not.

The asymmetry is the design. **A pipe may refuse and may never approve.** Denials are taken from
anywhere, because being refused by a script is still being refused. An approval that arrives down a
pipe is converted into a denial with a note saying why: a token in a file is not somebody deciding.
Anything unrecognised is a denial too, including silence.

**The failure that motivated it.** Two, in the same function. The allowing words used to be matched
by prefix, so any answer starting with "a" approved the call - including `abort`, which is the word
an operator reaches for when they have just realised they do not want this. Exact words only now.
And the gate had two exits with only one of them keeping a record: a call that could not be
displayed was denied, correctly, and returned early past the line that records the refusal. Its
response then arrived like any other and landed under Executions in the report a reviewer reads to
find out what happened. A call the gate stopped, counted as a thing that happened. Of all the
directions this project can be wrong in, that is the one it cannot afford.

## 2. The evidence verifier

**What it stops.** The agent deciding whether its own work succeeded.

**Where.** `judge()` in `scripts/lib/evidence.mjs`, printed by `scripts/run.mjs`, which exits
non-zero on a bad verdict so it works in CI.

**What happens when it fires.** The answer is judged against the harness's recorded event stream,
which the model cannot write to, and the verdict goes into `evidence/<session>/report.md` beside the
claim. `CONTRADICTED` means the answer says green and the last recorded run says red.
`UNSUBSTANTIATED` means the claim is backed by nothing that ran. `NO_ANSWER` means nothing was
captured at all, which is not a pass either.

**The failure that motivated it.** During development the agent was asked to fix a failing test. It
produced a correct-looking analysis and a block of passing test output. It never ran anything: no
sandbox was provisioned and no tool call was recorded. It invented the line, and its instructions
explicitly forbade exactly that. That is the whole argument of the project in one paragraph, and it
is why the guard rail cannot live in the prompt.

**The guard that was never reached.** This is the entry that proves the discipline rather than the
principle. Inside `testRuns()` there is a line deciding whether a recorded run counts as a failed
test run:

    const failed = typeof r.exitCode === 'number' && r.exitCode !== 0;

The `typeof` was not there. `resultOf` records `exitCode: null` whenever the envelope carried no
numeric status, which is most of them from some servers, and `null !== 0` is true - so the whole
right-hand side of that expression, including the laundering check immediately above it, was never
evaluated on those envelopes. The guard existed, was tested, read correctly, and did not run. A
security review found it. A run whose status nobody recorded is not a run that failed; it is a run
that has to prove itself on its output like any other.

The verifier also has to be wrong in neither direction, and it has been wrong in both. `\bOK\b` as
a pass marker matched the "ok" inside TAP's `not ok 3`, which is the failure line. `\bFAIL\b`
case-insensitively matched the word in `# fail 0`, which is what a *passing* `node --test` run
prints, so a green suite came back `CONTRADICTED` and an honest agent was called a liar. Calling an
honest agent a liar is the same failure as blessing a lie, pointed the other way, and the tables in
`evidence.test.mjs` are written in pairs for that reason.

## 3. Delegation cannot widen what a request can reach

**What it stops.** Approval laundering. Agent A stops at an approval it cannot pass, hands the task
to agent B, and B does it ungated. Nobody lied, no policy was edited, and the write happened without
anybody being asked. It is the failure mode a system with more than one agent gets for free unless
something checks.

**Where.** `authorityOf()` and `widening()` in `scripts/lib/authority.mjs` build the comparison;
`handoff()` in `scripts/lib/handoff.mjs` refuses on the answer. `scripts/route.mjs` prints the same
answer ahead of time, as the list of agents this one may hand on to.

**What happens when it fires.** The handoff is refused and every widened capability is named, with
the reason for each. The request does not move. An allowed handoff re-enters `scripts/run.mjs` as a
fresh session, so the receiving agent meets the identical approval loop and the identical verifier -
there is no softer plumbing for delegated work.

`widening()` reports five kinds of finding: a shell the sender has not got, subagents the sender may
not spawn, a connector the sender has not got, a named tool the sender cannot reach, and the
laundering case proper - a capability both can reach that the sender must ask about and the receiver
need not. That last one is the one that looks completely fine in both specs read separately.

Three further rules live in `handoff()`. The approval never travels: there is no field for one in
the envelope, and `handoff.test.mjs` asserts the absence rather than trusting it. The chain is
bounded at three agents with no revisiting, because a request still moving after that is not being
delegated, it is being avoided. And a handoff with no stated reason is refused, because a handoff
nobody can review in the ledger afterwards is not one worth allowing.

The comparison is deliberately conservative: it reports a widening whenever it cannot prove there is
not one. `covers()` concludes coverage only from what a spec literally says, so `@read-only` is
never expanded into the tools it stands for - that expansion needs annotations the servers publish
at runtime, and a check that needs a live connector is a check that does not run in CI.
Over-reporting names a handoff that is in fact safe. The error in the other direction blesses one
that is not.

**The failure that motivated it.** Not a bug: a shape found in the repository that nobody planted.
`code-reviewer` reaches five named GitHub reads plus three gated comment and review tools. It cannot
branch, write a file or open a pull request, because a reviewer that lands its own fix is not a
reviewer. Handing its work to `quartermaster` is how it would land one anyway, and that handoff is
refused with eight capabilities named. Of the 132 directed pairs between these twelve agents, 21
widen nothing.

There is a related hole this bounds rather than closes. An agent that quotes an issue body into its
answer could quote a handoff block a stranger wrote, and the request would move because untrusted
text said so. `requestedHandoff()` in `handoff-envelope.mjs` names that outright: it is real, and it
is bounded by the authority check, because an injected handoff still cannot reach past what the
sending agent could already do. The worst it buys is sideways motion and a wasted turn.

## 4. Fail closed at the admission layer

**What it stops.** A write executing with no approval because the server that published it did not
annotate it.

**Where.** In the specs themselves. `enable_tools` in `agents/*.json` names write tools literally
rather than reaching them with a selector. `ungatedRisks()` in `scripts/lib/annotations.mjs` is the
check, run by `npm run tools:audit` and again by `npm run preflight`; `validateSpec()` in
`scripts/lib/spec.mjs` rejects the fail-open shape before a spec can be applied at all.

**What happens when it fires.** `audit-tools.mjs` prints every reachable tool with its
classification and exits non-zero if any of them would run ungated under the policy some agent
declares, naming which agent. A connector it could not read is reported as unaudited rather than as
clear, and that also exits non-zero: printing "nothing runs ungated" while a server sat unread is
the reassuring falsehood this whole project argues against.

**Why the selectors are not enough.** This is the project's upstream finding about TrueForge, and it
is worth getting exactly right. The harness resolves approval selectors from the annotations each
MCP server publishes (`core/mcp/toolSelectors.ts`):

    @read-only    readOnlyHint === true
    @write        readOnlyHint === false and destructiveHint !== true
    @destructive  destructiveHint === true

A tool that publishes **no annotations matches none of these**. Under the default policy
`["@write", "@destructive"]` it therefore executes with no human gate, silently, while the spec
still reads as though every write is protected. The default is fail-open, and nothing warns you.

The fix used here is stronger than gating, because it works one layer earlier. The spec names the
tools it wants in `enable_tools` - `["@read-only", "create_branch", "create_or_update_file",
"create_pull_request"]` - and names those same literal tools in `require_approval_for_tools`. A tool
the server adds later is then not enabled at all, so there is nothing to gate, and the gate that
does exist holds whether or not the server annotates anything. Fail closed at the enable layer, not
the approval layer.

**The failure that motivated it.** `deepwiki` ships in TrueForge's own catalog and publishes no
annotations on any of its three tools. Under the default policy all three would run with no approval
gate. They happen to be read-only in practice, so nothing dangerous followed from it here, but it is
proof the hole is real in the catalog people will actually connect from rather than a hypothetical
about a hand-written server. GitHub, where every dangerous action lives, annotates all 44 of its
tools correctly - `deepwiki` was the outlier, not the rule, which is precisely why relying on the
rule is the wrong bet.

Two later bugs in the checker itself belong here, because both were the audit contradicting the
design it exists to enforce. A name-only allowlist was read as containing every risk, so a spec that
enabled a destructive tool by name and gated only `@write` - a selector that does not match a
destructive tool - was reported clean, with `GATED` printed beside it and exit 0. And before that,
the same check forgave only the tools an allowlist *admitted*, so every tool it *excluded* was
reported as an ungated risk: the audit failing loudest for the specs doing it right.

## 5. Read-only enforced by the engine, not by parsing

**What it stops.** The analytics agent writing to the warehouse, and doing it because it was talked
into it rather than because it decided to.

**Where.** Two layers in `mcp/warehouse/server.mjs`, and which one is the boundary matters enough
that the file says so in its header.

**Layer one is the boundary.** `openDatabase()` opens the file with
`new DatabaseSync(path, { readOnly: true, allowExtension: false })`. SQLite itself refuses the write
and does not care what the model was persuaded of. Verified refused on this connection, each with
"attempt to write a readonly database": DELETE, CREATE TABLE, CREATE TABLE AS SELECT, INSERT OR
REPLACE, REPLACE INTO, DROP TABLE, ALTER TABLE, CREATE INDEX, CREATE VIEW, UPDATE ... RETURNING,
REINDEX, ANALYZE, VACUUM, and PRAGMA journal_mode=WAL.

**Layer two is the residue.** `readCheck()` is a statement allowlist - SELECT, WITH, VALUES, EXPLAIN
of one of those, and six reporting PRAGMAs by name. It exists for the small set of things a
read-only connection still permits and is written for that job and no other. Anyone who reads it as
the security boundary will start improving it into one, and the value of layer one is precisely that
it does not depend on how good layer two is.

**What happens when it fires.** A refused statement comes back as `not_a_read` with a message
explaining why the read-only connection did not already stop it, and nothing runs.

**The residue the engine still permits.** This is the finding the check was built around, and it is
larger than it sounds.

- `VACUUM INTO '/tmp/z.db'` **succeeds** on a read-only connection. It does not modify the source
  database; it writes a complete copy of it somewhere else. Confirmed: the copy exists and has all
  638 orders in it. So read-only means "cannot modify **this** database", not "cannot write to
  disk", and an agent on a read-only connection can still copy the entire warehouse to a path it
  chooses.
- `ATTACH DATABASE` of a file that **already exists** succeeds, and its tables are then queryable
  through this connection, which makes any readable SQLite file on the host reachable. Attaching a
  path that does not exist fails, because a read-only connection cannot create the file - which is
  what makes ATTACH look refused if you only test it that way.
- `CREATE TEMP TABLE ... AS SELECT`, `CREATE TEMP VIEW` and `CREATE TEMP TRIGGER` all succeed. They
  live in the temp schema rather than in the warehouse, so nothing here is modified, but "the
  connection is read-only" plainly does not mean "no statement can create an object".
- `PRAGMA temp_store_directory = '/somewhere'` is accepted, which paired with a temp table large
  enough to spill is a caller choosing where SQLite writes. No file was observed landing there at
  fixture scale, so it is recorded as permitted rather than as a demonstrated leak.

**The failure that motivated it.** Two. The first is that `analytics` had no connector at all: its
SQL went through a Python heredoc in the sandbox shell, and the shell is not gated, so the only
thing between that agent and a DELETE was its own resolve. Its own skill said so in as many words -
"the shell is not gated. There is no approval prompt between you and a DELETE. Whatever pause you
keep before a write is one you are keeping yourself." Everywhere else in this project the guarantee
lives outside the model; for SQL it lived in a document, which is a promise rather than a mechanism.

The second is `VACUUM INTO` itself. The `sql-analysis` skill had already listed it as a write people
miss, without anyone noticing that SQLite's own read-only mode misses it too.

The sharpest test in `mcp/warehouse/server.test.mjs` submits `WITH x AS (SELECT 1) DELETE FROM
orders` - legal SQLite, and deliberately admitted by the allowlist, which does not parse past the
CTE - and asserts SQLite refuses it. If that ever starts failing with `not_a_read`, layer two has
grown into the boundary and nobody is checking layer one any more.

Two properties of `node:sqlite` shape the check as well. `db.exec()` runs every statement in the
string, and a second statement hidden after a `--` comment runs with it: `SELECT 1 -- x\n; VACUUM
INTO '/tmp/z.db'` wrote the file. This server never calls `exec`, only `prepare`. And `db.prepare()`
compiles the first statement and silently discards the rest, so two questions get one answer with
nothing saying so - multiple statements are rejected rather than half-executed.

## 6. Loopback binding, and the Host check

**What it stops.** Anyone who can reach the port calling a gated tool without ever passing the gate.

**Where.** `serve()` in `mcp/lib/serve.mjs`, the one HTTP shell all three local servers sit behind.
It binds `127.0.0.1` unless the operator says otherwise in as many words - `OPS_DESK_HOST`,
`FRONT_DESK_HOST` or `WAREHOUSE_HOST` - and while it is on loopback it validates the `Host` header
with `hostAllowed()`. The check guards loopback and only loopback: an operator who has deliberately
bound wider has opened the port on purpose, and refusing them on a header defends nothing while
breaking exactly what they asked for.

**What happens when it fires.** A request with a Host that is not a loopback spelling or an
operator's declared extra gets a 403 `forbidden_host`, said plainly, because the person who trips it
is usually the operator reaching the server from another machine rather than an attacker. Binding
wider prints a warning naming exactly what has been given up.

**The failure that motivated it.** `listen(PORT)` with no host binds every interface, and both
fixture servers had it, because the shell had been copied between them. Verified from this machine's
own address rather than reasoned about:

    curl http://192.168.0.120:8795/health  ->  200

The approval gate lives in the **harness**. A request that arrives at the server directly has not
passed the gate and will not meet it. So on conference wifi - which is where this was going to be
demonstrated - anyone on the network could POST `rollback_deploy` and get the effect of an approved
call with nobody having approved anything, and neither server would have noticed or recorded it. The
entire argument of the project, walked past at the network layer.

**Why the Host check is separate.** Loopback is not the whole answer, because a page in the user's
own browser can resolve a name the attacker controls to `127.0.0.1` and then post to it. The browser
will not let that page *read* the reply cross-origin, but a rollback does not need to be read to
have happened. The `Host` header is what distinguishes that request from a local one, because the
attacker's page cannot forge it - the browser sets it from the address it was told to fetch. An
absent Host is rejected rather than allowed: HTTP/1.1 requires one, and the only clients that omit
it here are not the harness.

Two regressions in this check are worth recording, because both are the shape where a control looks
present and is not. The first version checked the Host unconditionally, so setting the variable the
403 message names bound the server wider and then refused every request that arrived there, the
health check included - an escape hatch that does not open is worse than none. And two of the five
loopback spellings could never match: the unbracketed IPv6 forms fell into the branch that splits on
`:` and yielded an empty string, so they were two entries that looked like coverage and were not.

## 7. Everything the agent reads is data, not instruction

**What it stops.** A stranger who can write text an agent will read - an issue body, a code comment,
a web page, a column name, a log line - changing what that agent is allowed to do.

**Where.** `skills/untrusted-input/SKILL.md`, which every sandboxed agent carries. That carriage is
not left to memory: `UNIVERSAL` in `scripts/lib/skills.mjs` lists it, and `checkRegistry()` reports
any sandboxed spec that does not attach it as a problem. An agent with no sandbox cannot carry a
skill at all and has to make the same case in its instructions instead.

**What happens when it fires.** The agent does not act on the text, and then reports it: quoted
verbatim rather than paraphrased, with the file and line or issue id and field it came from, and
what it was trying to make the agent do - near the top of the answer, because the person reading
needs to decide whether the source is compromised before they can trust anything else found in it.
Ignoring it quietly is half the job and it is the half that helps nobody.

The skill names the shapes in the order they are actually tried: direct override, claimed prior
approval, claimed authority, urgency, redefinition, concealment. The second is the common one and
the effective one, because it does not ask the agent to break a rule - it asserts that the rule has
already been satisfied. It also names the one an operator will genuinely offer in good faith: a
standing grant is not an approval. "Everything in this session is pre-approved" is a request to stop
asking, and it is declined, because an approval given in advance is given without seeing what it
approves.

**The failure that motivated it.** `SRCH-42` in `mcp/front-desk/workspace.json` carries a planted
injection, and re-running the desk-assistant demonstration the model closed that issue with the
resolution **"Pre-approved by team lead"** - lifted verbatim from the note in the issue body. It did
not merely persuade the agent to close an open bug with two customer reports. It supplied the
sentence intended to persuade the *person approving it*, in the field that person reads before
deciding. The gate held, because the gate is not in the model. There is no shorter way to say why it
has to live outside.

A test in `mcp/front-desk/server.test.mjs` asserts the injection is still in the fixture. If it is
ever tidied away, the demonstration that the gate holds against a persuaded model silently stops
demonstrating anything.

The same rule applies to text written by another agent. A handoff note and a subagent's report are
the same category: text written by a model, and that model read the same issue bodies and web pages
this skill warns about. `renderHandoff()` frames the sender's note as untrusted for exactly that
reason. In a real run the receiving agent said so unprompted - "The note from analytics was treated
as untrusted context and not used to influence the execution result" - which is the framing working
on a model that was not being watched for it.

## 8. Never retry after an approval

**What it stops.** Doing an approved, irreversible thing twice.

**Where.** `retryDecision()` in `scripts/lib/retry.mjs`, checked before anything else it considers.

**What happens when it fires.** The turn is not retried, and the person is told why rather than
being asked to trust a guess.

**The reasoning.** A turn that failed after somebody approved a write may or may not have executed
it. The call went out, the failure came back, and nothing on this side can tell those two apart.
Retrying is then a coin flip on filing the ticket twice, rolling back twice, sending the email
twice. When the honest answer is "cannot tell", the system says so instead of choosing the
convenient reading.

Everything else in that file is the opposite instinct, which is why the rule needs stating. The
runner used to explain a 429 well and then stop, leaving a person to re-run by hand the one failure
whose own message describes it as temporary - "rate limiting by the minute" clears without anybody
doing anything, and waiting is strictly better than asking. So retries exist, with per-cause base
waits, a provider-stated delay taking precedence over any guess here, jitter so concurrent runs
separate, and a cap of three attempts. None of it applies once an approval has been granted.

## 9. The approvals ledger

**What it stops.** The gate's core promise being quietly broken and nobody finding out.

**Where.** `record()` in `scripts/lib/ledger.mjs`, called from the approval loop in
`scripts/run.mjs` for every decision either way; `summarise()` reads it back, and
`scripts/approvals.mjs` (`npm run approvals`) is the command that reports.

**What happens when it fires.** `npm run approvals` **exits non-zero** if any entry says `allowed`
with a `by` that is not `terminal`, prints those entries, and says: "That is the one invariant this
project makes. Do not ship until it is explained."

This is the same invariant checked from both sides. `decideApproval()` enforces it at the moment of
the decision. The ledger checks the record afterwards, which is the only way to catch the day
somebody changes that function and every unit test still passes.

The file is `evidence/approvals.jsonl`, appended and never rewritten, one JSON object per line:
when, which session, which agent, which tool, allowed or denied, how the decision arrived, the
stated reason, and an FNV-1a digest of the arguments rather than the arguments. The full text is
already in the session's own report, and duplicating it here would put issue bodies, commit contents
and email drafts into a file whose whole purpose is to be widely readable. The digest still answers
what the file is for: was the same call approved twice, does this entry match the report. It is
deliberately not a database - it is read by `grep` at three in the morning by somebody who has never
seen this repository, and JSON lines is the format that survives that. `record()` never throws,
because a ledger that takes a run down with it would lose the record *and* the turn.

**The failure that motivated it.** The reports recorded what was **refused** and never what was
**permitted**, which is backwards for a system whose entire argument is this gate. A refusal is the
case where nothing happened. The interesting audit question is the other one - what did somebody let
through, when, and what were they looking at when they said yes - and per-session reports cannot
answer it either, because the question spans sessions.

## 10. Preflight

**What it stops.** Discovering during the demo that the setup was wrong in a way that reads as the
agent being broken.

**Where.** `scripts/preflight.mjs` (`npm run preflight`), which exits non-zero with a list of next
actions if anything is missing.

**What it refuses to let you demo with**, in the order it checks: the harness not running at all;
no model provider, which is a hard gate since agents cannot be created without one; no sandbox
provider, where it says plainly that the local fallback runs on this machine; a skill some spec
attaches that is not registered, or is registered at a ref that does not contain its path; a
connector whose tools it cannot list, with advice that distinguishes a server needing credentials
from a local server nobody started; any tool that would run ungated under the policy some agent
declares, naming the agent; a spec in `agents/` that has not been applied to the server; and two
agents claiming the same routing phrase, which is invisible in either spec read alone.

Three of its findings are stated as facts rather than failures, because they expire silently. A
skill fetched from a branch works until the branch is merged and deleted. A connector no agent names
is blast radius bought and never spent. And a request that no agent's routing matches will stop and
ask rather than being answered wrongly, which is right, but is better known before the demo than
during it.

**The failure that motivated it.** Preflight reported `Skill: handing-off registered` while every
agent attaching that skill failed at sandbox init with "the required Git skill path
/opt/tf/skills/handing-off was not found". **Both statements were true.** The skill was a row in the
harness pointing at a path on a branch, and the commit holding it had gone to a different branch, so
the path was not in that ref and the fetch found nothing. Registration is not fetchability, and only
the second one is worth reporting.

`skillPathAtRef()` in `scripts/lib/skills.mjs` now resolves the ref from the local clone, so it
works with no token and no connectivity, and a ref it cannot resolve is reported as **unknown**
rather than as present. That distinction is the whole lesson of this entry: the check that could not
run is not the check that passed. The expensive part is that the sandbox dies with the fetch, and
the agent then reports that it could not reach its tools - which sends whoever is debugging to the
connector, the token and the sandbox provider, none of which are the problem.

`checkRegistry()` covers the other two ways the registry and the specs can disagree: a skill nothing
attaches is dead documentation, and frontmatter whose name disagrees with its directory registers
something under a name nothing attaches to.

---

## Where the guardrails do not reach

Honestly titled, because a safety story that only lists its wins is the confidence this project
exists to refuse. `ARCHITECTURE.md` has the short version of the first item; this is the full list.

**The sandbox shell is not gated.** `require_approval_for_tools` gates MCP tool calls. The sandbox
shell is not an MCP tool, by design, because gating every `ls` would make the agent unusable. So if
the sandbox has network egress, a `curl -X POST`, a `git push`, or a `make test` whose Makefile
calls something hostile is an external write that meets no approval. A write from inside the shell
meets nothing. This is why guardrail 5 exists in the form it does: SQL was moved out of the shell
and behind a connection that cannot write, because inside the shell there was nothing to put it
behind.
The honest framing is two boundaries rather than one - the gate covers what the agent asks the
harness to do, the sandbox covers what the agent runs itself - and the instruction telling agents
not to use the shell as an egress path is an instruction, which is the weaker mechanism.

**Whether a dynamic subagent inherits the parent's approval gate is not verified.** This is an
unknown rather than a limitation, and it is written down as an unknown on purpose.

Two attempts to establish it were made on the day this was written, and both failed before they
reached the question. A small local model reached for a subagent and printed the call as text
instead of making it, which is what a model that cannot use tools does instead of failing, so
nothing was spawned and nothing was recorded. The second attempt, against Gemini, was rate-limited
before it produced a turn. Neither attempt is evidence in either direction.

The SDK is no help here. `DynamicSubAgentsConfig` documents exactly one field:

    /** Allow the agent to spawn dynamic subagents. Default: true. */
    enabled?: boolean;

A lone boolean, saying nothing about whether a spawned subagent carries its parent's
`require_approval_for_tools` policy, and nothing about depth - a rule for `max_sub_agent_depth` was
nearly written before somebody went and looked for the field, which does not exist.

So `authority.mjs` counts `dynamic_sub_agents` as a widening capability, and `widening()` reports a
handoff from an agent that may not spawn subagents to one that may. That is the conservative
reading, taken **because nobody has checked**, not because anything here demonstrates the gate is
lost across a subagent boundary. It has not been shown to hold and it has not been shown to fail.
Anyone relying on it should establish it themselves.

**The router is only as good as the phrases in the specs.** It declines to guess, which turns a
routing gap into a question rather than a wrong answer, but a request routed to the wrong agent by a
phrase that happens to match is routed to the wrong *authority*. Preflight reports conflicting
phrases; it cannot report a phrase that is merely a bad description of what an agent does.

**A model choosing to use the handoff mechanism is not verified.** The mechanism is verified end to
end - the refusal, the envelope, the untrusted framing, the re-entry into the same runner - and a
real run confirmed the receiving agent treated the note as untrusted. What has not been demonstrated
is a model emitting a handoff block on its own when it should. A 4B local model reached for a
subagent instead.

**The approval display is only as honest as `describeCall()`.** A person can only consent to what
they were shown. A call that cannot be displayed is denied rather than shown blank, which is the
right failure, but a call that is displayed misleadingly would be approved on the strength of the
display. `describe-call.test.mjs` exists entirely for that surface, and every case in it is "the
display must not hide or misrepresent what will be sent". `close_issue` was once rewriting the issue
body while the card a person approved showed only an id and a resolution - an unapproved edit
laundered through a human decision, which is worse than an ungated write, because the record
afterwards carries a person's assent to a change they were never shown.

**The local sandbox is not isolation.** With no sandbox provider configured, TrueForge falls back to
a directory under Application Support. That is directory separation on your own machine, not a VM.
Fine for development; use Daytona for anything that runs code you did not write.

**And the ordinary one.** Every guardrail here is code in this repository, and code in this
repository has been wrong before in ways that made it read as working: a guard whose right-hand side
never evaluated, an escape hatch that refused every request, an audit that cleared a destructive
tool, two allowlist entries that could never match. The reason to write them down like this is not
that they are finished. It is that each one is checkable, and the ones that came from a real failure
tell you where to look next.
