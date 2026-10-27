# Agent Smith architecture

Agent Smith owns external harness execution. Claude drives it through MCP tools; the
CLI (`agent-smith setup|uninstall|run|resume|ls|status|cancel|gc|doctor`) is a second adapter over the
same `ForgeService`. Knobs and tool parameters are in [CONFIGURATION.md](CONFIGURATION.md).

## Layers

```text
providers/  -> forge/ runtime -> surfaces/channel (MCP + hook watcher) -> surfaces/mod (pane)
 argv, NDJSON   job dir, status      9 tools, notifications              band, /forge
 model catalogs  derivation, DAG     (dist/server.js, monitor.js,        (read-only view)
                                      watch-hook.js)
```

| Layer | Owns |
|---|---|
| `providers/` | `agy`, `codex`, `opencode`, `claude`, `kimi` adapters: argv, process groups, timeouts, NDJSON-to-`ProviderEvent` translation, sandbox description, model discovery (`listModels`) and harness-config defaults (`harnessDefaults`), `models.json` aliases (`aliases.ts`), the lazy catalog cache (`catalog.ts`). |
| `forge/` | Job directory format and status rules (`format.ts`), the single-writer `JobWriter` (`writer.ts`), `ForgeService` (spawn/list/detail/cancel, `service.ts`), closed modes (`modes.ts`), executable acceptance (`checks.ts`), pipeline runner and persistence (`runner.ts`, `execute.ts`), compat mirror (`mirror.ts`). |
| `pipeline/` | DAG validation, bounded scheduling (1-32), failure propagation, routing/escalation. Does not interpret prose. |
| `verify/` | Runs acceptance commands against the real working tree; exit codes decide, not worker text. |
| `harness/` | Readers. `AgentSmithReader` (primary, `.agent-smith/jobs`) and `AgyStaffReader` (read-only interop for `.agy-staff/jobs`), behind `readObservedJob` in `registry.ts`. Readers derive the final status (orphan/cancel rules below). |
| `surfaces/channel/` | MCP server (`server.ts`, `tools.ts`), optional channel push (`poller.ts`, `policy.ts`, `watch-source.ts`), job-scoped hook watcher (`watch-hook.ts`) and CLI monitor (`monitor.ts`). |
| `surfaces/mod/` | Claude Code mod: band, `/forge` pane, native task-list projection. A UI projection, not an execution runtime. It cannot import outside its plugin folder, so it restates the reader rules. Its default reader is `hooks/canonical.ts` over `.agent-smith/jobs`; `hooks/jobs.ts` reads the `.agy-staff` mirror only when `AGENT_SMITH_LEGACY_JOBS=1`. `hooks/native.ts` reads `.agent-smith/jobs/<id>/orphaned`. |
| `cli/` | Argument parsing and detached supervisor (`supervise`), same forge APIs. |

`.agy-staff/jobs/` is a one-way projection (`forge/mirror.ts`, default on) written so the
unmodified mod can render forge jobs. Nothing reads it for a verdict: `AgentSmithReader`
claims forge ids (`<mode>-smith-<8 hex>`, `isForgeJobId`), and the interop reader skips them.
Genuine agy-staff jobs remain visible read-only via `list_jobs provider=agy-staff|all`.

## Job lifecycle and on-disk layout

State lives in `<repo>/.agent-smith/jobs/<jobId>/` (gitignored). `FILES` in `forge/format.ts`:

