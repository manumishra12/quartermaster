# Security

This project runs model-written code and holds credentials that can write to a real GitHub
repository. The safety story is in `TOOLS.md` and `ARCHITECTURE.md`. This file covers how to report
a problem with it, and the one known hole in the approval gate.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repo: **Security → Report a vulnerability**.
That opens a private advisory rather than a public issue, so a working exploit is not published
before there is a fix.

Do not open a public issue for a security problem, and do not put a token, key or session log
containing one into a report.

A useful report has: what you ran, what happened, and what an attacker gets out of it. If it
involves the agent, attach `evidence/<session>/report.json`. The event stream is the record; the
transcript is only the agent's account of it.

This is a hackathon project maintained by one person. Reports are handled on a best-effort basis,
with no response time promised. Only `main` is supported.

### Out of scope here, and where it goes instead

- The TrueForge harness itself: `truefoundry/trueforge`. Two upstream findings from this build are
  written up in `DEVLOG.md` and belong there, not here.
- Daytona, and any MCP server in TrueForge's catalog: their own maintainers.
- The fixtures under `fixtures/` are deliberately broken code. Their bugs are the point.

## Known limitation: the approval gate is fail-open for unannotated MCP tools

Read this before trusting the default policy in any spec here.

TrueForge resolves the selectors in `require_approval_for_tools` from the annotations each MCP
server publishes (`core/mcp/toolSelectors.ts`):

    @read-only    readOnlyHint === true
    @write        readOnlyHint === false and destructiveHint !== true
    @destructive  destructiveHint === true

A tool that publishes **no annotations matches none of these**. With the default policy
`["@write", "@destructive"]`, that tool executes with **no human gate**, silently, while the spec
still reads as though every write is protected. The gate depends on a third-party server having
annotated its tools correctly, and nothing warns you when it has not.

This is a property of the harness, not a bug in this repo. It is stated here because a safety
control that fails open without saying so is worse than no control: it produces confidence that is
not earned.

### Check your own configuration

```bash
npm run tools:audit     # exits non-zero if anything reachable would run ungated
```

Run it after adding a connector, enabling a tool, or changing an approval policy.
`npm run preflight` reports the same finding as part of the setup check.

### Configure it fail-closed

Do not rely on the selectors when the server's annotations are unverified. Name the tools instead,
in `agents/<agent>.json`:

```json
{
  "enable_tools": ["@read-only", "create_branch", "create_or_update_file", "create_pull_request"],
  "require_approval_for_tools": ["create_branch", "create_or_update_file", "create_pull_request"]
}
```

Enable only `@read-only` plus the literal write tools you actually want, and name those same tools
in `require_approval_for_tools`. The gate then holds whether or not the server annotates anything.

`TOOLS.md` section 2a tracks which servers have been verified against a live catalog.

## Other things worth knowing before you run this

**The local sandbox is not isolation.** When no sandbox provider is configured, TrueForge falls back
to a directory under Application Support. That is directory separation on your own machine, not a
VM. It is fine for development. Use Daytona for anything that runs code you did not write.

**Approval defaults to deny when nobody is watching.** The headless runner (`scripts/run.mjs`)
denies every gated tool call when stdin is not a terminal. A gate that quietly allows in CI is not a
gate. `--deny-all` forces the same behaviour interactively, which is the way to test that the gate
holds.

**Credentials stay in the harness.** Model keys, the Daytona key and the GitHub PAT are configured
in the TrueForge UI, never in an agent spec and never in this repo. Scope the GitHub token to a
single repository: it is the blast radius if the gate is ever bypassed.

**Submitted code is input, not instruction.** `code-runner` executes code other people wrote, so it
runs with subagents disabled and is told not to act on instructions found inside what it was asked
to execute. Keep both properties if you change that spec.
