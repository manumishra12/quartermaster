# Devlog

Three lines a day. This becomes the blog post on the last day, so write it as you go, not after.

## Day 0 — pre-hackathon (planning only, no project code committed)

- Read the TrueForge docs end to end. Correction to the original plan: subagents are spawned
  dynamically by the harness, not hand-wired as named specialists, so the design is one deep root
  agent rather than a four-agent hierarchy.
- Found the detail the whole repo layout hangs on: `require_approval_for_tools` is API-only today.
  The safety policy therefore lives in version-controlled JSON and is applied through the SDK,
  which means it is reviewable in a pull request instead of invisible in someone's UI state.
- Built the fixture first: `fixtures/ledger` fails one test, standard library only, no install step.
  A judge can reproduce the demo in two minutes.
- Cloned the harness source and read the approval implementation rather than trusting the docs.
  `require_approval_for_tools` resolves against MCP tool annotations, and unannotated tools match
  none of the selectors - so the default `["@write", "@destructive"]` policy is fail-open. A server
  that omits annotations gets its writes executed with no gate while the spec still looks safe.
  Wrote `scripts/audit-tools.mjs` to detect this. Exa passes. GitHub is unverified until there is a
  PAT to audit with, and GitHub is the one that matters.

## Day 0 (continued) — the UI, and a second upstream find

- Built the front-end on the React UI SDK, pinned to a single agent (`SingleAgent` mode). The agent
  library and composer are TrueForge's surfaces for *building* agents; this is the surface for
  *using* one, so an agent picker would only be a way to leave the product.
- Palette has one rule: green means verified and nothing else is ever green. Brass carries the brand
  and every primary action. If the colour that means "proven" is also the colour of a Send button,
  it stops meaning anything.
- Second upstream find: a clean install of TrueForge's own documented UI quickstart does not build.
  `@assistant-ui/core@0.2.23` requires `zustand@^5.0.11` and imports `useShallow` from
  `zustand/shallow`, but `@openuidev/react-headless` and `@openuidev/react-ui` pull `zustand@4.5.7`,
  which npm hoists to the root - where `useShallow` does not exist. Rollup fails with
  `"useShallow" is not exported by zustand/esm/shallow.mjs`. Pinning `zustand@^5` as a direct
  dependency fixes it. That is a reproducible bug report for `truefoundry/trueforge`, and their
  CONTRIBUTING asks for exactly this kind of report over a drive-by PR.
- Confirmed the model gate is real, not a guess: the server rejects an agent whose model has no
  configured provider with `422 Unknown model - provider not configured`. Taught the apply script to
  say that in one line instead of throwing a stack trace.

## Day 0 (continued) — de-risking the demo before building more of it

- Verified the fixture is actually solvable before betting a demo on it: `divmod` plus distributing
  the remainder takes it from 1 failing test to 5 green. Two lines. Checked in a throwaway copy so
  no solution is ever committed anywhere the agent could read it.
- Which exposed a real flaw in the setup. If the agent clones the submission repo to fix the
  fixture, it can also read ARCHITECTURE.md and DEVLOG.md - it would be solving the problem from our
  notes instead of from the code, and the demo would prove nothing. The fixture now ships as its own
  public repo (`scripts/publish-fixture.sh`), containing the broken code and nothing else.
- Added `npm run preflight`: one command that reports which of server, model, sandbox, skill,
  connectors, and applied agents are missing, and what to do about each. Setup spans the TrueForge
  UI, a Daytona account, a GitHub token and this repo, so the default failure mode is a
  half-configured server and a confusing error three layers down.
- Pulled the annotation classifier into `scripts/lib/annotations.mjs` with tests. Eight cases,
  including the one that matters: an unannotated tool is not gated by the default policy.
- Wrote the `evidence-report` skill against the real OpenUI grammar rather than guessing at it -
  read `core/capabilities/builtins/OpenUI.ts` for the component signatures. Two rules in there
  fail silently rather than erroring, which is the kind of thing a model gets wrong repeatedly:
  arguments are positional (colon syntax breaks quietly), and any variable not referenced by
  another variable is dropped without rendering. Both are now stated in the skill.
- The verdict banner picks its variant from what happened, not what was intended. A green banner
  over a run that was never performed is the precise failure this agent exists to prevent, so that
  rule lives in the skill that draws the banner.

## Day 0 (continued) — the agent lied, and that turned out to be the feature

