# Tool list

Everything Quartermaster is allowed to touch, and what is gated. Kept in sync with `agents/*.json`.

## 1. Harness built-ins (no setup, come with TrueForge)

| Tool | Provided by | Used for | Gated |
| --- | --- | --- | --- |
| Sandbox exec / shell | `config.sandbox.enabled` | clone repo, install deps, run the test suite, apply patch | no — isolated by definition |
| Sandbox files | `config.sandbox.enabled` | read source, write patch, save evidence logs | no |
| File downloads | `config.sandbox.file_downloads` | let the user pull the diff and the test log out | no |
| `create_sub_agent` | `config.dynamic_sub_agents` | fan out across candidate root causes in parallel | no |
| `ask_user_question` | `config.ask_user_questions` | ask when the test itself looks wrong, or the fix has two valid strategies | n/a — it *is* the pause |
| Generative UI (OpenUI) | `config.generative_ui` | render the diff, the before/after test output, the evidence card | no |
| Code Mode (PTC) | sandbox | aggregate long test output in code instead of flooding context | no |
| Compaction + large-response offload | `config.context_management` | keep long fix loops cheap | no |

## 2. MCP connectors

| Server | Auth | Agent | Tools enabled | Approval |
| --- | --- | --- | --- | --- |
| **GitHub** (shipped catalog) | header (PAT) | `quartermaster`, `code-reviewer`, `gate-demo` | `@read-only` + named writes, different per agent (see section 7); `gate-demo` gets one | `["@write", "@destructive"]` + those writes by name |
| **Exa** (shipped catalog) | none | `research-desk` | `@read-only` | `["@write", "@destructive"]` - nothing it exposes is a write |
| **deepwiki** (shipped catalog) | none | both quartermasters | 3 tools by name | `["@write", "@destructive"]` |
| **ops-desk** (ours, `mcp/ops-desk`) | none | `incident-responder` | `@read-only` + `rollback_deploy`, `restart_service`, `resolve_alert` | all three by name, plus `["@write", "@destructive"]` |
| **front-desk** (ours, `mcp/front-desk`) | none | `desk-assistant` | `@read-only` + `create_issue`, `update_issue`, `close_issue`, `send_message`, `send_email` | all five by name, plus `["@write", "@destructive"]` |
| **warehouse** (ours, `mcp/warehouse`) | none | `analytics` | all five by name, no tag | `["@write", "@destructive"]`, which today match nothing - see below |

### An approval policy on a connector where every tool is a read

`warehouse` gates nothing today, and the policy is still `["@write", "@destructive"]` rather than
`[]`. The two say the same thing about today and opposite things about tomorrow: an empty policy
means every tool on that server runs ungated forever, including one added next week, and the spec
validator refuses it for exactly that reason. The tags are a standing instruction that costs nothing
to keep.

An approval prompt in front of a read would be worse than nothing anyway. It teaches the operator
that the prompt is noise, and the next one they wave through is a rollback.

Where that connector actually fails closed is the admission list: all five tools are named rather
than reached with `@read-only`, so a tool the server grows later is not enabled at all until
somebody adds it to the spec on purpose. That is the preference this document argues for in section
2a, applied to a server that has nothing to gate.

### Why there is no Gmail or Slack

The hackathon describes its approval-gated assistant as reaching "Gmail or Slack". TrueForge ships
neither: the fourteen servers in the catalog are `github`, `tavily`, `bright-data`, `deepwiki`,
`exa`, `parallel-web`, `linear`, `notion`, `sentry`, `supabase`, `stripe`, `confluence`, `jira` and
`posthog`. Reaching a real inbox would mean writing an MCP server against Gmail's API, with OAuth
credentials and a real mailbox behind it.

That is the wrong trade here, and not only for the time it would cost. The rules require that
anything the agent touches is yours to touch and that private and login-protected information stays
out of the repository and the demo - and a mailbox is the most private thing anybody would connect.
A demonstration of an approval gate does not need real mail to be convincing; it needs the gate to
fire on something irreversible, in front of a person, on camera. `front-desk` gives that:
`send_email` is gated, refuses an address the desk does not know, and reports the whole message back
so an approver can compare what they said yes to against what was sent. No account, no OAuth, and
nothing in frame that should not be.

