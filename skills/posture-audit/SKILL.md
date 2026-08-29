---
name: posture-audit
description: How to audit an agent fleet's own safety posture from the checks that already exist - run them rather than reimplement them, separate a check that could not run from a check that passed, and report unannotated tools, selector-based enable lists, widening handoffs and skills pinned to a branch. Use before a release, after a spec or connector changes, or whenever somebody asks what this repository's approval policy actually enforces.
---

# Posture audit

An approval policy is a claim about what a fleet of agents cannot do without asking. Like every
claim in this repository, it is worth exactly what the check behind it is worth.

The checks exist. `scripts/audit-tools.mjs`, `scripts/preflight.mjs`, `scripts/lib/authority.mjs`
and the suites under `scripts/lib/` compute nearly all of this, and they are tested. What they
cannot do is run themselves, notice that an answer changed, or say which of today's findings is the
one worth interrupting somebody about.

## Run them, do not rebuild them

```bash
npm run tools:audit                          # every reachable tool, and whether any runs ungated
npm run preflight                            # harness, models, sandbox, skills, connectors, routing
node --test scripts/lib/authority.test.mjs   # the handoff analysis
npm test                                     # everything, including spec and skill validation
```

If you are parsing `agents/*.json` by hand to work out which tools are gated, stop. A second
implementation that disagrees with the first does not give you two answers - it gives you none,
because nobody can tell which one is wrong, and the audit becomes the thing that needs auditing.

Read `authority.mjs` before reporting on its output. Its comparison is deliberately conservative and
reports a widening whenever it cannot prove there is not one, because selectors expand through
annotations a live server publishes and this has to be answerable offline. So a reported widening
sometimes means "no offline check could clear this pair", and reporting that as a defect sends
somebody to fix a spec that is fine.

## The four findings

### 1. A connector whose tools publish no annotations

The selectors are resolved from what the server publishes:

| Selector | Matches |
| --- | --- |
| `@read-only` | `readOnlyHint === true` |
| `@write` | `readOnlyHint === false` and `destructiveHint !== true` |
| `@destructive` | `destructiveHint === true` |

A tool publishing no annotations matches **none of them**. Under the default policy of
`["@write", "@destructive"]` it therefore runs with no human gate, and the spec still reads as
though it is protected. `tools:audit` prints `unannotated` beside such a tool.

Restate this every time you report it. It is the opposite of what the policy looks like it says, and
a reader who skims the spec will conclude the wrong thing every time.

### 2. An enable list built from selectors rather than named tools

The same fact makes a tag-based allowlist fail open. `@all`, or `@read-only` on a connector that
grows, admits a tool that did not exist when the spec was written - and if that tool is unannotated
it is admitted *and* ungated, with nobody having edited anything.

Name the agent, the connector, and the tag. Then weigh it: a tag against a fixture server that ships
in this repository is a smaller fact than a tag against a vendor connector with forty-four tools
that can change under you between two runs.

### 3. A handoff pair that widens authority

Delegation is the route around a gate that needs nobody to lie and no policy to be edited. Agent A
stops at an approval it cannot pass, hands the work to agent B, and B does it ungated.

Report the count of directed pairs that widen nothing, which way the widenings run, and whether the
count matches what the prose says. Several pages state it in words; a number stated in prose and
computed nowhere has usually already drifted, and finding that drift is the point.

### 4. A skill registered at a branch ref

`preflight` reports these as `ok`, and they are - pointing a skill at a branch is how you use one
before it merges. It is a fact with an expiry date. When the branch merges and is deleted, the fetch
fails at sandbox init, and every agent carrying that skill reports that it could not reach its
tools, which sends whoever is debugging to the connector and the token. Neither is the problem.

Name the skill, name the branch, and say what happens when the branch goes.

## The distinction the whole audit rests on

**A check that could not run is not a check that passed.**

Three states in every report, never two:

| State | Means |
| --- | --- |
| clean | the check ran and found nothing |
| finding | the check ran and found something, quoted |
| **not audited** | the check could not run, with the reason and the remedy |

`tools:audit` exits non-zero when a connector could not be listed and prints "no claim is made about
them". `preflight` reports an unauthenticated connector as a miss. `skillPathAtRef` reports an
unresolvable ref as unknown rather than as present. Every one of those exists because the
reassuring version was written first and passed while the thing it checked was broken.

"Nothing runs ungated" over a run where two connectors could not be listed is a false statement
about those two. If you are about to write it, you have found something more interesting than
whatever you set out to audit.

## Reporting

Order: what changed since the last audit, then findings worth acting on, then what could not be
checked, then the clean list. Quote the output - an exit code and four real lines are checkable, and
"the audit was clean" is not.

Each finding carries what it is, which file or connector, what happens if nobody fixes it, and what
the fix is. Where `SECURITY.md`, `TOOLS.md` or `GUARDRAILS.md` already argues the position, point at
the paragraph rather than restating it: two slightly different versions of one rule in one
repository is how the rule stops being one.

Do not pad. Nothing found is a real result, and "four checks ran, here are the exit codes, nothing
changed since Tuesday" is more useful than five invented concerns. An auditor that always finds
something is an auditor nobody reads twice.

## You report, you do not remediate

No spec edits, no fixes, nothing opened. An auditor that lands its own remediation is grading its
own work, and the next audit will agree with it. Say what should change, name who should change it,
and stop.