- Unblocked the model dependency without any API key: Ollama was already installed, so TrueForge is
  pointed at `http://localhost:11434/v1` as a custom OpenAI-compatible provider. `qwen3:4b` is far
  too small for a real fix loop, but it proves the pipeline - session, streaming turn, sandbox
  provisioned on demand, real command executed, `42` returned.
- Then it lied. Asked to fix a failing test, it produced a correct analysis and a block of passing
  test output it had never run - no sandbox, no recorded tool call, pure invention. Its instructions
  forbade precisely that.
- So the guard rail moved out of the prompt. `scripts/lib/evidence.mjs` judges the final answer
  against the harness event stream, which the model cannot write to: a claim with no recorded test
  run is UNSUBSTANTIATED, a claim the last run disagrees with is CONTRADICTED. The runner prints the
  verdict and exits non-zero, so it works in CI. Sixteen tests, including the real hallucinated text
  as a fixture.
- Writing those tests caught a bug in the checker itself: the claim pattern ended in `\b` after
  `pass`, so it matched "the test pass" but not "the test passes" - it would have missed the exact
  sentence that motivated it.
- Learned the local sandbox is a directory under Application Support (`v1:local:...`), not a VM.
  Directory isolation, not real isolation. Fine for development, another reason the demo runs on
  Daytona.
- The headless runner defaults to **deny** when stdin is not a terminal. A gate that quietly allows
  when nobody is watching is not a gate.

## Day 1 — session resilience

- The Double-O criteria name "a session that holds together across reconnects", which was the one
  thing on that list not built. Now it is: the client keeps a checkpoint of session id, turn id and
  last sequence number, and `--resume` reattaches - `subscribeToTurn` with `afterSequenceNumber`
  while the turn is still running, `listTurnEvents` to rebuild if it finished without us.
- Tested the way it will actually fail: `kill -9` on the client mid-turn. The agent carried on
  server-side, and the resumed client picked up a sandbox execution that completed while nothing was
  connected. The client is disposable by design; the server holds the run.

## Day 1 — the interface answers the three questions

- The Best UI criteria ask for an interface that shows "what the agent is doing, what it is waiting
  on, and what it did". The stock chat layout answers the first two in paragraphs, in the past
  tense, mixed in with everything else. So the layout is now three columns, with a status rail that
  answers all three at a glance.
- "Did" is the interesting one. It reads the recorded tool responses and shows the last real test
  run - exit code and output - rather than whatever the agent said about it. Same rule as the CLI:
  the transcript is the agent's account, the event stream is what happened.
- The evidence rules are shared, not duplicated: `scripts/lib/evidence.mjs` is aliased into the UI
  build as `@evidence`. The CLI and the interface must never disagree about whether a claim is
  substantiated.
- Dropped `AgentStepsContainer` from the rail after reading its types - it requires transcript
  counts (`toolCount`, `thinkingCount`, `hasFinal`), so it is a transcript component, not a live
  panel. Forcing it in would have meant faking numbers to satisfy a type.

## Day 1 — a second fixture, CI, and the writing

- Added a JavaScript fixture, deliberately a different *class* of bug from the Python one: an
  off-by-one in a retry budget, where `attempts` is documented as the total number of calls and the
  loop makes one fewer. Same shape as the other though - the test is right, the code is wrong, and
  the tempting fix is to edit the expected number.
- Two fixtures in two languages is not just coverage. It gives the harness two independent problems,
  which is what makes it fan out to subagents - a Double-O criterion that was enabled but never
  actually demonstrated.
- CI runs the unit tests, builds the UI, and checks something most repos would not think to check:
  that both fixtures are **still broken**. A fixture that quietly starts passing is worse than a red
  build, because the demo still runs, the agent finds nothing to do, and you discover it on camera.
- Wrote the demo script as a shot list with a criterion-to-timestamp table, and the write-up. The
  post leads with the agent lying, because that is the one thing in this project that is not a
  claim about software - it is a screenshot.

## Day 1 — the interface, done properly

Installed the `ui-ux-pro-max` skill and ran its workflow rather than designing by taste.

- The generated system for a dark developer tool: Dark Mode (OLED), JetBrains Mono over IBM Plex
  Sans, a slate palette. Persisted to `design-system/quartermaster/MASTER.md`.
