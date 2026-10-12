# Post-mortem: cross-provider smoketest (agy + codex), 2026-10-11

Branch at test time: `forge-pane-live-view` @ `53c282d`. Driver: Claude Code (Opus 5.5) using the agent-smith MCP tools.

## 1. What was run

| # | Path exercised | Provider / model | Outcome |
|---|---|---|---|
| A | `run_pipeline`: implement → review, `workDir` = scratch repo, 2 blocking checks on implement | agy `gemini-3.8-flash` → codex `gpt-6.1-sol` | Passed in ~2.5 min. Checks re-run by hand: pass. Run `1791740984913-83a3c1eff7` |
| B | `spawn_job` review of `the-codes/forge/checks.ts` | codex `gpt-6.1-sol` low | Succeeded in 43 s, 4 tool calls, `-s read-only` enforced, no files changed. Job `review-smith-c70c7907` |
| C | `spawn_job` review: explain the `resume_job` gates | agy `gemini-3.8-flash` low | Succeeded in 2.7 min, 7 tool calls. Answer checked against `tools.ts:237-247` and accurate. Job `review-smith-77ca7486` |
| D | `resume_job` by worker **name** on B | codex | Kept its conversation and produced a patch for its own finding. Job `review-smith-d7dc465e` |
| E | Completion hook notifications | all | Every job and the pipeline announced its completion; no polling was needed |

Not covered: opencode, the claude provider, `cancel`, timeouts, concurrency limits.

**What works well:** routing, model resolution (`modelRequested` = `modelResolved`), codex sandboxing, resume by name, pipeline artifact hand-off (`consumes` / `result.md`), executable acceptance checks (verdicts carry exit code, tails, duration), and per-stage observations in `pipeline_status`.

## 2. Accepted / not a defect

- **agy has no read-only enforcement in review/moderate modes.** The owner accepts this: headless agy needs broad permissions even to read (it cannot run git otherwise). Make sure the docs say so plainly. Note that the `forge-probe` job (2026-10-07) found that `docs/ARCHITECTURE.md` and `docs/CONFIGURATION.md` disagreed about the agy `unrestricted` default; confirm that drift is gone.

## 3. Findings (all confirmed by the owner as real unless marked)

### P1: /forge pane shows stale failures as "need attention" forever
- Screenshot: `Forge · 2 active · 9 need attention`. The Active tab is filled with `failed · unchecked` rows dated 2026-10-07 (four days old).
- Cause: `surfaces/mod/hooks/dashboard.ts:5-10`. `needsAttention()` is true for **any** `failed` job, and `activeJob()` puts every such job on the Active tab, with no age limit or acknowledgement. The only way out is `c` (Clear finished), and hotkeys don't work (see P1-keys).
- Fix direction: failures stay in "attention" until acknowledged **or** for a time window (for example, the current session or 24 h), then drop to History. Acknowledging should persist.

### P1: "failed · unchecked" is noise
- `workerStatus()` (`dashboard.ts:~29`) appends `acceptanceLabel` to every terminal job. `unchecked` on a failed job without checks adds nothing and reads like a second failure.
- Fix direction: show the acceptance label only when checks were configured (`acceptance.checks.length > 0` or `pending`). For failed jobs, show the failure reason/code instead (for example `failed · orphaned`, `failed · timeout`, `failed · denied`).

