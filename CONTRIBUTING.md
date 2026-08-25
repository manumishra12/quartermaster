# Contributing

Everything lands through a pull request. `main` is protected, and the review trail on each PR is
part of what this repo is for. A change pushed straight to `main` leaves no trail, and the trail
cannot be reconstructed afterwards.

## What you need

- **Node 22.14 or newer.** CI runs Node 22.
- **Python 3.** One fixture is a Python package, and `npm run fixtures:check` runs it.
- **A running TrueForge server with one configured model** - only for the checks that talk to the
  harness. The unit tests, the typecheck and the fixture check all run offline.

## Setup

```bash
npm install
npx @truefoundry/trueforge        # http://localhost:8790
```

Then configure the server: a model, a sandbox provider, the two skills in `skills/`, and whichever
connector the agent you are working on needs. README has the exact steps.

```bash
cp .env.example .env              # set TRUEFORGE_MODEL to a configured model FQN
npm run agents:apply
npm run preflight                 # names what is still missing, and the fix for each
```

The scripts read `process.env` directly, so export the values rather than assuming the file is
picked up for you: `set -a; . ./.env; set +a`.

No credential belongs in this repo. The model key, the Daytona key and the GitHub PAT are configured
in the TrueForge UI and stay in the harness. `.env` is gitignored and holds a base URL and a model
name, nothing secret. If you need a PAT to reproduce something, scope it to one repo: that token is
the blast radius if the approval gate is ever bypassed.

## The checks

| Command | What it proves | Needs the harness | In CI |
| --- | --- | --- | --- |
| `npm run check` | typecheck, unit tests, fixtures still broken | no | tests and fixtures do |
| `npm test` | evidence rules, annotation classifier, contrast maths | no | yes |
| `npm run typecheck` | the specs still type against the SDK's `AgentSpec` | no | no |
| `npm run fixtures:check` | both fixtures still fail | no | yes |
| `npm run tools:audit` | nothing reachable would run ungated | yes | no |
| `npm run smoke` | every credential-free agent reached its tools | yes, and a model | no |
| `cd ui && npm run build` | the interface compiles | no | yes |

`npm run check` is the one to run before every push. It is offline and takes seconds.

Three of these are unusual enough to explain:

**`fixtures:check` asserts the fixtures are still failing.** It is the one check here whose success
condition is a failure. A fixture that quietly starts passing is worse than a red build: the demo
still runs, the agent finds nothing to do, and you discover it on camera.

**`tools:audit` is not optional when you touch a connector or an approval policy.** TrueForge
resolves `@write` and `@destructive` from the annotations an MCP server publishes, and a tool that
publishes no annotations matches neither. The default policy then lets it through with no gate while
the spec still reads as though it is protected. `TOOLS.md` section 2a has the detail.

**`smoke` checks what the harness recorded, not what the agent said.** Each credential-free agent
gets a small deterministic task, and the assertion is that a matching execution appears in the event
stream. It has a per-case budget (`npm run smoke -- --budget 180`); without one, a stuck model turns
the suite into a hang, which is indistinguishable from a broken harness. Run one agent with
`npm run smoke -- --agent analytics`.

## Pull requests

1. Branch off `main`. Prefix with `feat/`, `fix/`, `docs/` or `chore/` and keep the name short.
2. One change per PR. A PR that does two things gets one comment thread arguing about both.
3. Open the PR and fill in the template. CI runs the unit tests, the fixture check and the UI build.
4. Qodo reviews it. Deal with what it finds before merging: fix it, or reply on the thread saying
   why it stands. Either is an answer. Leaving it unanswered is not, because the review trail is
   read as a record of what was considered.
5. Merge when CI is green and every review comment has been answered.

Commit messages: a subject line, a blank line, then why the change is right. What changed is already
in the diff. The reason is not, and it is the part a reviewer needs. Changes to `agents/*.json`
deserve more of that than anything else here, because that file is the safety policy.

## Conventions

**The specs are the source of truth.** Agent behaviour changes by editing `agents/*.json` and
running `npm run agents:apply`. Do not configure an agent by clicking in the TrueForge UI. UI state
cannot be reviewed in a pull request, and `require_approval_for_tools` is API-only anyway, which is
the reason the specs live in this repo at all.

**Never edit a test to make it pass.** The agent is explicitly forbidden to do this, and so are we.
If a test looks wrong, say so in the PR and change it as its own commit with its own argument.

**Never loosen an assertion to get green.** A failing assertion is information. When the smoke suite
first failed on `analytics`, the assertion was wrong and the agent was right, so the assertion got
fixed rather than widened - and the failure message got fixed too, so the next one prints what was
actually recorded.

**Fixtures stay broken, and the fix stays out of the repo.** `fixtures/ledger` is also published as
its own repo (`scripts/publish-fixture.sh`) so the agent cannot solve it by reading our notes. Do
not commit a solution anywhere the agent could reach.

**Evidence rules live in one file.** `scripts/lib/evidence.mjs` decides every verdict, and the UI
imports it as `@evidence`. The CLI and the interface must never disagree about whether a claim is
substantiated, so do not reimplement a rule in the UI.

**Report what was recorded, not what was narrated.** Anything that shows what an agent did reads
recorded tool responses. The transcript is the agent's account of events; the event stream is the
events.

**Green means one thing.** In the interface, green means a real run passed, and nothing else is ever
green. Colours live in `design-system/` tokens, never as raw hex in a component, and
`scripts/lib/contrast.test.mjs` asserts every pair the status rail renders. A token nudged to
improve a screenshot fails the build.

**Comments say why.** Every script here opens with the reason it exists, and the non-obvious lines
carry the constraint that produced them. What the code does is readable; why it is shaped that way
is not.

**Layout.** Two-space indent everywhere except Python, which is four. Single quotes and semicolons
in JavaScript. Prose wraps around 100 columns. `.editorconfig` carries the rest.

## Keep the notes current

- `DEVLOG.md` gets its lines the day something breaks, not a reconstruction at the end. It is
  written as it happens because that is the only way it stays true.
- `TOOLS.md` claims to be in sync with `agents/*.json`, so it has to be. Update it in the same PR
  that changes a tool, a connector or an approval policy.
- `README.md` is written for someone who has never seen this repo. If a setup step changed, it
  changed there too.

## Reporting a problem

Bugs and ideas go through the templates in `.github/ISSUE_TEMPLATE`. Security issues go through
`SECURITY.md` and never into a public issue.

Upstream bugs go upstream. Two were found while building this - the zustand hoist that breaks
TrueForge's own documented UI quickstart, and the fail-open approval gate - and both belong to
`truefoundry/trueforge` as reproducible reports rather than in a workaround here that nobody
upstream ever sees.
