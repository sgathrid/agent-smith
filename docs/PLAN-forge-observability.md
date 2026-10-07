# Plan: make workers observable, and fix what the smoketest found

Source: a smoketest on 2026-10-07 (codex write, agy write, claude review) plus the `/forge` pane screenshot.

## Postmortem

The mechanics worked. Both writers produced correct files, and the executable checks passed. The problems are about trust and visibility.

| # | Issue | Evidence | Severity |
|---|-------|----------|----------|
| 1 | `/forge` showed a one-line, truncated task and a 4-row tool list, so you could not see what a worker was doing. | Screenshot: "Create the file smoketest/agy.txt in the current re…". The full prompt was never persisted; only `promptChars` and a title were. | High |
| 2 | A read-only review is marked `failed` because one Bash call was denied. The review text itself was complete and correct. | `review-smith-eac3bac6`: status `failed`, report fine | High |
| 3 | `changedFiles` is attributed to every job that overlapped in time. | Both writers list both files | Medium |
| 4 | Acceptance state races: `status` said `accepted`, then the completion notice said `unchecked, pending`. | agy job, 10 s apart | Medium |
| 5 | `readOnlyEnforced: false` on a job requested as read-only. | review job JSON | Medium |
| 6 | Completion notices surface as "Stop hook blocking error". | every job | Low, but alarming |
| 7 | Two corpus tests fail on the base branch: `real corpus resolves: 20 jobs…` and `…tool count and activity clause`. | `npm test` on a clean stash | Low |

## Done in this change (issue 1)

- The mirror spec now stores the full prompt, capped at 64 KB.
- The `/forge` detail view renders:
  - the full prompt as Markdown;
  - the whole worker transcript (up to 200 chunks, up to 16 KB each);
  - up to 60 tool rows that wrap instead of truncating, with 600 characters of output each.
- Older jobs fall back to the one-line title.
- Tests: a prompt round-trip and cap test, and an updated history cap.
- The pane runs from the built plugin (`builds/local-plugin`), so rebuild and reload it to see the change.

## Status

Items 1-6 below are implemented in this change. Item 7 (live-tail follow mode, scroll persistence, raw-versus-preamble toggle) is left as follow-up work.

| # | Fix |
|---|-----|
| 1 | A denial no longer fails a job that delivered a report: `deriveStatus` returns `succeeded` with a `note` that surfaces as a warning. Read-only claude jobs get an inspection allowlist and a write-tool denylist. |
| 2 | `changedFiles` holds only paths the job's own tool inputs mention. Other changes go to `unattributedFiles`. |
| 3 | The watcher holds a terminal announcement while `acceptance.json` is `pending`, for at most 5 minutes. |
| 4 | claude reports `readOnlyEnforced: true` when it applies the allowlist and denylist. Other providers still report `false`. |
| 5 | Hook output ends with a line saying it is a job notification, not an error. The host's "Stop hook blocking error" label is the host's own and can't be changed from here. |
| 6 | The corpus tests now ignore agent-smith's own mirrored `-smith-` jobs, which had polluted the shared fixture directory. |

## Plan for the rest

1. **Review mode should not fail on a denied tool.** Mark the job `succeeded` with a `denied_tools` warning when a final report exists. Allow a read-only shell allowlist (`cat`, `xxd`, `wc`, `git diff/show/log`, `rg`) for review and moderate modes. Fix the warning text, which says "moderation" for every mode.
2. **Per-job file attribution.** Take a git baseline per job and attribute a file to a job only if the job's own tool events touched that path. Mark any other overlap `shared`.
3. **Make acceptance atomic.** Write `acceptance.json` before the terminal status is announced. Have the notifier read it, and hold the notice until checks have settled or `pending` has timed out.
4. **Enforce read-only.** Pass a real sandbox flag for review mode where the provider has one (codex `-s read-only`). Where it has none, report `readOnlyEnforced: false` as a warning rather than a silent field.
5. **Rename hook output.** Use a neutral notification type, not "Stop hook blocking error".
6. **Repair or delete the two corpus tests.** The corpus fixtures have drifted from the current job layout.
7. **Pane follow-ups.** A live tail (follow-mode) for running jobs, a scroll position that survives refresh, and a toggle between raw and prompt-with-preamble (the worker really receives "Do the work and report…" prepended).

## Pitch

Today, delegating to a worker feels like throwing a ball into the dark. You get a green tick and a summary, and the summary is the worker's own claim. This update makes `/forge` work like the native subagent view. You see the exact prompt, every tool call, and the live transcript. You then get a review verdict that does not cry wolf, with file attribution you can trust. The pane change is small, backward compatible and tested. The follow-ups are one-day fixes each, and together they turn Agent Smith from "it ran" into "I can see what it did".
