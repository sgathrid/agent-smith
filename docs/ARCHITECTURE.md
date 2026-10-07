# Agent Smith architecture

Agent Smith owns external harness execution. Claude drives it through MCP tools; the
CLI (`agent-smith run|resume|ls|status|cancel|doctor`) is a second adapter over the
same `ForgeService`. Knobs and tool parameters are in [CONFIGURATION.md](CONFIGURATION.md).

## Layers

```text
providers/  -> forge/ runtime -> surfaces/channel (MCP + hook watcher) -> surfaces/mod (pane)
 argv, NDJSON   job dir, status      8 tools, notifications              band, /forge
 model catalogs  derivation, DAG     (dist/server.js, monitor.js,        (read-only view)
                                      watch-hook.js)
```

| Layer | Owns |
|---|---|
| `providers/` | `agy`, `codex`, `opencode`, `claude` adapters: argv, process groups, timeouts, NDJSON-to-`ProviderEvent` translation, sandbox description, model discovery (`listModels`) and harness-config defaults (`harnessDefaults`), `models.json` aliases (`aliases.ts`), the lazy catalog cache (`catalog.ts`). |
| `forge/` | Job directory format and status rules (`format.ts`), the single-writer `JobWriter` (`writer.ts`), `ForgeService` (spawn/list/detail/cancel, `service.ts`), closed modes (`modes.ts`), executable acceptance (`checks.ts`), pipeline runner and persistence (`runner.ts`, `execute.ts`), compat mirror (`mirror.ts`). |
| `pipeline/` | DAG validation, bounded scheduling (1-32), failure propagation, routing/escalation. Does not interpret prose. |
| `verify/` | Runs acceptance commands against the real working tree; exit codes decide, not worker text. |
| `harness/` | Readers. `AgentSmithReader` (primary, `.agent-smith/jobs`) and `AgyStaffReader` (read-only interop for `.agy-staff/jobs`). Readers derive the final status (orphan/cancel rules below). |
| `surfaces/channel/` | MCP server (`server.ts`, `tools.ts`), optional channel push (`poller.ts`, `policy.ts`, `watch-source.ts`), job-scoped hook watcher (`watch-hook.ts`) and CLI monitor (`monitor.ts`). |
| `surfaces/mod/` | Claude Code mod: band, `/forge` pane, native task-list projection. A UI projection, not an execution runtime. It cannot import outside its plugin folder, so it restates the reader rules and reads the compat mirror (`hooks/jobs.ts`) plus `.agent-smith/jobs/<id>/orphaned` (`hooks/native.ts`). |
| `cli/` | Argument parsing and detached supervisor (`supervise`), same forge APIs. |
| `core/` | Legacy SQLite library; not the execution store. |

`.agy-staff/jobs/` is a one-way projection (`forge/mirror.ts`, default on) written so the
unmodified mod can render forge jobs. Nothing reads it for a verdict: `AgentSmithReader`
claims forge ids (`<mode>-smith-<8 hex>`, `isForgeJobId`), and the interop reader skips them.
Genuine agy-staff jobs remain visible read-only via `list_jobs provider=agy-staff|all`.

## Job lifecycle and on-disk layout

State lives in `<repo>/.agent-smith/jobs/<jobId>/` (gitignored). `FILES` in `forge/format.ts`:

| File | Writer | Meaning |
|---|---|---|
| `job.json` | `JobWriter`, atomic whole-file rewrite | The anchor and only mandatory file. Schema v1 manifest: identity, provider/mode/model (requested, resolved, source), sandbox, status, timestamps, `ownerPid`, `exitCode`, `error`, `deniedActions`, `usage`, `gitBaseline`, `changedFiles`. Never deleted. A reader refuses a manifest with a higher `schema`. Holds `task` (first prompt line, 200 chars), not the full prompt. |
| `progress.json` | `JobWriter`, coalesced to `PROGRESS_FLUSH_MS` = 250 ms | Advisory liveness: `lastEventAt`, recent activities, `latestText`, `latestSummary` (source `worker`), warnings. |
| `events.jsonl` | `providers/ndjson.ts` | Normalized `ProviderEvent` stream. |
| `argv.json` | `providers/ndjson.ts` | Exact argv and cwd. |
| `stderr.log` | `providers/ndjson.ts` | Child stderr, verbatim. |
| `result.json` | `providers/ndjson.ts` | Verbatim adapter `JobResult`, written once at completion. Its presence stops orphan derivation. |
| `result.md` | `JobWriter` | The report (worker output). May be absent/empty for a denied job. |
| `cancel` | `ForgeService.cancel` | Marker holding the ISO instant of the request. It is a request, not a verdict. |
| `orphaned` | first reader that proves the owner dead | Marker so readers that cannot probe a pid agree. Never edits `job.json`. |
| `acceptance.json` | `forge/checks.ts` (only when `spawn_job` got `checks`) | Sidecar, see Acceptance. Not in `FILES`. |