The same reasoning replaced Sentry and Linear.

Sentry and Linear used to sit in the last two rows. Both needed an account, so `agents:apply`
skipped the two agents that used them and the hackathon's own "easiest start" agent was one nobody
could run. `ops-desk` and `front-desk` replaced them: same shape of surface, every write gated, no
credential anywhere. They also annotate their tools properly, which the thing they replaced was
not guaranteed to do - see section 2a for why that matters more than it sounds.

Notes:
- Verified against the live catalog: GitHub authenticates by **static header (a personal access
  token)**, not OAuth. Scope the token to the demo repo only - it is the blast radius if the
  approval gate is ever bypassed.
- Credentials live in the connector, never in the agent spec. Nothing secret is committed.
- **Every connector is preloaded.** An earlier version of this table said `preload: false` on the
  grounds that deferring tool schemas keeps context lean. It does, and it also does not work here:
  a deferred tool resolves to `{"error":"MCP server 'deferred-tools' not found"}`. The section
  "Why every connector is preloaded" near the end of this file has the whole investigation, and
  `npm run check` now fails a spec that sets it.
## 2a. The approval gate is only as good as the annotations behind it

Read this before trusting the default policy.

TrueForge resolves `@write` and `@destructive` from the annotations each MCP server publishes
(`core/mcp/toolSelectors.ts`):

    @read-only    readOnlyHint === true
    @write        readOnlyHint === false and destructiveHint !== true
    @destructive  destructiveHint === true

A tool that publishes **no annotations matches none of these**. The harness source says so outright:
*"Unannotated tools are exempt unless named in `require_approval_for_tools` or covered by `@all`."*

So the default policy `["@write", "@destructive"]` is **fail-open**: point the agent at a server that
does not annotate its tools and the writes execute with no gate, silently, while the spec still
reads as though it is protected.

Verified on a live server:

| Server | Tools | Annotated | Verdict |
| --- | --- | --- | --- |
| `exa` | 2 | yes, all read-only | default policy is honest here |
| `parallel-web` | 2 | yes, all read-only | honest |
| **`deepwiki`** | 3 | **none of them** | **the hole, in the shipped catalog** |
| **`github`** | 44 | **yes, all of them** | 27 read-only, 16 write, 1 destructive - the default policy gates every write |

GitHub, where every dangerous action lives, annotates all 44 of its tools correctly - so the
default policy really does gate all 17 writes there. `deepwiki` was the outlier, not the rule. But
it ships in TrueForge's own catalog and publishes no annotations on any of its three
tools. Under the default policy `["@write", "@destructive"]` all three would execute with no
approval gate. They happen to be read-only in practice, so nothing dangerous follows from it here -
but it is proof the hole is real in the catalog people will actually connect from, not a
hypothetical about some hand-written server.

The fix used here is stronger than gating: the spec names the three tools in `enable_tools`
instead of reaching them with a tag. A tool the server adds later is then not enabled at all, so
there is nothing to gate. Fail closed at the enable layer, not the approval layer.

```json
{
  "name": "deepwiki",
  "enable_tools": ["ask_question", "read_wiki_contents", "read_wiki_structure"],
  "require_approval_for_tools": ["@write", "@destructive"],
  "preload": true
}
```

GitHub is where every dangerous write lives, so it is the one that has to be checked rather than
assumed. `npm run tools:audit` does the checking and exits non-zero if anything would run ungated.

If the GitHub tools turn out to be unannotated, the spec goes fail-closed instead:
`enable_tools: ["@read-only", ...the literal write tools we actually want]`, with those same literal
names in `require_approval_for_tools`, so the gate no longer depends on the server getting its
annotations right.

## 3. Skills (git-backed SKILL.md packs, ours)

| Skill | What it teaches | Requires sandbox |
| --- | --- | --- |
| `verified-fix` | the reproduce → isolate → minimal patch → re-run → evidence procedure, and the rules the agent must not break | yes |
| `evidence-report` | how to render the verdict as a Generative UI card - verdict banner, root cause, diff, before/after runs - against the real OpenUI component signatures | yes |

