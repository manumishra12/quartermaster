## What this changes

<!-- One or two lines. -->

## Why

<!-- The reason the change is right. This is the part that is not in the diff. -->

## Checks

- [ ] `npm run check` passes (typecheck, unit tests, fixtures still broken)
- [ ] `npm run tools:audit` passes, if this touches a connector, `enable_tools` or
      `require_approval_for_tools`
- [ ] `npm run smoke` passes, if this touches `agents/*.json` or anything under `scripts/`
- [ ] `cd ui && npm run build` passes, if this touches `ui/` or `design-system/`

`check` runs offline. `tools:audit` and `smoke` need a running TrueForge server, so say here if you
could not run one.

## Evidence

<!-- For a behaviour change, paste what was recorded: the run output, or the verdict block from
     evidence/<session>/report.md. Not a description of it. -->

## Before merging

- [ ] No test was edited or loosened to make this pass
- [ ] No token, key or `.env` content in the diff
- [ ] `TOOLS.md` updated, if the tool surface or approval policy changed
- [ ] `DEVLOG.md` updated, if something broke here and taught us something
- [ ] Qodo's review is answered: fixed, or replied to with why it stands