| File | Writer | Meaning |
|---|---|---|
| `job.json` | `JobWriter`; service-owned orphan recovery; atomic whole-file rewrite | The anchor and only mandatory file. Schema v1 manifest: identity, provider/mode/model (requested, resolved, source), sandbox, status, timestamps, `ownerPid`, `exitCode`, `error`, `deniedActions`, `usage`, `gitBaseline`, `changedFiles`, and finish evidence when it applies: `toolErrors` (tool calls that ended in an error), `failedEarly`, `changedFilesUnknown`, `cwdMissingAtFinish` (see Status derivation). Never deleted. A reader refuses a manifest with a higher `schema`. Holds `task` (first prompt line, 200 chars), not the full prompt. |
| `progress.json` | `JobWriter`, coalesced to `PROGRESS_FLUSH_MS` = 250 ms | Advisory liveness: `lastEventAt` (last provider event), `lastAliveAt` and `workerPid` (the process owner's heartbeat, see Liveness), live `toolCalls` and `toolErrors`, recent activities, `lastActivity` (including completed tools), `latestText`, `latestSummary` (source `worker`: the current assistant message only, reset at each tool call; at finish the last 1 000 chars of the final response, cut at a paragraph or line boundary), warnings, and `digest`: what the worker has done so far, from its tool calls (`phase`, files read, searches, files edited through visible edit tools, commands, test runs and whether the last one explicitly failed, a repeated call). One classifier in `surfaces/mod/hooks/progress.ts` serves every provider and both the writer and the UI. It never reports a passing test or zero edits, because exit codes and shell edits are not always visible. |
| `events.jsonl` | `providers/ndjson.ts` | Normalized `ProviderEvent` stream. Heartbeats are not written here. |
| `argv.json` | `providers/ndjson.ts` | Exact argv and cwd. |
| `stderr.log` | `providers/ndjson.ts` | Child stderr, verbatim. |
| `result.json` | `providers/ndjson.ts` | Verbatim adapter `JobResult`, written once at completion. Its presence stops orphan derivation. |
| `result.md` | `JobWriter` | The report (worker output). May be absent/empty for a denied job. |
| `cancel` | `ForgeService.cancel` | Marker holding the ISO instant of the request. It is a request, not a verdict. |
| `cancel.steer` | `ForgeService.steer` (`delivery: 'interrupt'`) | Marker telling the owning pump to abort the active turn and immediately chain the queued steer turn. Cleared by `ForgeService.cancel` if user cancellation wins. |
| `steer.jsonl` | `ForgeService.steer` | Append-only JSONL log of `SteerEntry` records consumed by the owning `pump` loop. |
| `steer.head` | `ForgeService.pump` | Child job ID written after the continuation anchor exists and before the parent stamps `supersededBy`; lets `resolveHead` (cancel/status) cross that finish window. |
| `orphaned` | legacy marker | Existing markers remain readable. New readers do not write markers; service recovery persists terminal state in `job.json`. |
| `acceptance.json` | `forge/checks.ts` (only when `spawn_job` got `checks`) | Sidecar, see Acceptance. Not in `FILES`. |
| `env-keys.json` | `ForgeService` (only when the spawn got `env`) | The names of the worker's extra environment variables. Values are never written anywhere (`ENV_KEYS_FILE`, `spawn-request.ts`). |

Pipeline runs sit beside jobs, not inside them: `.agent-smith/pipelines/<runId>.json`
(`PipelineRecord`: `running|passed|partial|failed`, per-stage results), `<runId>.cancel`
(marker, polled every 250 ms by the owner), and `<runId>/artifacts/<stage>/<resultPath, default result.md>`
(handoff artifacts scoped per run and stage; directories are created before dispatch).
Worker cwd stays the source checkout. Prompts label the source workspace and output artifact
separately; this does not isolate filesystem access.

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
names. `steer_job` steers a running worker via append-only `steer.jsonl` (`delivery:
'queue'` chains after the active turn finishes; `delivery: 'interrupt'` writes `cancel.steer`
to stop the active turn once a `conversation` handle is recorded and immediately chains the
continuation turn). The pump opens the child job anchor before marking the parent
`supersededBy: nextJobId` (`steeredFrom: parentJobId` on the child) and publishes
`steer.head` between the two, so `resolveHead` readers (cancel/status) cross the finish
window while watchers and notice claims transfer across turn chains without firing
intermediate notices. A queued steer the turn cannot deliver is recorded as a warning on
the terminal job.

Watched brief files (`files` on `spawn_job`, `resume_job`, `steer_job`): relative paths inside
`repo` are validated against path traversal and synced into `cwd` when `cwd !== repo`, recording
`watchedFiles: Record<path, { repoSig, cwdSig }>` on `job.json`. `JobWriter.prepareFinish()`
excludes synced watched files from `changedFiles` if `cwd` still matches `cwdSig` (so a worker
merely reading a synced brief file does not pollute `changedFiles`), while keeping any watched
file whose `cwd` content diverged from `cwdSig`. If `repo`'s copy changes from `repoSig` while
`cwd`'s copy still matches `cwdSig`, `computeStaleReads` surfaces the path in `staleReads` (on
`status` and in completion notices as `stale brief: <file>`). Steering or resuming the worker
re-syncs watched files from `repo` into `cwd` and refreshes `watchedFiles`.

## Status derivation

