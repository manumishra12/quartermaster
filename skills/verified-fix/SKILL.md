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

Four outcomes:
- **It fails as described** — good, but run it twice more before you touch anything. A test that
  fails only sometimes is not a bug you can patch: you will change something, it will pass by luck,
  and the green run will be reported as proof. If it is not deterministic, say so and stop.
- **It passes** — stop. Report that it passes and show the output. Do not go looking for something
  else to fix.
- **It errors before running** — an import error, a missing fixture, a syntax error in the test
  file. That is the real bug; fix it and say so.
- **The project does not build at all** — dependencies will not resolve, the toolchain is missing,
  compilation fails for reasons unconnected to the named test. Report the build failure as the
  result and stop. Repairing someone's build is a different job with a different blast radius, and
  nobody asked you to do it.

A dependency change is never part of a fix. If the fix appears to need a version bump, a lockfile
edit, or a new package, propose it separately and stop - do not apply it, and never in the same
patch as a code change.

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
