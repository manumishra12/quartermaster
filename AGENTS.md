# Coverage against the six project ideas

The hackathon lists six agents worth building. All six are here, plus three more, and every one of
them is a spec file sharing the same safety discipline rather than re-deciding it each time.

| # | Their card | Their "reaches" | Our agent | What it reaches here | Account needed |
| --- | --- | --- | --- | --- | --- |
| 1 | Approval-gated assistant | Gmail or Slack | `desk-assistant` | `front-desk` - ships in this repo | **no** |
| 2 | Analytics agent | Your database | `analytics` | a SQLite warehouse in the sandbox | **no** |
| 3 | Code review agent | GitHub | `code-reviewer` | GitHub - eight named tools | a PAT |
| 4 | Research desk | Web search | `research-desk` | Exa **and** parallel-web | **no** |
| 5 | Incident responder | Your cloud | `incident-responder` | `ops-desk` - ships in this repo | **no** |
| 6 | Untrusted code runner | The sandbox | `code-runner` | the sandbox, nothing else | **no** |

And three the list does not ask for:

| Agent | Why it exists | Account needed |
| --- | --- | --- |
| `quartermaster` | the project's own agent: fixes a failing test, proves it, opens a pull request, and answers the review on it | a PAT |
| `quartermaster-local` | the same discipline with nothing to publish to, so a stranger can run it first | **no** |
| `gate-demo` | one gated tool call, so the approval pause is visible on its own | a PAT |

## Why there is no Gmail or Slack

Neither is in TrueForge's shipped MCP catalog. It ships fourteen servers: `github`, `linear`,
`notion`, `sentry`, `jira`, `confluence`, `supabase`, `stripe`, `posthog`, `exa`, `tavily`,
`deepwiki`, `parallel-web`, `bright-data`.

Reaching a real inbox would mean writing an MCP server against Gmail's API, with OAuth and a real
mailbox behind it - and the rules require private and login-protected information to stay out of the
repository and the demo. A mailbox is the most private thing anybody would connect.

So `desk-assistant` reaches `front-desk`, which ships here: projects to read, conventions to match,
teammates to assign to, channels to post in, documents and message history to search, and
`create_issue`, `update_issue`, `close_issue`, `send_message`, `send_email` and `post_to_channel`
all behind the gate. It drafts something a person has to stand behind, reads freely to
match the team's existing conventions, and stops before it files anything. The card's point is the
approval gate, not the vendor. `TOOLS.md` has the longer version of this argument.

## Why two of them were rewritten

`desk-assistant` was built against Linear and `incident-responder` against Sentry, and both needed
an account nobody had - so `agents:apply` skipped them and the two agents the hackathon calls its
easiest start and its hero project were the two that could not run:

```
skipped  desk-assistant      - Unknown MCP server "linear" - not configured (HTTP 422)
skipped  incident-responder  - Unknown MCP server "sentry" - not configured (HTTP 422)
```

`front-desk` and `ops-desk` replaced them: the same shape of surface, every write gated, no
credential anywhere. They also annotate every tool, which the thing they replaced was not
guaranteed to do - and section 2a of `TOOLS.md` explains why that matters more than it sounds.

## Which of them run with no credentials

**Six of the nine**, and they include five of the six cards:

| Agent | Needs |
| --- | --- |
| `quartermaster-local` | nothing |
| `code-runner` | nothing |
| `analytics` | nothing |
| `research-desk` | nothing - neither Exa nor parallel-web needs auth |
| `incident-responder` | nothing - `npm run ops-desk` |
| `desk-assistant` | nothing - `npm run front-desk` |
| `quartermaster` | a GitHub PAT |
| `code-reviewer` | a GitHub PAT |
| `gate-demo` | a GitHub PAT |

That matters for judging: a reviewer can clone this repository, add one model key, and run five of
the six ideas immediately - including the gate firing on something irreversible, because both
fixture servers have gated destructive tools.

`USECASES.md` has the commands.

## Testing them

```bash
npm run smoke            # every agent with a runnable case, against the real harness
npm run smoke -- --agent analytics
```

Each case gives an agent a small deterministic task and asserts that the harness **recorded** an
execution matching what was asked - not that the agent said it did. Same rule as everything else
here: the transcript is the agent's account, the event stream is what happened.

A case whose connector is not configured is **skipped by name** rather than failed, and skips are
counted separately from passes. Reporting a missing GitHub token as a broken agent sends whoever is
reading to the spec, which is not where the problem is.