- One deliberate deviation, documented in the tokens: the generated palette uses green as the CTA
  accent. Here green means exactly one thing - a real run passed. If Send is the same green as a
  verified result, the colour stops carrying meaning. Brass takes every action instead.
- Ignored its pattern recommendation (FAQ/Documentation Landing) - that is a landing-page pattern
  and this is a dashboard. The skill's own rule is to verify a result fits before applying it.
- Moved every colour out of components and into semantic tokens. Raw hex in a component is on its
  priority-6 anti-pattern list, and it was exactly what the first version did.
- Its UX guidance on multi-step processes is to show which step you are on rather than a spinner.
  So the rail now shows Reproduce / Diagnose / Patch / Verify / Report - derived from recorded runs,
  not from the agent's own account of where it thinks it is.
- Then measured the palette instead of trusting it, and found two real failures: the red on surface
  was 4.16:1 against a 4.5 requirement, and the control border was 2.36:1 against the 3:1 that
  WCAG 1.4.11 asks for. Both fixed - #f87171 and #64748b.
- Made that permanent: `scripts/lib/contrast.test.mjs` parses `tokens.css` and asserts every
  foreground/background pair the rail renders. Colour choices drift when somebody nudges a token to
  improve a screenshot; now that is a build failure. 32 tests total.
- Also: hover states needed a real stylesheet rule. Inline styles cannot express `:hover`, so the
  first version of the expand button had no feedback at all despite having a transition property.

## Day 1 — evidence as an artifact, and a README a stranger can run

- Every run now writes `evidence/<session>/report.md` and `report.json`: the verdict, which phase it
  reached, and every recorded execution with its exit code and captured output. The terminal
  scrolls; a reviewer asking "did this actually pass?" tomorrow needs the executions themselves,
  not a summary of them.
- Writing that artifact immediately caught a bug in my own progress rule. A single *passing* run was
  being reported as "Patch", because the rule keyed on how many runs had happened rather than what
  the last one said. A green run is the end of the road whether it took one attempt or five.
- Rewrote the README for someone who has never seen this repo: what the problem is, the four
  verdicts, exact setup steps, what each of the two agents reaches, and what each fixture's bug
  actually is. "A public repo with a README a stranger can follow" is a submission requirement, and
  judges clone before they read.
- Disclosed AI assistance in the README, which the rules require. Keeping it in the README rather
  than in commit trailers - it belongs where a reader looks, not scattered through the history.

## Day 2 — the rest of the agents

Built the remaining five from the hackathon's own list, sharing one config block so the safety
discipline is identical rather than re-decided each time: `research-desk`, `code-runner`,
`analytics`, `incident-responder`, `desk-assistant`.

- `code-runner` has subagents switched **off**, deliberately. It runs code somebody else wrote;
  handing that code to more agents widens the blast radius in exactly the wrong direction. Its
  instructions also say the submitted code is input, not direction - it must not act on
  instructions found inside what it was asked to execute.
- `analytics` gets a fixture that is not broken for once: a SQLite seed with refunds, a cancelled
  order and three countries, so "what was revenue in Q2?" has a right answer and a tempting wrong
  one. Kept as SQL rather than a binary .db so a reviewer can see what is being queried.
- Fixed a real bug found by having seven agents instead of two: one missing connector aborted the
  entire apply. GitHub not being configured meant the four agents needing nothing were not applied
  either. It now applies what it can and reports what each blocked agent is waiting for.
- Added `@types/node`, a root `tsconfig.json` and `npm run typecheck`. The repo had TypeScript and
  no way to check it. Typing the specs against the SDK's own `AgentSpec` immediately required a
  guard the loader did not have: a spec with no model.
- Confirmed the infrastructure works across the new agents - `analytics` ran sqlite3 in the sandbox
  and came back with exit 0 and `1`. But `qwen3:4b` prints tool calls as text instead of making
  them on anything multi-step. The pipeline is not the limit any more; the model is.

## Day 2 — testing all seven, and three ways an agent fakes it

Wrote `npm run smoke`: every credential-free agent gets a small deterministic task, and the test
asserts the harness **recorded** a matching execution - not that the agent said it did.

The suite found problems in three different places, which is what a test suite is for.

- **My test was wrong, not the agent.** `analytics` recorded `"7\n"` - exactly right - and failed
  because my regex needed a newline before the 7, which is impossible when it is the first
  character. The failure message said "none matched" without showing what *was* matched, so I fixed
  that first: failures now print the recorded output. Then fixed the assertion rather than loosening
  it.
