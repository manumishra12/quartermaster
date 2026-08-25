---
name: Bug report
about: Something behaved differently from what the docs or the code say it should
title: ''
labels: bug
assignees: ''
---

## What you ran

<!-- The exact command, including flags. For example: npm run agent -- "Fix the failing test in
     fixtures/ledger" -->

## What happened

<!-- Paste the output. Recorded output beats a description of it, and the same rule applies to bug
     reports as to the agent: what was recorded is evidence, what was narrated is an account. -->

## What you expected instead

## If an agent did something wrong

The transcript is the agent's account of what happened. The event stream is what happened. So attach
`evidence/<session>/report.json` if you have it, or at least the verdict block the run printed. A
report that says the agent claimed a pass is hard to act on; a report with `UNSUBSTANTIATED` and
zero recorded executions is a test case.

## Environment

- Node version:
- Python version (only if `npm run fixtures:check` is involved):
- TrueForge version and how it is running (`npx @truefoundry/trueforge`, or something else):
- Model FQN (for example `anthropic/claude-sonnet-4-6`, or a custom endpoint):
- Sandbox provider: Daytona, or the local fallback
- Output of `npm run preflight`, if the problem is in setup

## Before you post

- [ ] No token, key or `.env` content in anything pasted above
