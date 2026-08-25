# Coverage against the six project ideas

The hackathon lists six agents worth building. All six are implemented here as agent specs sharing
one config block, so the safety discipline is identical across them rather than re-decided each
time.

| # | Their card | Their "reaches" | Our agent | What it reaches here |
| --- | --- | --- | --- | --- |
| 1 | Approval-gated assistant | Gmail or Slack | `desk-assistant` | **Linear** - see the note below |
| 2 | Analytics agent | Your database | `analytics` | SQLite warehouse in the sandbox, or Supabase |
| 3 | Code review agent | GitHub | `quartermaster` | GitHub, every write gated |
| 4 | Research desk | Web search | `research-desk` | Exa |
| 5 | Incident responder | Your cloud | `incident-responder` | Sentry |
| 6 | Untrusted code runner | The sandbox | `code-runner` | the sandbox, nothing else |

## The Gmail/Slack note

Neither Gmail nor Slack is in TrueForge's shipped MCP catalog. It ships fourteen servers: `github`,
`linear`, `notion`, `sentry`, `jira`, `confluence`, `supabase`, `stripe`, `posthog`, `exa`,
`tavily`, `deepwiki`, `parallel-web`, `bright-data`.

So `desk-assistant` is built against **Linear**, which is the same shape of problem: it drafts
something a person has to stand behind, reads freely to match the team's existing conventions, and
stops before it files anything. Swapping it for Gmail or Slack is a connector change, not a
redesign - register the server under **Settings → Connectors → Add MCP Server** and change one name
in `agents/desk-assistant.json`.

That substitution is deliberate and stated rather than quietly made. The card's point is the
approval gate, not the vendor.

## Which of them run with no credentials

Four of the seven agents need nothing but a model:

| Agent | Needs |
| --- | --- |
| `quartermaster-local` | nothing |
| `code-runner` | nothing |
| `analytics` | nothing |
| `research-desk` | nothing - Exa needs no auth |
| `quartermaster` | a GitHub PAT |
| `incident-responder` | Sentry OAuth |
| `desk-assistant` | Linear OAuth |

That matters for judging: a reviewer can clone this repo, add one model key, and run four of the
six ideas immediately.

## Testing them

```bash
npm run smoke            # every credential-free agent, against the real harness
npm run smoke -- --agent analytics
```

Each case gives an agent a small deterministic task and asserts that the harness **recorded** an
execution matching what was asked - not that the agent said it did. Same rule as everything else
here: the transcript is the agent's account, the event stream is what happened.
