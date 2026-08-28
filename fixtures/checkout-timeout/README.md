# checkout-timeout (fixture)

A reproduction of `ALRT-4471` for the incident responder to run in its sandbox. Standard library
only - no install step, no network, nothing left behind.

```bash
python3 repro.py --deploy 4c21     # what production is running: times out, exits 1
python3 repro.py --deploy 9ab7     # what a rollback returns to: succeeds, exits 0
python3 repro.py --both            # both, and checks the pair still holds
```

**It is not a broken repository.** `ledger` and `retry` are code Quartermaster is pointed at to fix.
Nothing here is wrong and there is nothing to patch. This is the step between "the deploy
correlates" and "roll it back": a stub payment gateway that takes the 2.4 seconds the real one has
always taken, called with the client timeout each deploy configured.

## Why the pair, and not the failure

A run that fails proves a failure. Only a run that fails in one configuration and passes in the
other says which of the things that changed was the cause - and this incident has two explanations
that fit the metrics equally well:

| Explanation | What it asks for |
| --- | --- |
| the payment gateway got slower | escalate to whoever owns it; rolling back `4c21` fixes nothing |
| the timeout was cut below what the gateway takes | roll back `4c21` |

This holds the gateway still at 2400ms so that only the budget moves. That is the same 2400ms the
`checkout-api` log lines report on both sides of 13:58, and the same 2000ms carried by the alert's
sample error, by deploy `4c21`'s summary, and by every `UpstreamTimeout` line `search_logs` returns.
Edit one of those numbers and the rest have to move with it, or the correlation this whole
demonstration rests on quietly stops being true.

## Getting it into a sandbox

Nothing mounts this repository into the agent's sandbox. It is one file with no imports outside the
standard library for exactly that reason - it goes in as a heredoc, the way `analytics` writes SQL:

```bash
cat > repro.py <<'PY'
# the contents of repro.py, unchanged
PY
python3 repro.py --deploy 4c21
```

If it is not there, what you have is a reproduction that did not run, not an incident that could not
be reproduced. Those are different findings, and the responder is required to say which one it has.

## Determinism

`time.sleep` does not return early, so the 2000ms budget is always exceeded and the `4c21` run
cannot pass by accident. The other direction has 2.6 seconds of slack; if it ever runs out, that is
a loaded machine rather than a finding, and `--both` says so in those words instead of reporting a
cause that moved.

`npm run fixtures:check` runs `--both`, so a fixture that stops failing on `4c21` - or stops
recovering on `9ab7` - fails the build rather than the demo.
