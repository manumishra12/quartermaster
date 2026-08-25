---
name: Feature request
about: Propose a change to an agent, a check, or the interface
title: ''
labels: enhancement
assignees: ''
---

## The problem

<!-- What does not work today, or what cannot be told apart from what. Describe the situation, not
     the solution. -->

## What you propose

## What it touches

- [ ] An agent spec (`agents/*.json`)
- [ ] A skill (`skills/`)
- [ ] A script (`scripts/`)
- [ ] The interface (`ui/`, `design-system/`)
- [ ] The fixtures
- [ ] Docs only

## What would prove it works

<!-- Which check covers it: a case in `npm test`, an agent in `npm run smoke`, something new. A
     behaviour with nothing asserting it is a claim, and this repo exists because claims are cheap.
     -->

## Safety

Does this widen what an agent can reach, or what it can do without a human approving it? If it adds
or enables an MCP tool, say whether that server annotates its tools, because an unannotated tool is
not covered by the default `["@write", "@destructive"]` policy. See `TOOLS.md` section 2a.