Pipeline runs sit beside jobs, not inside them: `.agent-smith/pipelines/<runId>.json`
(`PipelineRecord`: `running|passed|partial|failed`, per-stage results), `<runId>.cancel`
(marker, polled every 250 ms by the owner), and `<runId>/artifacts/<stage>/<resultPath, default result.md>`
(handoff artifacts scoped per run and stage; worker cwd stays the source checkout, so this
is not source isolation).

`spawn_job` flow: validate (closed mode for non-pipeline fresh spawns, nonempty prompt,
timeout clamp, catalog check, identity conflicts) -> `JobWriter.start` writes `job.json`
(with `ownerPid = process.pid`) and `progress.json` -> return the `SpawnAck` -> a detached
`pump` spawns the provider with `stateDir` = the job directory, pipes events into the
writer, polls for the `cancel` marker every 200 ms, awaits the result, then
`prepareFinish()` (changed files) and `finish()`. Any exit path ends in `finish` or
`abort`; spawn failures (missing binary, bad cwd) become `failed` jobs, not rejections.
Only a bad request (unknown provider, bad mode, empty prompt, duplicate active
name/workerId) rejects.

Identity: `workerId` is the logical worker across follow-ups, `name` the label, `role` the
mode. `resume_job` starts a new job id with the same `workerId`/`name` and the provider's
native `conversation` handle; it refuses running workers, missing handles, and ambiguous
names. No live steering.

## Status derivation

`deriveStatus` (`forge/format.ts`) is the one place a terminal verdict is computed.
Precedence: already terminal (a cancel verdict is final) > `deniedActions` non-empty =
`failed` + suspicious > `ok === false` = `failed` > `ok === true` with empty report
(`< 8` chars after trim, `MIN_USEFUL_CHARS`) = `failed` + suspicious > `ok === true` =
`succeeded` > no verdict = `running`. A job that exited 0 and delivered nothing is
failed, never a quiet success.

`AgentSmithReader.read` (`harness/agent-smith.ts`) then applies, only to a `running`
manifest with no `result.json`, not canceled:

- **Orphan** (`deriveOrphan`): with `ownerPid`, orphaned iff `kill(pid,0)` fails (`EPERM`
  counts as alive). Legacy manifests without `ownerPid` are orphaned only when the newest of
  `updatedAt`/`progress.lastEventAt`/`createdAt` is older than `LEGACY_ORPHAN_AFTER_MS` =
  2 x `DEFAULT_TIMEOUT_MS` = 90 minutes. Result: `failed`, suspicious, reason
  "supervisor process exited before the job finished (orphaned)". A best-effort `orphaned`
  marker is written; once present, readers keep reporting orphaned.
- **Stale cancel**: if no orphan verdict, a `cancel` marker older than 60 s and no live
  `ownerPid` (in practice a manifest without `ownerPid`, since a dead pid is already an
  orphan) reports `canceled` with reason "cancel requested and no supervisor confirmed it".
- A fresh `cancel` marker alone does not make a job canceled; only a terminal `canceled`
  manifest does. With a live owner, the owner's poll signals the worker's process group and
  records the result.

The channel adds `attention` (a `running` job whose `updatedAt` is older than
`STALL_GRACE_MS` = 15 min, or has none) in `watch-source.ts`; the mod shares that constant.

`nextActionFor` derives (never stores) an imperative for the orchestrator on
`failed`/`canceled` jobs: canceled -> nothing to do; orphaned -> `resume_job` if it has a
conversation handle else rerun; denied -> retry with `unrestricted:true` (or narrow the task
if it already was); timeout -> raise `timeoutMs`/split; network-ish error -> retry once;
empty output -> ask via `resume_job`; otherwise read `error` and `warnings`. `null` for
running/succeeded. Surfaced in `list_jobs` and `status`.

## Modes