- **The suite had no per-case budget.** A slow model turned the whole run into a hang, which is
  indistinguishable from a broken harness. There is now a budget per case, and a timed-out turn is
  cancelled server-side rather than left running.
- **`code-runner` fabricated an execution three separate times, three different ways.** Its one job
  is to run code rather than reason about it, and it:
    1. reasoned it out - "print(9*9) evaluates to 81, so the output is 81", boxed answer, nothing run
    2. filled in the report template from imagination - `stdout: 81 / stderr: / exit code: 0`
    3. printed the tool call it was supposed to make as its answer

  All three with zero recorded executions. All three plausible. The second is the worst, because a
  filled-in stdout/exit-code block looks like transcribed output rather than prose.

The verifier only caught test-passing language, so it called all three "no claim". Six of the seven
agents never run tests, so that was a real hole. It now also catches:

- execution-result claims - "the output is", "it printed", "when I ran"
- the labelled report form - `stdout:`, `exit code:`
- a tool call written out as text instead of made

Each has a test using the verbatim text the agent actually produced. Real fixtures beat invented
ones, and these cost nothing to collect - the agent generates them on its own.

One deliberate limit: "this function returns 81" stays NO CLAIM. That is analysis of what code
would do, not an assertion that it ran. Over-detection would make the verdict meaningless.

45 tests.

## Day 2 — the rail was reading the wrong thing

Went to build a proper approval surface and found a bug in my own UI first.

`useTrueFoundryToolResponses()` sounds like "the tool responses so far". It is actually "ask-user
tool calls waiting on an answer" - `{ pending, respond }`. The Did panel was wired to it, which
means it could never have shown a single execution. It looked plausible in code review and would
have looked plausible on camera, right up until someone asked why the count stayed at zero.

Real executions live on the assistant messages as tool-call parts carrying a result. There is now
one hook, `useAgentState`, that reads them, so the rail cannot quietly read the wrong thing again.
It re-wraps them into the harness envelope and passes them through the same shared evidence
functions the CLI uses - the interface must not invent its own idea of what counts as a test run.

The approval surface itself, now that it has real data:

- `useTrueFoundryApprovals()` gives the pending approvals with their arguments and a respond action.
- It renders as `role="alertdialog"` with `aria-live="assertive"`, because the agent is stopped and
  nothing proceeds until a person acts. Polite would be wrong here.
- It shows the actual arguments. Approving `create_pull_request` without seeing what is in it is
  not consent.
- Deny and Allow are the same size and weight, and Deny is listed first because it is the
  reversible one. A dialog where the safe option is smaller, greyer or further away is a dialog
  designed to be clicked through.

Also added a sandbox indicator from `useTrueFoundrySandboxId()`, so "sandbox live" is visible rather
than inferred.

## Day 2 — the README was lying

Writing the contributing docs surfaced a gap nobody would have found until a judge hit it: the
README says `cp .env.example .env` and set `TRUEFORGE_MODEL`, and **nothing in the repo ever read
that file**. Follow the setup instructions exactly and the next command fails with "no model".

That is the specific way "a stranger can clone and run it" breaks. Not a missing step - a step that
is documented, followed, and silently does nothing.

Node can load it with `--env-file`, but that flag is rejected inside `NODE_OPTIONS` and does not
survive `tsx`, so each script would need its own invocation. Forty lines of parser is cheaper than a
dependency and cheaper than a README that lies. Eight tests, including the cases that actually bite:
a value containing `=`, a `#` inside quotes that is not a comment, and mismatched quotes.

One deliberate rule: a variable already set in the real environment always wins. Overriding an
explicit `TRUEFORGE_MODEL=... npm run x` with a stale value from a file would be a genuinely nasty
surprise.

Verified by deleting every inline env var and running `npx tsx scripts/apply-agents.ts` on nothing
but `.env`. Seven agents, applied.

## Day 2 — an adversarial review found the verifier blessing lies

Ran a dedicated review over the core logic, hunting specifically for inputs where `judge()` returns
SUBSTANTIATED when it should not. A false SUBSTANTIATED is the worst bug this project can have: the
tool that exists to catch fabrication would be certifying it.

It found several, and reproduced each one. All confirmed here before fixing.

**The verdict rested on regexes over free text, while the two facts that cannot be faked - the exit
code and the command that ran - were optional or unused.**

