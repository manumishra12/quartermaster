---
name: evidence-report
description: How to render the final verdict of a fix as an interactive evidence card - verdict banner, root cause, diff, and the before/after test runs side by side. Use when reporting the outcome of a fix, a reproduction, or any run whose result the user has to judge.
---

# Evidence report

The report is the product. A paragraph saying "the tests pass now" is exactly the claim this agent
exists to replace, so the final answer renders as a card the user can read at a glance and inspect
in detail.

Render it with Generative UI, in an `openui` fenced block.

## The rules that silently break it

1. Every statement on its own line: `identifier = Expression`.
2. `root` is the entry point. Every program defines `root = Stack(...)`.
3. Arguments are **positional**. `Stack([kids], "column", "m")` — never `Stack([kids], direction: "row")`.
   Colon syntax is not supported and fails quietly.
4. Every variable except `root` must be referenced by another variable. An unreferenced variable is
   dropped silently and never renders.
5. Strings are double-quoted, with backslash escaping.

## The card

```openui
verdict = Callout("success", "Verified", "5 passed, 0 failed - re-run after the patch")
cause = CardHeader("split_evenly dropped the remainder cents", "ledger/money.py:16")
diff = CodeBlock("diff", "-    share = total_cents // parties\n-    return [share] * parties\n+    share, remainder = divmod(total_cents, parties)\n+    return [share + 1] * remainder + [share] * (parties - remainder)")
beforeRun = CodeBlock("text", "FAILED test_split_is_a_partition_of_the_total\nAssertionError: 999 != 1000\nRan 5 tests - FAILED (failures=1)")
afterRun = CodeBlock("text", "Ran 5 tests in 0.001s\n\nOK")
beforeTab = TabItem("before", "Before - 1 failed", [beforeRun])
afterTab = TabItem("after", "After - 5 passed", [afterRun])
runs = Tabs([beforeTab, afterTab])
command = TextContent("`python3 -m unittest discover -s .` in the sandbox", "small")
root = Stack([verdict, cause, diff, runs, command], "column", "m")
```

Five parts, always, in this order:

| Part | Component | Carries |
| --- | --- | --- |
| verdict | `Callout` | did it pass, in one line |
| root cause | `CardHeader` | one sentence, plus `file:line` |
| the change | `CodeBlock("diff", ...)` | the actual diff, not a description of it |
| the proof | `Tabs` of two `CodeBlock`s | real captured output, before and after |
| the command | `TextContent` | exactly what was run, so it can be repeated |

## The verdict banner is not decoration

Pick the variant from what actually happened, never from what was intended:

- `Callout("success", ...)` — only when the re-run passed and you have its output. Never otherwise.
- `Callout("error", ...)` — the patch did not fix it, or broke something else. Say which test.
- `Callout("warning", ...)` — it passes but something is unresolved: a pre-existing failure elsewhere,
  a test you could not run, a fix you are not confident in.
- `Callout("info", ...)` — you did not get as far as a fix. Reproduction only.

A green banner over a run that was not performed is the exact failure this agent was built to
prevent. If you are tempted to render one, you are not finished - go run the test.

## When to skip the card

Short factual answers, a single command's output, or a question about the code. Markdown is enough.
The card is for a verdict someone has to act on.