Skills load progressively — only the `description` is in context until the agent decides the skill
is relevant, then the whole pack is materialized in the sandbox at `/opt/tfy/skills/{name}`.

## 4. Approval policy — the safety story in one table

| Action | Where it runs | Gate |
| --- | --- | --- |
| Run tests, install deps, execute anything | sandbox | isolation only, no human gate needed |
| Write files | sandbox | none — the sandbox is throwaway |
| Create branch / commit / push | GitHub, real | **approval required** |
| Open or update a pull request | GitHub, real | **approval required** |
| Comment on an issue or PR | GitHub, real | **approval required** |
| Submit a pull request review | GitHub, real | **approval required** |
| Merge a pull request, push files, delete a file | GitHub, real | not enabled for any agent here |
| Read repo, issues, CI status | GitHub, real | no gate — read-only |
| Roll back a deploy, restart a service, resolve an alert | ops-desk | **approval required** |
| File, edit or close an issue; send a message | front-desk | **approval required** |
| Read alerts, logs, deploys, health, projects, issues | ops-desk, front-desk | no gate — read-only |
| Read a schema, profile a table, run a SELECT | warehouse | no gate — the connection is read-only, so there is no write to gate |

The ops-desk and front-desk rows are the ones that matter for anyone reproducing this, because they
are the only gated actions that need no account at all. All three servers annotate every tool, so
the tags in the policy resolve to what their names say - which, as section 2a explains, is not
something to assume.

The warehouse row is the odd one out and the point is that it should be. Its guarantee is not an
approval gate; it is a connection that SQLite will not let write. A gate asks a person to be right
every time, and a read-only connection does not ask anybody anything.

Tool approval is API-only in TrueForge today (`require_approval_for_tools` in the agent spec), which
is exactly why the specs live in this repo as JSON and are applied through the SDK rather than
clicked into the UI.

## 5. Accounts and keys needed

- [ ] Model provider API key — one cheap model, one strong model (any OpenAI-compatible endpoint works)
- [ ] Daytona API key — sandbox provider, needs permission to write/delete snapshots and write sandboxes.
      A **local sandbox fallback** exists (the server logs it at startup) and unblocks development
      without an account, but it executes on your own machine. Use Daytona for the demo: the safety
      criterion is about real isolation, and claiming isolation you do not have would be the one
      dishonesty this whole project is arguing against.
- [ ] GitHub — a fine-grained PAT pasted into the connector, scoped to one repo (v1)
- [ ] Qodo — GitHub App installed on the submission repo from the first commit

Only the first is needed to see the gate work. `ops-desk`, `front-desk` and `warehouse` run from
this repo with `npm run ops-desk`, `npm run front-desk` and `npm run warehouse`, and between them
they carry every gated action in the demo script - a rollback, a restart, filing an issue, closing one, sending a message. Nothing in
`DEMO.md` requires a GitHub token, and the local-model configuration (`quartermaster-local`) does
not require a provider key either.

## 6. Catalog as shipped (verified against a running server, 2026-08-23)

This section is an inventory of what **TrueForge** ships. The two servers in `mcp/` are ours and
are not in it; they are registered once against a running harness with the `curl` in each server's
README, and `npm run agents:apply` then reports the agents as applied rather than skipped.

14 MCP servers ship in the catalog: `github` and `tavily` and `bright-data` (header auth);
`deepwiki`, `exa`, `parallel-web` (no auth); `linear`, `notion`, `sentry`, `supabase`, `stripe`,
`confluence`, `jira`, `posthog` (OAuth via dynamic client registration).

Model providers: `openai`, `anthropic`, `google-gemini`, `fireworks`, `zai`, `moonshot`, `alibaba`,
`together`, plus `custom` for any OpenAI-compatible endpoint. Model FQNs use dashes, not dots -
`openai/gpt-5-5`, `anthropic/claude-sonnet-4-6`, `zai/glm-5-2`.