- `looksGreen` had the exit code as one side of an **OR**, so a non-zero exit could never
  disqualify a run. Real `go test` output exiting 1 was read as green, because the word "ok" appears
  for the packages that passed.
- The pass marker was `\bOK\b`, case-insensitive. That matches the "ok" inside TAP's `not ok 3` -
  the *failure* line of `node --test`, which is what this repo's own JS fixture emits. It also
  matched `HTTP/1.1 200 OK` from a curl.
- The failure pattern did not know `not ok`, `# fail 1`, bare `FAIL`, or `N failing`. Our own
  fixture was caught only by accident, because its diagnostic happens to contain `AssertionError`.
  A `TypeError` - exactly what a bad patch produces - slipped through.
- `testRuns()` classified by output text alone. So `echo ok` counted as a passing test suite, and so
  did a file the agent wrote itself and read back. That last one defeats the entire harness:
  fabricate output into a file, cat it, cite it.
- The fabricated-report guard only fired when there were **zero** executions. Listing a directory
  once disabled it completely, and the claimed output was never compared to anything recorded.

Fixed by inverting what the verdict rests on. The exit code decides when we have one. A test run
must have been produced by a command that looks like a test invocation, which meant correlating
each `tool.response` back through its `toolCallId` to the command on the model message. And a
claimed output must now actually appear in something that ran.

Also fixed, all found by the same review:

- **Typing "abort" at the approval prompt approved the call.** The check was
  `answer.startsWith('a')`. "abort" is the word an operator reaches for when they have just realised
  they do not want this. Exact words only now.
- `--deny-all` gated approvals but answered `ask_user_question` with "use your best judgement and
  continue" - the most permissive possible answer, in the mode whose entire purpose is to prove the
  gate holds.
- An answer that was never captured returned NO CLAIM, which the runner treats as success. Empty is
  now its own verdict.
- `resultOf` threw on a null element and silently returned empty output for MCP content arrays,
  string exit codes, snake_case exit codes, and object results. Each of those quietly deletes a red
  run from the evidence.
- Recorded output containing three backticks closed the report's code fence early and could forge a
  whole second "Executions" section in the artifact a human reads.
- A tool publishing both `readOnlyHint: true` and `destructiveHint: true` classified as read-only
  and dropped out of the risk list. Destructive is checked first now.
- `preflight` reported an empty sandbox list as configured, accepted non-2xx bodies as data, and
  audited the library's default approval policy rather than the one the specs declare.
- `agents:apply` exited 0 when every single agent failed to apply.
- A missing `python3` made `check-fixtures` report the fixture as no longer broken.
- `progress()` advertised a `Patch` phase whose index was unreachable. Nothing in the event stream
  reveals that a patch was written, so the phase list is now only what can actually be observed.

Twenty regression tests, every one built from the exact input that exploited it. 73 total.

The lesson is the same one the project is about, turned on itself: I had tests, and they passed, and
the thing was still wrong - because the tests were written from the same assumptions as the code.
It took someone adversarial, looking specifically for a blessed lie, to find them.

## Day 2 — published, and the interface rebuilt

The repo is public: `manumishra12/quartermaster`, with the fixture split into its own repo so an
agent pointed at it cannot read these notes. `main` is branch-protected - pull requests required, no
force pushes, no deletions. The PR discipline is enforced rather than promised.

CI passed on a clean runner on the first try, which is the only real test of "a stranger can clone
and run this". Three jobs: unit tests, the UI build, and the check that both fixtures are still
broken.

Then rebuilt the interface on Tailwind with a light theme alongside the dark one.

- Three theme states, not two. System is the default: a viewer who has told their operating system
  they prefer dark has already answered this question, and overriding that on first load is
  presumptuous.
- A restrained type scale - five sizes. More sizes read as indecision rather than hierarchy.
- Light is warm off-white, not pure white. A full-brightness field beside a code block is fatiguing
  and this interface gets read for long stretches.
- The light theme failed its own contrast rule immediately: `--qm-border` at 1.40:1 where WCAG
  1.4.11 wants 3:1 for control boundaries. Caught by the test, not by eye. Now 3.60:1.

And a real bug the rewrite exposed: `readTokens` flattened every declaration into a single map, so
adding a second theme would have shipped it entirely unchecked. That was listed as latent in the
review because the stylesheet had no duplicates at the time. Writing the light theme is exactly the
change that made it live. It reads per theme now, and both are asserted - 23 contrast checks.