`deriveStatus` (`forge/format.ts`) is the one place a terminal verdict is computed.
Precedence: already terminal (a cancel verdict is final) > no verdict = `running` >
`deniedActions` non-empty, other than a successful nonempty report with only `nonfatal`
denials (any provider; legacy claude `action: 'tool'` counts) = `failed` + suspicious >
`ok === false` = `failed` > cwd gone on a writing job = `failed` + suspicious (below) >
successful nonempty report with only `nonfatal` denials = success with warning >
`ok === true` with empty report (empty after trim, `MIN_USEFUL_CHARS = 1`) = `failed` +
suspicious > `ok === true` = `succeeded`. A job that exited 0 and delivered nothing is
failed, never a quiet success.

The cwd rule sits after the fatal-denial and `ok === false` rules and before the
nonfatal-denial success, so a denied call never excuses a writing job from it: when the
job's cwd no longer exists at finish (`cwdMissing`) and the job is a writing one
(`implement`/`verify` mode, or one of its own edit tool calls completed without error; a
failed or denied edit does not count), the verdict is `failed` + suspicious with `CWD_GONE_REASON` "working
directory gone; nothing could be verified" (short reason "working directory gone"). A
read-only job keeps its verdict and gets a warning instead: its report is the deliverable.
Either way the manifest records `cwdMissingAtFinish: true`. `JobWriter.verdictFacts()` (via
`format.ts` `cwdFacts`) supplies these inputs to `finish()` and to the steer chain, so a
cwd-gone writing turn never chains a queued steer; orphan recovery (`reconcile.ts`) uses the
mode, the cwd and progress.json's `editsCompleted` (edits that ended without error; the
digest's `editedCount`, which counts at start, only for files that predate it), and records `changedFilesUnknown` when it
recovers a persisted result (it never runs the finish-time diff).

Finish evidence, recorded only when true (`writer.ts`): `changedFilesUnknown` when
`changedFiles` could not be computed (no git baseline, git failed or timed out, cwd gone), so
an absent `changedFiles` means unknown, never "no edits"; `toolErrors` counts tool calls that
ended in an error state, a warning and not a verdict (opencode no longer fails a job that
delivered its report after one failed `read`; an `error`/`session.error` event, a denial,
a nonzero exit or an empty report still fails it); `failedEarly` when a failed job
made no tool call and either ended within `FAILED_EARLY_MS` = 20 s or its first substantive
event was an error, keeping the provider's text in `error` (a route problem: model not
available in the region, account out of funds).

`AgentSmithReader.read` (`harness/agent-smith.ts`) then applies, only to a `running`
manifest with no `result.json`, not canceled:

- **Orphan** (`deriveOrphan`): with `ownerPid`, orphaned iff `kill(pid,0)` fails (`EPERM`
  counts as alive). Legacy manifests without `ownerPid` are orphaned only when the newest of
  `updatedAt`/`progress.lastEventAt`/`createdAt` is older than `LEGACY_ORPHAN_AFTER_MS` =
  2 x `DEFAULT_TIMEOUT_MS` = 90 minutes. Result: `failed`, suspicious, reason
  "supervisor process exited before the job finished (orphaned)". Readers are read-only.
  The service reconciles jobs at startup and before list/detail/state reads: a recorded
  dead owner permits recovery from a valid persisted result, including its report and
  conversation handle. Missing or invalid results become failed orphan records; pending
  acceptance settles as rejected without replaying checks. Live owners and terminal anchors win.
  PID-less legacy jobs retain the read-only fallback; their writer's death cannot be proven.
- **Stale cancel**: if no orphan verdict, a `cancel` marker older than 60 s and no live
  `ownerPid` (in practice a manifest without `ownerPid`, since a dead pid is already an
  orphan) reports `canceled` with reason "cancel requested and no supervisor confirmed it".
- A fresh `cancel` marker alone does not make a job canceled; only a terminal `canceled`
  manifest does. With a live owner, the owner's poll signals the worker's process group and
  records the result.

### Liveness

`updatedAt`/`lastEventAt` move only on provider events, so a worker running one long command
(`cargo test`) or a coordinator waiting on its team emits nothing. The process owner adds a
heartbeat: `providers/ndjson.ts` `spawnWorker` calls `onHeartbeat` once right after spawn and
every `HEARTBEAT_MS` = 30 s while the child runs; each adapter puts it on its bus as a
`{kind:'heartbeat', at, pid}` `ProviderEvent` (never in `events.jsonl`), and
`JobWriter.heartbeat` writes `progress.json` `lastAliveAt`/`workerPid` only, without moving
`lastEventAt`, `updatedAt`, the timeline or the mirror.

`livenessOf` (`mod/hooks/stale.ts`) is the one rule; the channel (`views.ts`, `tools.ts`,
`watch-source.ts`) and the mod (`canonical.ts`, `jobs.ts`) both call it. A job that is not
running has none. Otherwise, in order:

| State | When |
|---|---|
| `dead` | `lastAliveAt` older than `ALIVE_GRACE_MS` = 2 min while still running |
| `silent` | no event time at all; or no `lastAliveAt` (a job from an older build) and no event for `STALL_GRACE_MS` = 15 min |
| `in-tool` | the latest activity is still open (`lastActivity.status === 'active'`: started, not ended); a long command is not a stall |
| `active` | an event within 15 min |
| `silent` | no event for 15 min, heartbeat fresh |
| `waiting` | reserved for known live children (agy team members, Claude subagents); not produced |

The result carries `silentForMs` (since the last event), `since`, `forMs` and, for an open
call, `tool` (the first command of a shell call, else the tool name). `attention` (channel
`WatchStatus`, mod `RadarStatus`) means `silent` or `dead`; `status` and `list_jobs` expose
`liveness {state, silentForMs, tool?}` and keep `stalled` as a derived alias (silent or dead)
for one release. kimi reports a tool call only when it ends, so a kimi job in a long command
reads `silent`, not `in-tool`.

`nextActionFor` derives (never stores) an imperative for the orchestrator on
`failed`/`canceled` jobs: canceled -> nothing to do; orphaned -> `resume_job` if it has a
conversation handle else rerun; denied -> use an approved path or ask authorization before
retrying unrestricted; authentication/quota -> resolve the account problem; rate limit ->
wait or reduce concurrency; incompatible arguments -> run `doctor` and check capabilities;
`failedEarly` -> pick another model from `list_capabilities` or fix the account (after the
specific diagnoses, before the generic ones; never for a timeout);
timeout -> raise `timeoutMs`/split; network-ish error -> retry once;
empty output -> ask via `resume_job`; otherwise read `error` and `warnings`. `null` for
running/succeeded. Surfaced in `list_jobs` and `status`.

## MCP Tasks (`io.modelcontextprotocol/tasks`)

The MCP server (`surfaces/channel/src/mcp.ts`, `tasks.ts`, `task-store.ts`) provides an
opt-in 2026-07-28 Tasks receiver (`AGENT_SMITH_TASKS=1`) over `ForgeService` for
`spawn_job` and `resume_job`:

1. **Negotiation and per-request gating**: `extensions['io.modelcontextprotocol/tasks']`
   is advertised only on modern (`2026-07-28`) connections when `AGENT_SMITH_TASKS=1`
   (or `options.tasks: true`). `spawn_job` and `resume_job` return a task handle
   (`resultType: 'task'`) only when the incoming `tools/call` request also advertises
   `extensions['io.modelcontextprotocol/tasks']` in `_meta['io.modelcontextprotocol/clientCapabilities']`.
   Requests without that capability (and all other tools, including `run_pipeline`) use
   the immediate tool-result path.
2. **Pre-launch validation and MRTR approval**: argument validation and unrestricted
   approval (`resultType: 'input_required'` with HMAC-bound `call` + resolved `prompt`)
   settle before `ForgeService` prepares the job or allocates a task record. Declined or
   invalid calls return ordinary `isError` tool results and never create a task.
3. **Atomic persistence and crash recovery**: `ForgeService.spawnTracked` invokes
   `onPrepared(jobId)` immediately after writing `job.json` (and `tools.ts` writes any
   pending `acceptance.json` placeholder) before spawning the worker process.
   `TaskStore` (`<repo>/.agent-smith/tasks/<taskId>.json`, 24 h default TTL, 1 000 record
   cap) atomically links `taskId` -> `jobId` via hard-link publication. Terminal outcomes
   are frozen once via `<taskId>.terminal` hard-link publication so concurrent writers,
   repeated `tasks/get` polls, and server restarts return the identical terminal snapshot.
4. **Completion, acceptance, and cancellation**: `tasks/get` reconciles through
   `ForgeService.detail(jobId)` and `readAcceptance`. A task stays `working` until both
   the worker exits and any acceptance checks finish (`pending !== true`). Completed tasks
   return a `CallToolResult` (`resultType: 'complete'`, `_meta['io.agent-smith/task-result']: true`)
   whose `structuredContent` carries the full `JobDetail` (including `report`, `acceptance`,
   and `taskStatus`), with `isError: true` when the worker failed or acceptance was
   rejected. `tasks/cancel` reconciles completion first (a finished worker wins the race),
   records `cancellationRequestedAt`, and requests `ForgeService.cancel(jobId)`, keeping
   task status `working` until the Forge job reaches `canceled`. Protocol-level `failed`
   (`-32603`) is reserved for tasks whose linked Forge job is missing or unreadable.