`forge/modes.ts`: closed set `implement | review | moderate | verify`. A mode is a preset
of a prompt preamble plus a sandbox posture, nothing else; it never picks provider or model.
`review` and `moderate` are `readOnly` (requested; enforced only where the CLI can:
codex `-s read-only`; the ack's `readOnlyEnforced` says which); `implement` and `verify`
`runsCommands`. `readOnlyRequested = preset.readOnly && !unrestricted`. The preamble is
prepended unless the prompt already starts with it (`preambleApplied`). `agy` with a
command-running mode and `unrestricted:false` gets an ack warning: headless agy auto-denies
unapproved tools. Pipeline stages and resumes may keep arbitrary legacy roles.

## Model discovery and validation

`providers/catalog.ts`; lazy, nothing runs at startup or on the spawn path.

- `getCatalogs({providers?, refresh?, timeoutMs?})`: PATH-probes `available()` for each
  provider, fans out `listModels()` in parallel (10 s per provider, guard +1 s), never
  rejects. In-process cache per provider, `CATALOG_TTL_MS` = 5 min. A usable result
  (no error, or models present) is cached. If a refresh fails and an older entry exists, the
  old catalog is served with `stale: true` and the new `error`. A failure with no prior entry
  is returned uncached.
- Sources: `agy models` (base ids, `-low|-medium|-high` suffix stripped into efforts);
  `codex debug models`, falling back to `<codexHome>/models_cache.json` marked `stale`;
  `opencode models` (`verified: false`); `claude` static aliases `fable|opus|sonnet|haiku`
  (`source: 'static'`).
- Harness defaults (`harnessDefaults`, synchronous file read, no CLI): codex
  `<codexHome>/config.toml` top-level `model` and `model_reasoning_effort`; claude
  `<claudeHome>/settings.json` top-level `model`. agy and opencode have none.
- Spawn path: a catalog is consulted only if the request names `model` or `effort`, with a
  hard `CATALOG_WAIT_MS` = 2 s race; on timeout/error it is treated as absent. With no
  `model`, `modelResolved` comes from `harnessDefaults().model` (`modelSource`
  `harness-config`); a provider-reported model on the `started` event upgrades an unknown to
  `reported`. Effort defaults are not resolved at spawn.
- Validation (`checkAgainstCatalog`): only a **fresh** catalog (not stale, no error,
  `verified !== false`, `source !== 'static'`, models nonempty) can reject: unknown model ->
  error listing valid ids (agy also accepts `<base>-low|medium|high` when `<base>` exists);
  effort not in the model's nonempty `efforts` (model or catalog default) -> error. Stale,
  static (claude), unverified (opencode), empty or errored catalogs never reject; the ack
  gets "could not verify ... passing it through unchecked" in `warnings`.
- Alias resolution (`providers/aliases.ts`, `resolveRequest`), per call, `models.json` re-read
  each time: (1) `model` equals an alias name -> expand to alias provider/model (call `effort`
  wins over alias `effort`; a conflicting call `provider` throws; alias names that look like
  real model ids warn); (2) no `provider` and no `model` and the mode has a `roleDefaults`
  alias -> expand it; (3) otherwise pass the call values through. Catalog validation and
  harness-config model default then apply to the resolved values. Project aliases replace
  user aliases of the same name wholesale; project `roleDefaults` win per mode; a dangling
  `roleDefaults` target is dropped with an error. No built-in aliases. `run_pipeline`
  expands aliases in explicit stages (mode = `role ?? name`) and applies `roleDefaults` to
  default stages; `resume_job` expands aliases (provider fixed by the original job).
- Default pipeline (no `stages`): implement -> review -> moderate (moderate depends on
  both), provider per stage preferring agy/codex/claude among installed, else an unused or
  any installed one. Model/effort come from the provider's catalog default only when its
  `defaultSource` is `harness-config`.

## Acceptance

Job status says the harness ran, not that the task is done. `spawn_job` `checks` are run by
the MCP process after a job terminates (`gateAcceptance` -> `evaluateAcceptance`):
unsuccessful job -> `rejected` without running checks; no checks -> `unchecked`; all
blocking checks pass -> `accepted`; a blocking failure -> `rejected`. `blocking: false`
checks are recorded but never gate. A pending `{state:'unchecked', pending:true}` placeholder
is written at spawn; the real verdict replaces it atomically. Check output tails are capped
at 2000 chars; default per-check timeout 60 s; `cwd` resolves against the job's cwd.
`status` merges the sidecar (`unchecked` when absent or unreadable). The gate lives in the
MCP server process: if it exits before the job finishes, the placeholder stays. Pipeline
stages use the same rules (`StageResult.acceptance` `passed|failed|unchecked`, reported by
`pipeline_status`).

## Changed files

At `start`, `captureBaseline` (async, never blocks spawn, 2 s git cap) stores
`gitBaseline {head, dirty[]}` when cwd is a git repo. Before `finish`, `prepareFinish`
computes `changedFiles`: paths newly dirty, reverted/committed since, baseline-dirty files
whose content signature moved (first 500 sigs), and paths in commits since the baseline
HEAD; `.agent-smith/` and `.agy-staff/` excluded, sorted, capped at 200
(`changedFilesTruncated`). It is a worktree diff, not attribution: concurrent jobs in one
worktree can show each other's edits.

## Notifications

Design goals: nothing polls while idle, one notification path per session, state changes
only (never progress), all worker text treated as untrusted data.

```text
Claude                MCP server (dist/server.js)      Claude Code hooks           watch-hook.js
  | spawn_job(...)  ------>  validate, write job.json,
  |                          detach pump ----------------------------> provider CLI (events -> job dir)
  | <---- SpawnAck {jobId, dir, repo, notify{mode:'hook', monitorCommand?}} (ms)
  |
  |   PostToolUse(matcher: mcp__plugin_agent-smith_agent-smith__{spawn_job|resume_job|run_pipeline})
  |         hook stdin JSON {tool_name, tool_response, cwd} --------> parseHookInput -> {job|run, id, repo}
  |   (asyncRewake: Claude keeps working)                             runJobWatch: read job every 2 s,
  |                                                                   no baseline, buildBatch/dedupe
  |                                                                   (job done before start is reported)
  | <==== exit 2 + one stderr line "Agent Smith: <finished|failed|...>" ===== terminal state seen
  |   Claude wakes -> status(jobId) / pipeline_status -> acts on report + acceptance
```

- **Hook watcher** (`watch-hook.ts`): `build-plugin.mjs` generates `hooks/watch-hooks.json`
  (`PostToolUse`, `asyncRewake: true`, `timeout: 21900` s) running
  `runtime/dist/watch-hook.js`. `parseHookInput` strips the MCP prefix, unwraps the result
  (`structuredContent` or JSON text), takes `jobId` or `runId`, and resolves the repo from
  `payload.repo`, else `dir`/`recordPath`, else hook `cwd`, else `AGY_WATCH_CWD`, else
  `process.cwd()`. It watches that one job/run (a run also its stage jobs) in-process,
  prints the milestone line to stderr and exits 2. Any error or non-matching tool exits 0
  silently: a hook must never break the session. The hook passes `runJobWatch` a timeout of
  the job's own `timeoutMs` + 60 s (from the ack; pipelines get the 6 h cap + 60 s); standalone
  `monitor.js` defaults to `DEFAULT_WATCH_TIMEOUT_MS` = 46 min. On timeout it emits "still
  running; check status <ids>" (exit 2 from the hook).
- **Fallback**: acks carry `notify {mode:'hook', note, monitorCommand?, monitorTimeoutMs?}`;
  `monitorCommand` (only when running from the built `dist/`) is `node .../monitor.js
  --job <id>|--run <id> --cwd <repo>`, to run under Claude's Monitor tool
  (`monitorTimeoutMs` = min(job timeout, 30 min); re-arm on expiry). Or `status wait_ms`.
  `monitor.js` with no `--job/--run` is the legacy full-scan monitor (silent baseline,
  polls every 5 s); the plugin no longer registers it.
- **Why the always-on monitor was removed**: a `when: always` monitor polled every job dir
  every 5 s for the whole session and appeared in Claude's exit dialog. The hook is scoped
  to one job and gone when it finishes.
- **One path per session**: the plugin's MCP server is configured with
  `AGENT_SMITH_CHANNEL=0` (no `claude/channel` capability, no poll loop, no startup
  baseline), so the hook is the only notifier. The channel (`poller.ts`: 5 s poll, first
  poll is a silent baseline, per-job dedupe key `id#status#epoch`, one batched notification
  per tick, only `finished|failed|attention|cancelled`) runs only when the server starts
  without `AGENT_SMITH_CHANNEL=0`, e.g. `dev.sh --channels` (which loads the mod via
  `--plugin-dir`, hence no hook).
- **Unverified**: exit-dialog behavior of async hooks, hook timeout cap for 45-minute jobs,
  and wake while Claude is mid-turn.

## No long calls

Every tool answers fast so the MCP server and the session are never blocked by a
long-running job: `spawn_job`/`resume_job`/`run_pipeline` return once the anchor is on disk
(`run_pipeline` persists the run record first); discovery runs only on `list_capabilities` or when a
model/effort is named, bounded to 2 s on the spawn path; harness defaults are file reads, not
CLI calls. The only intentional wait is `status wait_ms` (1-60 000 ms, polling every 500 ms),
meant for when the hook is unavailable.

## Safety and trust

- `unrestricted` defaults to false for every provider except `agy` (headless agy cannot prompt, so it defaults to true) and is recorded in `job.json`. Each harness
  owns its sandbox (see CONFIGURATION.md); the ack echoes `sandbox`, `sandboxFlags`,
  `readOnlyRequested`, `readOnlyEnforced`.
- Worker-authored fields (`report`, `latestSummary`) are untrusted data; `latestSummary`
  is bounded assistant output with source `worker`, never thinking or generic tool output.
  Verify with checks or the diff.
- Cancellation: the marker is intent. Only the owning process holds the worker handle; a
  cancel from another process records the marker and says it cannot signal. If the owner
  dies the job is derived `failed (orphaned)`; there is no automatic replay or lease
  reconciliation.
- Provider auth, permissions and resume capabilities remain provider-owned. Not
  implemented: live steering, isolated worktrees, native subagent dispatch.