The cheap/strong split this project uses: a `zai/glm-5-*` or `fireworks/*` model for mechanical
work, a frontier model for root-cause reasoning. TrueForge swapping models per task is the
sponsor's own cost argument, so demonstrating it is worth the small extra config.

## 7. What `quartermaster` can actually reach on GitHub

Reading is unrestricted. Writing is limited to the five tools the job needs:

```json
{
  "name": "github",
  "enable_tools": ["@read-only", "create_branch", "create_or_update_file", "push_files", "create_pull_request", "add_issue_comment"],
  "require_approval_for_tools": ["@write", "@destructive", "create_branch", "create_or_update_file", "push_files", "create_pull_request", "add_issue_comment"]
}
```

Of the 17 write tools the server exposes, five are enabled. The agent **cannot merge a pull
request, delete a file, fork a repository, or create one** - not because it is instructed not to,
but because those tools are not enabled for it and it has no way to call them. Instructions can be
argued with; an absent tool cannot.

The five it does have are named in `require_approval_for_tools` as well as covered by `@write` and
`@destructive`. That is redundant today, because GitHub annotates correctly. It is not redundant
against the day it stops, and the spec outlives the annotation.

## Why every connector is preloaded

`preload: false` asks TrueForge to defer a connector's tool schemas and let the model load them on
demand. It is the right idea - schemas are expensive and most turns need few of them - and on this
harness it does not work. The deferred path resolves to a server the instance does not provide:

```
{"error":"MCP server 'deferred-tools' not found"}
```

Every connector set to `preload: false` failed to be reached at all, and every one set to `true`
worked. The correlation was exact across six agents. So they are all preloaded, and this note is
here so nobody flips one back on the reasonable assumption that it is only an optimisation.

Worth knowing how this was found: the error above was invisible until `resultOf` learned to read
the harness's error envelope. Before that, a connector that could not be reached produced an empty
result, and an empty result reads exactly like a call that ran and printed nothing.

## Why most agents carry no skills

Both skills are `type: git`, which means every sandbox start for an agent that attaches one does a
git fetch of this repository before the agent can do anything. When that fetch is reset the sandbox
never comes up, and the agent fails entirely:

```
Sandbox initialization failed: (exit code 1): git ls-remote failed (exit 128): fatal: unable to
access 'https://github.com/manumishra12/quartermaster/': Recv failure: Connection reset by peer
(skill: evidence-report)
```

That is the cause of the intermittent `fork/exec /usr/bin/bash: no such file or directory`
failures: the shell is missing because the sandbox was never built.

`evidence-report` describes how to present the verdict of a fix - a diff, and the before and after
test runs side by side. It was attached to seven agents, four of which never run a test. So four
agents were paying a network round trip, and a single point of failure, at every start for a skill
that did not apply to them. They no longer attach it.

The harness accepts only `type: git`, so a local source is not an option; the fix is to depend on
the network only where the skill is actually the right one.

## When every agent suddenly cannot reach its sandbox

The symptom is agents failing at once, with `fork/exec /usr/bin/bash: no such file or directory` or
an empty tool response. bash is not missing; the sandbox was never built. There are two causes and
they look identical from outside:

**The skill fetch was reset.** Any agent attaching a `type: git` skill does a git fetch of this
repository before it can start. See the section above - four agents no longer carry a skill they
never used, which removes most of this exposure.

**The sandbox quota is full.** This one is invisible until something reads the harness's error
envelope:

```
Sandbox initialization failed: Total disk limit exceeded. Maximum allowed: 30GiB.
Consider archiving your unused Sandboxes to free up available storage.
```

Every run creates a sandbox, and the provider here keeps them for
`auto_delete_interval_in_minutes: 7200` - five days. A day of development is enough to fill the
allowance, and then everything fails at once for a reason that has nothing to do with the agents.

Fix it in **Settings - Sandbox providers**: archive the unused sandboxes, and shorten the delete
interval. For a repository where every smoke run creates one, five days is far too long; a couple
of hours is plenty. `npm run preflight` reports the provider as configured either way - it does not
know how much room is left.