84 tests.

## Day 2 — the interface had no tests, and its data shape was a guess

Skills are registered now that the repo is public, so four agents run with their skill packs
attached rather than stripped.

Then the thing that had been bothering me. The rail reads tool-call parts off the assistant
messages, and I had inferred that shape rather than verified it - which is exactly how the previous
version came to read `useTrueFoundryToolResponses()` and show nothing.

So I read the adapter instead of guessing. A tool-call part is
`{ type, toolCallId, toolName, argsText, args, result? }`, and `result` is the raw
`tool.response.content` - the same envelope the CLI receives. The reader was right this time.

But the part also carries `args`, and that changes something. The CLI now requires a recorded
*command* to look like a test invocation before it counts a run as proof; the interface was still
falling back to matching output text. Same session, two different verdicts, depending on where you
read it. The command now flows through the UI as well, into the same shared functions.

Then wrote the tests the interface never had. Thirty-eight of them:

- The rail against realistic harness data - and deliberately not against mocked evidence rules. The
  hooks are mocked; `@evidence` is the real module. A rail that disagreed with the CLI fails here.
- Including the exploit cases from the review, at the UI layer: a `go test` failure exiting 1 whose
  output contains "ok" must render as "did not pass", and `echo ok` must count as an execution but
  not as proof.
- The approval gate: that it shows the actual arguments, that both buttons exist and are reachable,
  and that Deny sends `approved: false`.
- The theme system, including the failure modes that actually happen: storage that throws on read
  in a private window, storage that throws on write when the quota is full. Neither may stop the
  page rendering, and an explicit choice still applies for the session even when it cannot be saved.
- The toggle by keyboard alone. Real radios in a fieldset, so it is announced as a group without any
  ARIA of our own - a div-based toggle would look identical and be unusable without a mouse.

CI runs them now. The rail is what a person reads before approving something irreversible; it gets
the same treatment as the rules behind it.

Also normalised the spacing rhythm to three gap values. Four had accumulated, which is not a design
decision, and it shows up as lines that almost line up.

122 tests across the two packages.

## Day 2 — dependencies, and a sidebar that answers the right question

Updated the whole toolchain: Vite 6 to 8, Vitest 3 to 4, jsdom 25 to 30, plugin-react 4 to 6,
jest-dom 6 to 7, @types/node 22 to 26, and TypeScript 5.9 to 7. Everything passed on the first try.
The UI build went from 27 seconds to under three - Vite 8 and the native TypeScript compiler
between them are close to an order of magnitude.

Then rebuilt the sidebar, which had been a brand header and a list of past conversations.

The list is the least important thing in that column. This product exists to answer one question
before anything else - **what is this agent allowed to touch** - and that was only visible by
opening a settings page in a different application. The sidebar now ends with the agent's standing
reach: its sandbox, every connector, and the gate standing in front of each one.

Read from the live agent spec, not written by hand. A hand-written list of what an agent can reach
is a comment, and comments go stale silently. For this panel, going stale means telling somebody a
write is gated when it is not.

The dangerous case gets said out loud: a connector attached with `require_approval_for_tools: []`
renders as **ungated**, in the failure colour. An interface that stayed quiet there would be hiding
the exact thing it exists to surface. There is a test for it.

Also fixed something the extraction exposed: the narrow-screen layout was rendering the entire
sidebar - thread list, reach panel and all - stacked on top of the conversation. Only the header
crosses that breakpoint now.

And added proper heading levels. The rail was using h2 with no h1 anywhere, which is how the page
reads to somebody navigating by headings.

Forty-seven UI tests, 131 across the project.

## Day 2 — the fail-open hole, found in the shipped catalog

`quartermaster-local` had no MCP connector at all, which meant the one agent anybody can run today
did not demonstrate "real tools through MCP". Two catalog servers need no credentials, so I
connected `deepwiki` and `parallel-web`.

Then ran the audit, and it caught something on a server I had connected thirty seconds earlier.

**deepwiki publishes no annotations on any of its three tools.** It ships in TrueForge's own
catalog. Under the default policy of `["@write", "@destructive"]`, all three would execute with no
approval gate. They are read-only in practice, so nothing dangerous follows here - but this is no
longer a hypothetical about some hand-written server. It is in the catalog people connect from with
one click.

