---
name: metric-correlation
description: How to turn a step change in a time series into a named cause without guessing - finding a control, checking whether the metric moved before the suspect did, refusing the second explanation that also fits, and knowing which artefacts of your own query can move a regression onto the wrong minute. Use when correlating a metric with a deploy or a config change, when a graph steps and something shipped nearby, or before writing "caused by" about anything you read off a chart.
---

# Metric correlation

`incident-triage` tells you to correlate and to say which you have. This is how you do the
correlating without being wrong, and it is a different skill: everything below is a way of arriving
at a confident number that is false, by a method that looked careful at every step.

A step change is not a cause. It is a fact with several parents, and the work is eliminating all but
one of them.

## The three checks, before you write "caused by"

### 1. Find a control

A control is **a series that would have moved too if your explanation were right, and did not.**

Without one you have a coincidence you have grown fond of. With one you have an argument.

> checkout-api's p99 stepped from 305ms to 2000ms at 13:59. Deploy 4c21 shipped at 13:58 and cut
> the payment-gateway client timeout to 2000ms.
>
> **Control:** if the gateway had got slower, the gateway's own p99 would have moved. It is flat at
> 2400ms across the whole window - identical minimum and maximum on both sides of 13:58 - and it is
> not firing on its own 3000ms rule. So the upstream did not change; the deadline did.

The control is almost always the thing you were about to blame instead. Query it over the same
window and on both sides of the suspect. If you cannot find any series that would separate your two
explanations, say so: "these two are indistinguishable from here, and what would separate them
is X" is a real finding and a better one than picking.

### 2. Check whether the metric moved before the suspect did

Query a window that starts **well before** the alert, not one centred on it. Three different shapes
come back and they mean different things:

| What the series does | What it means |
| --- | --- |
| Flat, then a step at the suspect's timestamp | consistent with the suspect |
| Already climbing before the suspect | the suspect landed on an existing problem, and rolling it back changes nothing |
| Steps at a time nothing shipped | your suspect is not on this timeline; look for one that is |

The second row is the expensive one, because the first four reads look identical in both cases. An
error rate that had been rising for an hour before a deploy is not a regression that deploy caused,
and a rollback proposed on it is a change made to production for nothing.

### 3. Check the suspect's own timeline

Run the check the other way as well: **did the thing you are blaming arrive before the effect, and
did nothing happen in between?**

> Request rate rose 42% starting at 13:30, and peaked during the incident. "We got busy" fits every
> number after 14:00.
>
> But the traffic reached its new level at 13:44 and the latency did not move until 13:58. Fourteen
> minutes at the full new rate with p99 flat at 305ms. **A cause that arrives twenty-eight minutes
> before its effect and does nothing in between is not the cause.**

A gap between suspect and effect is only forgivable when you can name the mechanism that delays it -
a queue filling, a cache expiring, a disk approaching full. Name it, or drop the suspect.

## The second explanation

Assume there is one, because there usually is, and the two typically want **opposite actions**:

| Explanation | What it asks for |
| --- | --- |
| the dependency got slower | escalate to whoever owns it; a rollback fixes nothing |
| the deadline was cut below what the dependency has always taken | roll back |

Both are consistent with every number read *after* the incident starts. Only the window *before* it
separates them, and an investigation that begins at the alert never opens that window.

Write both down. Then say what you did to eliminate one. If you eliminated nothing, you have two
hypotheses, which is an honest deliverable.

**The mechanism test.** When you can find one, a mechanism beats a correlation outright:

> checkout-api's p99 after the deploy is about 2000ms. Its dependency's is about 2400ms. **A
> synchronous caller cannot be faster than the thing it waits for.** It is not faster; it stopped
> waiting. That is what a 2000ms deadline against a 2400ms upstream does.

That sentence is not "consistent with 4c21". It is "this is what 4c21 does". Look for one before
you settle for consistency.

## The artefacts of your own query

These have nothing to do with the data. They are ways the *question* produces a wrong answer, and
they are the ones nobody checks.

**A coarse step moves a step change earlier.** Each bucket carries the maximum of the minutes inside
it, so a bucket containing the first bad minute is a bad bucket, and it is stamped with its own
start time. At a 60s scrape interval the regression starts at 13:59, one minute after the deploy. At
`step_s: 300` it starts at 13:55, *three minutes before* the deploy that caused it - and an
investigation reading only that rules the deploy out. **Query at the scrape interval before you name
a minute.**

**Percentiles do not average.** The p99 of two minutes joined is not the mean of the two p99s; the
underlying latencies are gone. Averaging turns `[305, 1980]` into 1142, which looks like a slow
service rather than a broken one. A store worth using downsamples percentiles by maximum and tells
you it did. If a reply does not say which aggregation it used, do not quote a downsampled number.

**A window wider than the retention is not a longer history.** The series begins where the store
does, and that reads exactly like a metric that was flat before then. Check for a truncation flag
before you call anything a baseline. The missing span is not flat and it is not zero.

**A log line's timestamp is when somebody looked, not when the thing changed.** A line reading
"cache hit rate 71%, below the 80% target" at 14:05 puts the degradation in the middle of your
incident. The series may well say it dropped at 13:20, forty minutes earlier and flat across your
deploy. Only a metric can date a change; a log can only date an observation of it.

**The nearest annotation is not the cause.** Alerts fire *after* causes - a rule with a five-minute
`for` window fires five minutes late by design - so the marker closest to the alert is often a
*reaction* to the incident. An autoscaler firing three minutes after the alert did not cause it.
Sort annotations by their distance from the **step change**, never from the alert, and only consider
the ones that precede it.

## What to write

Say your confidence as confidence, and make the sentence carry its own evidence:

> The p99 stepped from 305ms to 2000ms between 13:58 and 14:00, measured at the 60s scrape interval.
> Deploy 4c21 shipped at 13:58 and cut the payment-gateway client timeout from 5000ms to 2000ms. The
> gateway's own p99 is flat at 2400ms on both sides of that and is inside its own objective, so the
> upstream did not change. Checkout's p99 is now *below* its dependency's, which a synchronous caller
> cannot be unless it stopped waiting. Traffic rose at 13:30 and the latency did not move for another
> twenty-eight minutes, so load is ruled out. **Confirmed by mechanism, not only by correlation.**

Never write "caused by" when you mean "shipped four minutes earlier". The person on call is going to
make a decision on your sentence.

## Verifying a recovery is the same discipline, pointed forwards

"It recovered" is a claim about a time series and is checked the same way anything else is.

1. Compare a window from **after** the remediation against a baseline from **before the incident**,
   not against the incident itself. Against the incident, anything is an improvement.
2. Both windows have to be fully covered by the store. A mean over a window missing half its minutes
   is the mean of the half that was kept, and nothing in the number says which half.
3. A comparison window with **no readings in it** is the normal answer immediately after a
   remediation, because a metric store has nothing after its last scrape. That is a fact about the
   evidence. It is not a result you may round up to recovery.

You may say what you expect and why - "restoring the 5000ms budget puts the gateway's measured
2400ms back inside it" - as long as you say it is an expectation. An expectation and an observation
are different sentences, and only one of them justifies resolving an alert.

## What you never do

- **Never name a cause without a control.** If nothing would have moved differently under the other
  explanation, you have not eliminated it.
- **Never correlate against the alert's timestamp.** Correlate against the step change. The alert is
  late by however long the rule's `for` window is.
- **Never quote a downsampled percentile** as though it were a measurement, or a number from a
  truncated window as though it were a baseline.
- **Never report a recovery you did not read.** The store having no data yet is the answer, and it
  is a publishable one.
