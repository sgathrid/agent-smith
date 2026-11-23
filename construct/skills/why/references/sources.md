# History sources

One section per kind of source. Search a kind only when it is connected in this session, and record the kind either way: searched with findings, searched and empty (say what you searched), or not connected. Seed every query with the code anchor: hashes, review numbers, ticket ids, symbol names, literals, error strings, and the date window around when the code landed.

## Version history and code review

The only source every repo has, and the one tied most closely to the code. It shows the implementation-time reasoning: what the author said in the commit and review description, which alternatives reviewers pushed for, which files changed together, and which tests arrived with the change.

- Blame the target lines, then read the full diff of each substantive commit (with git, for example: `git blame -L`, `git show`).
- Find the commit that introduced an exact literal or condition with a pickaxe search (`git log -S '<literal>'` or `-G '<regex>'`), and follow the file through renames (`git log --follow`).
- Open the review linked from each commit (the forge's CLI, if one is set up) and read the description, review comments and linked tickets. Review threads hold most of the real signal.
- Search the repo for decision records, changelogs and TODO or FIXME notes near the target.

Squash merges erase branch history; fall back to the review description. A revert followed by a re-apply usually marks a lesson worth reading.

## Issue tracker

The product or business forcing function: the customer request, the bug report, the deadline or the compliance item that made the work happen. Strongest when the reason sits outside engineering.

- Open every ticket id found in commits and reviews, including comments and linked tickets.
- Search by symbol, feature name, or error string within the date window.
- Look for tickets labeled as incidents, regressions or follow-ups that touch the same area.

## Long-form docs and decision logs

Design rationale written down before it became code: design docs, decision records, specs, RFCs, onboarding pages. This is where rejected alternatives are most often listed.

- Search by feature name, subsystem name and the key symbol.
- Search for "decision", "alternatives", "proposal" plus the feature name.
- Check docs linked from the review or ticket, and their revision history if the tool keeps one.

Docs go stale. Compare the doc's date with the code's; a doc that predates a rewrite describes the old design.

## Team chat

Live deliberation that never reached a doc or ticket: the quick call made in a thread, the outage channel, the "why don't we just" exchange. Most valuable when the written trail is thin.

- Search the review number, ticket id or commit hash; people paste links when they discuss a change.
- Search the error string or symbol within a week or two of the commit date.
- Search incident or on-call channels around the landing date of defensive code.

Chat is informal. Quote the message and its date; one person's opinion in a thread is weaker than a decision recorded in review.

## Runtime telemetry

The infrastructure and runtime reality that motivated the code: latency, saturation, timeouts, error rates, deploy markers. Strongest for timeouts, retries, rate limits, pool sizes and circuit breakers.

- Look up the metric, monitor or alert that names the service or endpoint, around the commit date.
- Compare the signal before and after the change shipped.
- Find monitors or dashboards created as incident follow-ups.

A drop after a deploy is circumstantial support. Other changes ship at the same time.

## Error tracking

The specific exceptions and stack traces that motivated defensive or corrective code. Strongest for catch blocks, null guards, type checks and fallbacks.

- Search issues whose stack traces pass through the target file or function.
- Check first-seen and last-seen dates against when the target code landed.
- Search the exact exception message the code guards against.

## Analytics warehouse

Product and data reality: usage, experiment results, adoption, distributions. Strongest for flag-gated code, experiment-driven changes, data migrations, and "where did this number come from".

- Query the event or table behind the feature flag or experiment named in the code.
- Look at the distribution of the value a threshold applies to; a threshold often sits at a percentile.
- Compare an error or retry event count before and after the change.

Say how you computed a number. A query result without the query is a claim.

## Incidents and postmortems

A cross-cutting angle, used when the target looks defensive: retries, timeouts, null checks, rate limits, feature flags, guards around outside systems. Incidents are a common origin of such code.

- Search every connected kind above for incident and postmortem records that mention the target, its feature or its error string.
- Read the postmortem's action items; they often name the exact change.
- In history, look for "fix for incident", "add guard", or a revert followed by a re-apply.

Corroboration across kinds (an incident id appearing in a ticket, a review and a chat thread) makes the evidence strong. Skip this angle for code that does not look defensive.