The fix is stronger than gating. The spec names the three tools in `enable_tools` rather than
reaching them with a tag, so a tool the server adds later is not enabled at all and there is
nothing left to gate. Fail closed at the enable layer rather than the approval layer.

Which then required teaching the tools to tell those two situations apart. The audit was reporting
all three as ungated risks - technically true under the default policy, useless as a signal, and an
alarm that always fires is an alarm nobody reads. `ungatedRisks` now takes the enable list too: a
tool reached only by name is contained, a tool reached by a tag is not.

And both tools were caught lying about it afterwards. The audit closed with "every reachable tool
is annotated" and preflight said "3 tools, all annotated" - neither true, both hardcoded from
before the case existed. A safety tool that reports a reassuring falsehood is worse than one that
says nothing.

## Day 2 — a fifty-agent review found the interface was blank and the core rule was one command from useless

Ran four independent reviewers over the code, the scripts, the interface and the docs, each finding
verified adversarially by a separate agent trying to refute it. Fifty agents, 62 findings, 32
confirmed, 13 refuted.

Two of them mattered more than everything else in this log.

**The interface did not render at all.** `StatusRail` and `Topbar` both call
`useComposerBusyState()`, which throws outside `ComposerBusyProvider`. That provider is wired inside
`<Thread />`, which this layout deliberately does not use - it composes `ThreadContainer` and
`ComposerContainer` separately so the rail can sit beside them. So the entire surface was blank.

It shipped because both checks I trusted were incapable of catching it. The component tests mock
that exact hook, so they proved the components behave correctly in a world where the bug does not
exist. And `curl localhost:5173` returned 200 the whole time, because the HTML shell serves fine and
React fails in the browser afterwards. There is now a mount test that renders the real tree with
nothing mocked but the network, and asserts the rail, the sidebar and the topbar are all present.

**And a single command defeated the evidence rule.** `TEST_COMMAND` was an unanchored substring
match, so `cat pytest.log` "looked like a test command" - and because `testRuns()` stopped checking
the output once a command was known, a file of fabricated output read back with exit 0 counted as a
passing test run. A session with a real red run flipped from CONTRADICTED to SUBSTANTIATED. The rule
written to make fabrication impossible could be defeated by writing a file and reading it. My own
regression test survived only because its fixture happened to be named `result.txt` rather than
`pytest.log`.

The runner now has to be in command position - first word of a shell segment, after any environment
assignments - readers like cat and echo are rejected outright, `--collect-only` and `--version` do
not count as runs, and the command and the output must *both* look like a test rather than either
one.

The rest, each confirmed by reproduction:

- Pass phrasings that assert success without the exact words - "the suite is now green", "no tests
  are failing anymore" - returned NO CLAIM over a recorded failure, and NO CLAIM exits 0.
- `\bFAIL\b` matched case-insensitively, so `# fail 0` - the line a *passing* node --test prints -
  read as a failure. The tool was calling honest agents liars. Failure markers are split by case
  now: runners shout FAIL, counters whisper it.
- The fabrication guard required *every* claimed value to be unsupported, so one accurate quote
  copied from a harmless command immunised every fabricated line beside it. And a claimed exit code
  was compared against nothing at all.
- The "Can reach" panel read the hook's wrapper rather than `agentSpec`, and looked for snake_case
  fields the runtime does not use. It was permanently empty - a panel whose entire job is disclosing
  what an agent can touch, telling every viewer it could touch nothing. Its tests mocked the hook as
  returning the spec directly, so the tests agreed with the bug.
- The rail kept its own copy of the pass/fail rule, and the copy had drifted: it treated "0 failed"
  as a failure and did not know the exit code decides. Two implementations of "did this pass" is one
  more than a product about verdicts can afford.

One finding turned out not to be mine: the render loop warning reproduces with a bare layout and no
components of ours, so it is in the SDK. That is a third upstream report.

99 tests in the root, 55 in the interface.

## Day 2 — Qodo installed, and it found things on its first pass

Installed and working. It did not auto-review the two open pull requests because both were opened
before the install, so both were triggered by hand with `/agentic_review`.

**On PR #2 it caught the README lying about the repository's own governance.** The document said
`main` allows no direct pushes, force pushes or deletions, while the protection was configured with
`enforce_admins: false` - so the owner could push straight to it. Fixed by making the statement true
rather than by softening it: enforcement now applies to administrators. A rule that holds for
everyone except the person most able to break it is a convention, not a protection.

