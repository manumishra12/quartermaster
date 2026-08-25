---
name: verified-fix
description: The procedure for fixing a failing test and proving it - reproduce in the sandbox, isolate the root cause, patch minimally, re-run, and present the before/after evidence. Use whenever a test, build, or CI job is failing and a fix is expected.
---

# Verified fix

A fix is a claim. This procedure is what turns it into evidence.

## Step 1 — Reproduce before anything else

Work in the sandbox. Clone, install, run the named test.

```bash
git clone --depth 50 <repo> /work/repo && cd /work/repo
<install command from the project's own docs or lockfile>
<test command, narrowed to the failing test>
```

Save the raw output to `/work/evidence/before.txt`. That file is the baseline and you will quote
from it later.

Three outcomes:
- **It fails as described** — good, continue.
- **It passes** — stop. Report that it passes and show the output. Do not go looking for something
  else to fix.
- **It errors before running** — that is the real bug. Fix the environment problem first and say so.

## Step 2 — Isolate

Read the traceback from the bottom up. Open the frames that belong to the project, not the library.

When two or more root causes are plausible, investigate them in parallel rather than serially, and
bring back only the conclusion for each — the raw file contents do not need to travel back.

Before patching, be able to finish this sentence: *"The test fails because X, and X is caused by Y
at file:line."* If you cannot, keep reading.

## Step 3 — Patch minimally

- One root cause per patch.
- Change the smallest number of lines that fixes the cause you named.
- Match the surrounding code — its naming, its error handling, its idiom.
- Do not reformat, rename, or tidy anything you were not asked to touch.

## Step 4 — Verify, in this order

1. The originally failing test.
2. The file or module it lives in.
3. The full suite, if it runs in reasonable time.

Save the output to `/work/evidence/after.txt`.

If the suite surfaces a *different* failure that your patch caused, that patch is wrong. Revert and
go back to step 2. If it surfaces a failure that was already broken before your change, say so
explicitly and quote the baseline.

## Step 5 — Report the evidence

The report is the deliverable. It contains, always:

- the diff
- the exact command you ran
- the relevant lines of `before.txt` and `after.txt`
- one sentence naming the root cause
- anything still red, stated plainly

Render it with generative UI when the comparison benefits from structure.

Never write "should now work", "this fixes it", or "the tests pass" unless the passing output is
in front of you and quoted.

## Step 6 — Ask before publishing

Pushing a branch, opening a pull request, and commenting are all real, externally visible actions.
Say what you are about to do and why the evidence supports it, then wait for approval.

## Rules that do not bend

1. Never edit a test to make it pass. If the test is genuinely wrong, stop and ask the user - that
   is a decision about intended behavior, and it is not yours to make.
2. Never skip, xfail, or comment out a failing assertion.
3. Never report a run you did not perform.
4. If you are stuck, say you are stuck and show the last thing you tried. A truthful dead end is
   worth more than a confident guess.