5. **Claude Code orchestrator status**: Claude Code 2.1.300 negotiates `2026-07-28` via
   `server/discover` over stdio and ships a built-in 2026-07-28 Tasks client driver
   (`CreateTaskResultSchema`, `driveMcpTask` polling `tasks/get`, `tasks/update`,
   `tasks/cancel`), but gates advertising `extensions['io.modelcontextprotocol/tasks']`
   behind its remote feature flag `tengu_glowing_lark` (default `false` in 2.1.300).
   While that host flag is off, Claude Code strips `io.modelcontextprotocol/tasks` from
   per-request `_meta['io.modelcontextprotocol/clientCapabilities']`, and Agent Smith
   cleanly serves the immediate `SpawnAck` fallback.

Track the [Tasks specification](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks)
and [official extension implementation](https://github.com/modelcontextprotocol/ext-tasks).

## Modes

`forge/modes.ts`: closed set `implement | review | moderate | verify`. A mode is a preset
of one line of brief guidance plus a sandbox posture, nothing else; it never picks provider
or model.
`review` and `moderate` are `readOnly` (requested; enforced only where the CLI can:
codex `-s read-only`; the ack's `readOnlyEnforced` says which); `implement` and `verify`
`runsCommands`. `readOnlyRequested = preset.readOnly && !unrestricted`. `agy` with a
command-running mode and `unrestricted:false` gets an ack warning: headless agy auto-denies
unapproved tools. Pipeline stages and resumes may keep arbitrary legacy roles.

| Mode | Guidance (reason given to the worker) | readOnly | runsCommands |
|---|---|---|---|
| `implement` | Keep the change small: the orchestrator reviews the diff. | no | yes |
| `review` | Find problems, don't fix them: the author fixes from the findings. Evidence per defect, no style nits. | yes | no |
| `moderate` | Independently confirm or refute the earlier work and the reviewer's claims; leave files as they are. | yes | no |
| `verify` | Run the checks and report exactly what happened; report failures rather than fixing them. | no | yes |

### Worker brief

`forge/brief.ts` `buildBrief` builds the text `spawnTracked` prepends to every fresh job's
prompt, joined by a blank line:

1. who the worker works for (an orchestrating agent that checks its work);
2. `Workspace: <cwd>` and that changes belong inside it. Pipeline stages omit this line,
   because `buildStagePrompt` already names the source workspace and output artifact;
3. `Context: <context>` when `spawn_job.context` or `stage.context` is set;
4. the checks as `name: command` (with `(in cwd)` when a check has its own), under "you're
   done when these pass; they run after you finish". `blocking:false` checks are listed
   separately as information only. The service only describes checks; `tools.ts` and
   `runner.ts` still run them;
5. the mode's guidance, when the mode is in the closed set;
6. an evidence line: only claim what you can point to, and say what isn't verified.

A resume (`conversation` set) already holds the brief, so it gets only the context and
check lines, and only when that request supplies them; otherwise nothing is prepended.
Pipeline retries that continue the same conversation pass neither. The brief is not
prepended when the prompt already starts with it. `preambleApplied` is true when the sent
prompt starts with the brief; `view.json` (and the mirrored spec) keep the prepended brief as
`preamble`, so the `/forge` pane's "Show preamble" shows exactly what was added.

## Model discovery and validation

`providers/catalog.ts`. The MCP server warms every catalog in the background at startup
(`ForgeService.warmCatalogs`, fire and forget; `AGENT_SMITH_NO_CATALOG_WARMUP=1` skips it), so
the first spawn usually finds them cached. Discovery is also persisted to
`<repo>/.agent-smith/catalogs/<provider>.json` (`{at, catalog}`, atomic write), because every
production launch validates in a fresh supervisor process with an empty memory cache: it reads the
file the warm-up wrote instead of probing the CLI again.

- `getCatalogs({providers?, refresh?, timeoutMs?})`: PATH-probes `available()` for each
  provider, fans out `listModels()` in parallel (10 s per provider, guard +1 s), never
  rejects. Cache per provider, `CATALOG_TTL_MS` = 5 min: in memory, then the repo's disk file above
  when the caller passes `repo` (the service and `list_capabilities` do), so any process sees
  another's discovery. `refresh: true` skips both as a source of fresh data and rewrites the file.
  A usable result (no error, or models present) is cached and persisted. If discovery fails and an
  older entry exists (memory or disk, any age), the old catalog is served with `stale: true` and
  the new `error`; the file is left as it was. A failure with no prior entry is returned uncached.
  An unreadable or malformed file is ignored. `static` catalogs are not persisted.
- Sources: `agy models` (base ids, `-low|-medium|-high` suffix stripped into efforts);
  `codex debug models`, falling back to `<codexHome>/models_cache.json` marked `stale`;
  `opencode models` (`verified: false`); `kimi provider list --json` (keys of its `models`
  map are the aliases `--model` accepts; live-verified on 2.1.1; efforts are not advertised
  because print mode has no per-run effort flag); `claude` static aliases
  `fable|opus|sonnet|haiku` (`source: 'static'`).
- Harness defaults (`harnessDefaults`, synchronous file read, no CLI): codex
  `<codexHome>/config.toml` top-level `model` and `model_reasoning_effort`; claude
  `<claudeHome>/settings.json` top-level `model`; kimi `<kimiHome>/config.toml` top-level
  `default_model`. agy and opencode have none.
- Spawn path: a catalog is consulted only if the request names `model` or `effort`, raced
  against `CATALOG_COLD_WAIT_MS` = 5 s until any catalog lookup has completed in the process
  (a fresh disk entry makes that lookup immediate, so a supervisor does not wait the cold budget),
  then `CATALOG_WAIT_MS` = 2 s (a spawn joins a warm-up still in flight rather than starting a
  second discovery); on timeout/error it is treated as absent. With no
  `model`, `modelResolved` comes from `harnessDefaults().model` (`modelSource`
  `harness-config`); a provider-reported model on the `started` event upgrades an unknown to
  `reported`. Effort defaults are not resolved at spawn.
- Validation (`checkAgainstCatalog`): only a **fresh** catalog (not stale, no error,
  `verified !== false`, `source !== 'static'`, models nonempty) can reject: unknown model ->
  error listing valid ids (agy also accepts `<base>-low|medium|high` when `<base>` exists);
  effort not in the model's nonempty `efforts` (model or catalog default) -> error. Stale,
  static (claude), unverified (opencode), empty or errored catalogs never reject; the ack
  gets "could not verify ... passing it through unchecked" in `warnings`.
- Kimi has no per-run effort flag: a requested `effort` is dropped before `job.json` is written
  and the ack warns (the adapter also emits an event), while the value comes from
  `[thinking].effort` or a model alias's `default_effort` in `config.toml`.
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
checks are recorded but never gate, including missing-directory/spawn failures. A mandatory
declared check with an empty command rejects acceptance; optional absent commands remain
informational. Verdicts preserve timeout, signal, skipped reason and diagnostic reason.
A pending `{state:'unchecked', pending:true, budgetMs}` placeholder is written at spawn
(`pendingAcceptance`; `budgetMs` = the checks' timeouts summed + 30 s, capped at 30 min). While
checks run, `runAcceptance` rewrites it with `startedAt` and `running` (the names of the checks
running now, comma separated); `status` shows `acceptance.running`. The real verdict replaces
it atomically. `cancel` stops running checks on either path and acceptance becomes `unchecked`
with reason `checks canceled`. In the MCP process an AbortController aborts them and the result
carries `checksCanceled: true`. In production the detached supervisor owns them: it polls the
job's `cancel` marker every 200 ms while checks run (and once before they start) and aborts
through the same signal. There `cancel` cannot know the outcome, so it says `checksCanceled: false`
with a `checksNote` (the request is recorded and the supervisor will stop the checks) while a
placeholder shows checks running; `checksCanceled: true` always means something was aborted. Check output tails are capped
at 2000 chars; default per-check timeout 60 s; `cwd` resolves against the job's cwd.
`status` merges the sidecar (`unchecked` when absent or unreadable). The gate lives in the
MCP server process: if it exits before the job finishes, the placeholder stays. Pipeline
stages use the same rules (`StageResult.acceptance` `passed|failed|unchecked`, reported by
`pipeline_status`).

Completion notices lead with execution status and truncate worker prose at a sentence
or word boundary. They include provider, elapsed time, changed-file count and the
check tally only when recorded evidence exists. A notice waits for a pending verdict up to
the placeholder's `budgetMs` (`ACCEPTANCE_HOLD_MS` = 5 min without one). If it must fire
first it says `… <worker> <time> · exited · checks running: <name>`, never `done`, and a
second notice announces the verdict when it lands. One renderer, `mod/hooks/notice.ts`,
writes them for both announcers (see Notifications).

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
  | <---- SpawnAck {jobId, dir, repo, notify{mode:'hook', note, fallback}} (ms)
  |
  |   PostToolUse(matcher: mcp__plugin_agent-smith_agent-smith__{spawn_job|resume_job|run_pipeline})
  |         hook stdin JSON {tool_name, tool_response, cwd} --------> parseHookInput -> {job|run, id, repo}
  |   (asyncRewake: Claude keeps working)                             runJobWatch: read job every 2 s,
  |                                                                   no baseline, buildBatch/dedupe
  |                                                                   (job done before start is reported)
  | <==== exit 2 + stderr "Agent Smith · ✓ Ada (codex review) succeeded…" == terminal state seen
  |   Claude wakes -> status(jobId) / pipeline_status -> acts on report + acceptance
```

- **Mod announcer** (`mod/hooks/register.tsx` `takeLaunch`/`announce`, rules in
  `notice.ts`): when the mod is loaded it wraps the three launch tools in
  `tool.call`, reads the ack from the result, claims the job or run in session
  state (`notices` atom) and writes `.agent-smith/claims/<kind>-<id>`. The hook
  watcher still starts, but at completion it finds the claim and stays silent: one
  announcer per job. The mod hooks no `classic.*` event: Claude Code's built-in
  guard (`cc-plugin-sec-default`) sends `classic.PostToolUse` past user-tier
  modules, so `tool.call` is the only path. A `status`/`pipeline_status` read of a
  settled job on the main loop (`tool.call` with no `agentId`) retires its notice.
  It declines (calls `next`) in legacy mode, after a read error, or when the ack's
  repo is not the one it polls. Each 3 s poll announces claimed jobs that ended, or
  went quiet (once: `no output for 16m`, with `(in \`npm test\`)` when a call is open), or
  whose process is gone (once more: `process gone 3m`); the text states the fact and never
  asks for an interrupt. It holds a pending acceptance verdict for the checks' budget, with one
  `$.prompt.submit` turn credited to the plugin. Claude Code shows that message to
  the user in full, so it is the only notice: one line per job, no worker summary. Only claimed ids are announced, so two sessions on one repo
  never wake each other. A claimed run is announced with its stage jobs when the
  run ends. `/clear` resets session state, so a job claimed before it goes
  unannounced (the band still shows it).
- **Hook watcher** (`watch-hook.ts`), the fallback when no mod claims the launch: `build-plugin.mjs` generates `hooks/watch-hooks.json`
  (`PostToolUse`, `asyncRewake: true`, `timeout: 21900` s) running
  `runtime/dist/watch-hook.js`. `parseHookInput` strips the MCP prefix, unwraps the result
  (`structuredContent` or JSON text), takes `jobId` or `runId`, and resolves the repo from
  `payload.repo`, else `dir`/`recordPath`, else hook `cwd`, else `AGY_WATCH_CWD`, else
  `process.cwd()`. It watches that one job/run (a run also its stage jobs) in-process,
  prints the notice to stderr and exits 2 (Claude Code labels that wake "Stop hook
  feedback" and the label can't be changed, so the notice ends by saying it is not an
  error). Any error or non-matching tool exits 0
  silently: a hook must never break the session. A hook can wake Claude only once, so it
  announces once (`runJobWatch` `announceOnce`): the verdict, held while the checks run, or, if
  the acceptance budget runs out first, the "exited · checks running" text, after which it ends.
  Never both in one write. The mod announcer is different: it sends that early notice and then
  the verdict as a second notice. The hook passes `runJobWatch` a timeout of the job's own
  `timeoutMs` (from the ack) + the acceptance `budgetMs` (from the pending placeholder written at
  spawn) + 60 s, capped at the hook's own timeout less a minute (pipelines: the 6 h cap + 60 s);
  standalone
  `monitor.js` defaults to `DEFAULT_WATCH_TIMEOUT_MS` = 46 min. On timeout it emits "still
  running; check status <ids>" (exit 2 from the hook).
- **Tasks-shaped handle and opt-in MCP Tasks**: acks carry `taskHandle {taskId, status:'working', pollIntervalMs}` and
  `status`/`list_jobs` add `taskStatus` (`views.ts` `taskStatus`), the MCP Tasks extension's
  vocabulary (`pollIntervalMs` is `poller.ts` `POLL_MS`). When `AGENT_SMITH_TASKS=1` is enabled and a
  modern (`2026-07-28`) `spawn_job` or `resume_job` request advertises `io.modelcontextprotocol/tasks`,
  the server returns a protocol `resultType: 'task'` handle (`tasks.ts`) and stamps
  `_meta['io.agent-smith/task-result']: true` on the terminal result so `notice.ts` (`parseLaunch`)
  never double-announces a Tasks-managed job.
- **Fallback**: acks carry `notify {mode:'hook', note, fallback {when, use, monitorCommand?,
  monitorTimeoutMs?}}`. `note` says a notice is coming; `fallback.when` names the only cases to
  wait yourself: no notice by the job's timeout + its checks' budget + 2 min (a run: `pipeline_status` shows it
  ended), a headless session that can't receive messages between turns, or a subagent that
  must return the result. Nothing runnable sits at the top level:
  agents handed `monitorCommand` there ran it at once and heard about each job twice.
  `monitorCommand` (only when running from the built `dist/`) is `node .../monitor.js
  --job <id>|--run <id> --cwd <repo>`, to run in the background
  (`monitorTimeoutMs` = min(job timeout, 30 min); re-arm on expiry). Or `status wait_ms`.
  `monitor.js` with no `--job/--run` is the legacy full-scan monitor (silent baseline,
  polls every 5 s); the plugin no longer registers it.
- **Why the always-on monitor was removed**: a `when: always` monitor polled every job dir
  every 5 s for the whole session and appeared in Claude's exit dialog. The hook is scoped
  to one job and gone when it finishes.
- **One path per session**: the plugin's MCP server is configured with
  `AGENT_SMITH_CHANNEL=0` (no `claude/channel` capability, no poll loop, no startup
  baseline), so the hook is the only notifier. The channel (`poller.ts`: 5 s poll, first
  poll is a silent baseline, per-job dedupe key `id#status[#dead][#checks]#epoch`, one batched
  notification per tick, only `finished|failed|attention|cancelled`; `attention` for a silent
  job needs an event time, for a dead one it does not) runs only when the server starts
  without `AGENT_SMITH_CHANNEL=0`, e.g. `dev.sh --channels` (which loads the mod via
  `--plugin-dir`, hence no hook).
- **Unverified**: exit-dialog behavior of async hooks, hook timeout cap for 45-minute jobs,
  and wake while Claude is mid-turn.

## No long calls

Every tool answers fast so the MCP server and the session are never blocked by a
long-running job: `spawn_job`/`resume_job`/`run_pipeline` return once the anchor is on disk
(`run_pipeline` persists the run record first); discovery runs in the background at server
start, on `list_capabilities`, or when a model/effort is named, bounded on the spawn path to 5 s
before any catalog has been seen and 2 s after; harness defaults are file reads, not CLI calls. The intentional waits are `status wait_ms` (1-60 000 ms, polling every 500 ms),
meant for when the hook is unavailable, and an unrestricted confirmation, which waits on the
user (up to 10 minutes) before anything launches.

## Safety and trust

- An explicit `unrestricted: true` for codex, claude or opencode on `spawn_job`/`resume_job` is
  confirmed with the user through MCP form elicitation before launch (`tools.ts`
  `confirmUnrestricted`; the server handle reaches `callTool` as `HandlerContext.server`). It
  fails closed: decline, cancel or no answer returns `isError`. Clients without form elicitation
  launch with an ack warning; `AGENT_SMITH_CONFIRM_UNRESTRICTED=0` skips the prompt.
- `unrestricted` defaults to false for providers that can prompt; agy defaults to true (with
  an env opt-out) and kimi is always true because its print mode force-sets auto, so it cannot
  be restricted. `job.json` records the effective posture, not a request that had no effect;
  read-only is not enforceable for kimi. Each harness
  owns its sandbox (see CONFIGURATION.md); the ack echoes `sandbox`, `sandboxFlags`,
  `readOnlyRequested`, `readOnlyEnforced`.
- `env` on `spawn_job`, `resume_job` and pipeline stages adds worker environment variables
  (keys `^[A-Za-z_][A-Za-z0-9_]*$`, string values without NUL; `validateEnv`). Values live in
  memory only: `env-keys.json` and the ack's `envKeys` carry names. `resume_job` does not
  inherit env; when the original had some, its ack warns that they were not passed again.
- Worker-authored fields (`report`, `latestSummary`) are untrusted data; `latestSummary`
  is bounded assistant output with source `worker`, never thinking or generic tool output.
  Verify with checks or the diff.
- Cancellation: the marker is intent. Only the owning process holds the worker handle; a
  cancel from another process records the marker and says it cannot signal. If the owner
  dies the job is derived `failed (orphaned)`; there is no automatic replay or lease
  reconciliation.
- Provider auth, permissions and resume capabilities remain provider-owned. Not
  implemented: isolated worktrees, native subagent dispatch.