### ~~P1: surfaces disagree about orphaned jobs (`/forge` says "3 running")~~ (misdiagnosed)
> **Correction (PR #2 review):** the `3 running ∙ 9 failed ∙ 15 finished` header was accurate when it was captured (about 17:50 UTC, while three smoke jobs were running). The four orphans already had `orphaned` markers and showed as failed. The orphan reconciliation built in response is still useful for jobs that record an owner PID, but this symptom was not a bug. See `2026-10-11-pr2-review-and-proposals.md`.

- `/forge` printed `3 running ∙ 9 failed ∙ 15 finished` while nothing was running.
- On disk, four jobs from 2026-10-07 still have `"status": "running"` in `job.json` (`implement-smith-414ffe18`, `review-smith-44a264f7`, `review-smith-ba108912`, `review-smith-da8b323f`). Their supervisors died.
- The MCP `list_jobs` overlays these as `failed` ("supervisor process exited before the job finished (orphaned)"). The mod pane reads raw state, and `countSummary()` (`hooks/format.ts:~697`) counts `running`/`attention` as running. Result: header, roster and MCP all disagree.
- Fix direction: (a) when a job is detected as orphaned, **persist** `failed` + reason back to `job.json` (one writer, no surface-side reinterpretation); (b) the mod uses the same liveness verdict as the service. Add a test: an orphaned job reads identically from `list_jobs`, the roster and the header.

### P1: hotkeys don't work in the /forge pane (needs investigation)
- The footer advertises `a/h/1-9/n/c/e/x/u`, but pressing them does nothing for the user.
- Hotkeys are `<Button hotkey>` props (`hooks/views.tsx:40-55`). The README (`surfaces/mod/README.md:127-140`) says focus first needs **Ctrl+X then Tab**, but the pane never shows that, so typed letters go to the prompt.
- Investigate both: (1) whether hotkeys work at all once focused (reproduce in the host and add an engine test in `tests/engine/band.engine.test.tsx` that sends a key after focusing); (2) if they do, make focus discoverable (for example, footer hint `ctrl+x tab: focus`, or show hotkey labels dimmed and an explicit "unfocused" state).

### P2: running timers show `0s`
- Screenshot 2: both running rows show `0s` while the jobs had been running 1–2 min.
- `statusLine()` computes `(endedAt ?? now) - startedAt`. `now` is an atom seeded at start and ticked by `BAND_TICK_MS` only while `visible || paneOpen || expanded` (`register.tsx:286-296`). Suspect the tick condition is false for the expanded `/forge` view, or `startedAt` is not set for running jobs (`job.json` had `startedAt: null` while running; see P2-live). Orphaned failed rows also show `0s` because `finishedAt` is null.

### P2: live status is blind while a job runs
- `status.toolCalls` is 0 for every running job; it is only persisted at finish (`forge/writer.ts:449`).
- `currentActivity` is always null for agy: agy emits `activity-start` and `activity-end` with the same timestamp after the step completes, and `toSummary()` (`forge/service.ts:887`) only surfaces activities still `active`.
- `job.json` `startedAt` stayed `null` while running (the service overlay shows a value).
- Effect: a healthy agy job looked hung for minutes (12 tool steps in `events.jsonl`, status said 0).
- Fix direction: persist `toolCalls` and `lastActivity` into progress on each event, and expose `lastActivity` (most recent, even if done) alongside `currentActivity`.

### P2: `spawn_job` has no working-directory parameter
- `forge/service.ts:456`: `cwd = request.cwd ?? this.repo`. The MCP schema doesn't expose `cwd`, so solo jobs always run in the agent-smith repo. Only `run_pipeline` accepts `workDir`.
- Fix: add `cwd` (validated, absolute, exists) to the `spawn_job` and `resume_job` schemas.

### P2: pipeline artifact directories aren't pre-created, and they live in the host repo
- Both stages had to `mkdir -p .agent-smith/pipelines/<run>/artifacts/<stage>` themselves; codex's first write failed. `pipeline/pipeline.ts` should create the directory before spawning.
- Because the artifact path sits inside the agent-smith repo (not `workDir`), agy then grepped the agent-smith repo for `parse_duration`/`smoke` and ran `git log -p` there: scope leakage triggered by the path in the prompt. Consider placing stage artifacts under `workDir/.agent-smith/...`, or passing them as a separate, clearly labelled output path.

### P2: acceptance-check correctness (codex finding, plausible, not executed by hand)
In `forge/checks.ts` `evaluateAcceptance()`:
1. A `blocking: false` check that fails preflight (missing cwd, spawn failure) comes back `blocking: true` and rejects the job. Runner preflight defaults to blocking (`verify/runner.ts:~225`).
2. A check with an empty or whitespace command yields `accepted` (runner marks it non-blocking and incomplete; `report.incomplete` is ignored).
3. `timedOut`, `signal`, `skipped` and `reason` are dropped from the persisted verdicts, so a timeout can't be told apart from a crash.
- Codex's proposed fix for (1) is in job `review-smith-d7dc465e`. Write failing tests first.

### P3: completion notices look like errors and are cut off mid-sentence
- Notices arrive through a hook as `Stop hook blocking error from command "PostToolUse:…spawn_job"`, and the transcript shows `● Stop hook feedback`. To the user this reads as a failure.
- The worker text is cut mid-word (`…Preserve t /forge or status to inspect.`). Truncate on a sentence or word boundary, and lead with status: `✓ smoke-codex-solo (codex review) succeeded · 43s · 0 files changed`.

### P3: failure classification too strict or too loose
- `review-smith-69b59be4` / `7a0307b7`: asked "Reply with one word: ready", replied `ready`, recorded **failed** ("no usable output"). The usable-output heuristic penalises correct short answers. Base the judgment on whether the worker produced any final message, not on its length.
- `smoke-review` (claude, 2026-10-07) gave a correct, complete answer but was recorded **failed** because one Bash call was denied. A denied tool in a read-only review should be a warning, not a failure, when a substantive answer exists.
- Codex `failed to refresh available models: request timed out` stderr lines appear as `tool_error` warnings on successful jobs. Classify known benign stderr as info.

### P3: test runs pollute the real job store (owner to confirm)
- Many jobs with `task: "x"`, 3383 ms budgets and canceled-by-operator states sit in the real `.agent-smith/jobs`. They look like e2e/dev runs against the real repo. Check that `forge/__tests__/e2e.test.ts` always uses a temp repo root, and add a guard (for example `AGENT_SMITH_HOME`) so tests can't write to the user's store. These ghosts feed P1.

## 4. Suggested improvements (beyond the fixes)

1. **One state machine, one writer.** Most pane bugs come from surfaces re-deriving status from raw files. Make the service the only producer of the job status (including orphan and stall verdicts) and have the mod read that projection.
2. **Attention inbox semantics.** Failures need explicit acknowledgement (per job, persisted) and auto-expire to History after the session.
3. **Focus affordance.** The pane should always show how to focus it and whether it currently has focus.
4. **`spawn_job` parity with stages:** `cwd`, `resultPath`, `consumes`.
5. **Live counters:** tool calls, last activity and elapsed time should update while running for every provider; add a fake-agy event stream test.
6. **Notice format:** status-first, word-boundary truncation, no "error" framing.
7. **Housekeeping command:** `agent-smith gc` or a pane action to archive or prune jobs older than N days and mark orphans.
8. **Smoke suite as a script:** turn this test (pipeline + solo review per provider + resume + checks) into `scripts/smoke.sh` with a scratch repo, so it can be re-run after each change.

## 5. Handover prompt

> You are working in `/Users/gathrid/Repos/agent-smith` on branch `forge-pane-live-view`. Read `docs/postmortems/2026-10-11-cross-provider-smoketest.md` in full. For each finding in section 3, in priority order (P1 → P3):
>
> 1. **Reproduce or confirm** it from the cited file:line and the on-disk evidence (`.agent-smith/jobs/*`, `.agent-smith/pipelines/1791740984913-83a3c1eff7.json`). If you can't reproduce a finding, say so with evidence and move on. Don't fix what you couldn't confirm.
> 2. **Write a failing test first** (`node --test` suites under `the-codes/**/__tests__` / `surfaces/mod/tests`; engine tests for pane behaviour).
> 3. **Make the minimal fix.** Prefer making the service the single source of job status over patching each surface.
> 4. Run the full test suite and the type check. Report each finding as fixed / not reproduced / deferred, with test names and file:line references.
>
> Constraints: do **not** add read-only enforcement for agy (accepted by the owner). Don't delete anything under `.agent-smith/jobs`; to clean up, propose a command. The hotkey issue (P1) needs a host reproduction: if you can't drive the TUI, write the engine test and describe the manual steps for the owner. Don't commit; leave changes in the working tree and summarise the diff.