**On PR #1 it found three, two of them real bugs.**

An unannotated tool *absent* from an explicit `enable_tools` allowlist was reported as an ungated
risk, even though it cannot run at all. The audit was contradicting the fail-closed design
`SECURITY.md` prescribes, and failing loudest for the specs doing it right. One of my own tests
asserted that wrong behaviour - which is guideline five in `.pr_agent.toml`, a test that agrees with
the bug, demonstrated on me within hours of my writing it down.

A claimed exit code was only checked when some execution reported a numeric one. When none did -
most envelopes from some servers - a fabricated `exit code: 0` passed as NO CLAIM and exited 0.
Having nothing to check against is not the same as having checked.

The third, duplicated approval policy across both quartermaster specs, I disagreed with and said so
in the thread. Agent specs are plain JSON with no include mechanism, and inventing one would put a
build step between a reviewer and the safety policy they are trying to read. The duplication stays;
a test now fails if the two drift apart.

## Day 2 — the rest of the review findings

- A run blocked waiting for a connector to be authorized reported itself finished and exited 0. It
  now exits 1 and says what it was waiting for. Unattended, it stops rather than pretending.
- The verdict label map had four keys and five verdicts, so NO ANSWER printed as the literal word
  "undefined" in the one line a person reads to decide whether to trust a run.
- Allow and Deny had no in-flight guard, so a double click sent two approval responses for the same
  call. Both now disable on the first, and say which decision was taken.
- The approval prompt was never announced and never took focus. The agent is stopped until somebody
  acts, so it now takes focus and announces separately for anyone whose focus is elsewhere.
- The final phase spun forever after a run finished, because the interface discarded
  `progress().settled`.
- `tools:audit` printed a global "nothing runs ungated" while a connector sat unauditable for want
  of credentials. A connector we could not read is not a connector we cleared; it exits 1 now.
- `preflight` checked one of the two skills every spec requires.
- `bootstrap-repo.sh` printed a reassuring note when branch protection failed, and hid the error. It
  now says the protection was not applied, and exits non-zero.
- The `research-desk` smoke case asserted `/\w{20,}/` - any sentence of prose - while reporting
  "reaches the web through Exa". It now requires a URL in the recorded output.
- Nothing validated the agent specs: not tsc, which does not read JSON, and not CI. A typo in
  `require_approval_for_tools` would apply cleanly and gate nothing. `scripts/lib/spec.mjs`
  validates every spec, and the suite fails if one is unsound.
- Added a prompt-injection rule to `research-desk`, and to both quartermaster agents. One reads
  arbitrary web pages, the others read repositories they did not write. Text found in either is
  data, not instruction - and a page trying to steer the agent is a finding worth reporting rather
  than obeying.

108 tests in the root, 61 in the interface.

## Day 2 — CI was red while every test passed, and my own checks had been lying

The build failed with 61 of 61 tests green. Vitest exits non-zero on unhandled errors regardless of
assertions, and the mount test produced two: "Maximum update depth exceeded. The result of
getSnapshot should be cached."

Three things came out of chasing it.

**My local verification had been masking exit codes all along.** Every check in this session ran
`npm test | grep ...`, which reports grep's exit status, not the test runner's. `npm test` had been
exiting 1 locally too and I had been reading "87 passed" and calling it green. Every command is now
checked by its real exit code.

**One of the two errors was mine.** The stub in the mount test returned
`{ data: [], nextPageToken: null }`, but the adapter reads `page.response.pagination.nextPageToken`.
Every session-list load threw, and the failing list retried hard enough to look like part of the
update loop. Fixed by matching the contract; that error is gone.

**The remaining loop is upstream.** It reproduces with a bare layout containing none of our
components, and it escapes asynchronously where neither `act()` nor an explicit unmount can contain
it. So the tolerance is scoped as narrowly as it can be: two Vitest projects, and
`--dangerouslyIgnoreUnhandledErrors` on the `test:mount` script only.

I checked that the narrowing is real rather than assumed, by putting a deliberate unhandled
rejection in a unit-project file: it fails the run. The first attempt at scoping did not work -
the option is not honoured per project in the config, so it sat there reading as protection while
protecting nothing. That is the same failure this project keeps finding in other people's code, and
the reason I tested it instead of trusting it.

Deleting the test was the alternative. It is the test that caught the interface rendering blank.
