# Configuration reference

Everything listed here is read by the code today. See [ARCHITECTURE.md](ARCHITECTURE.md)
for how the pieces fit.

## `models.json` (aliases and per-mode defaults)

Optional. No built-in aliases or cross-provider presets exist; without a file, requests pass
through unchanged and each harness uses its own configured default.

| File | Scope |
|---|---|
| `<repo>/.agent-smith/models.json` | project (`<repo>` = the MCP server's repo) |
| `<home>/.agent-smith/models.json` | user; `<home>` = `$AGENT_SMITH_HOME`, else `os.homedir()` |

Both are read on every `spawn_job`, `resume_job`, `run_pipeline` and `list_capabilities`
call (no caching, no restart needed). A missing file is fine; unreadable/invalid JSON or bad
entries are skipped and reported as `models.json: ...` ack `warnings` and
`aliasConfigErrors` in `list_capabilities`.

```json
{
  "aliases": {
    "fast":   { "provider": "codex",  "model": "gpt-5-mini", "effort": "low" },
    "deep":   { "provider": "claude", "model": "opus" },
    "gemini": { "provider": "agy" }
  },
  "roleDefaults": { "review": "deep", "moderate": "deep" }
}
```

- Alias name: `^[a-z0-9][a-z0-9._-]*$`. `provider` required, one of `agy|codex|opencode|claude`;
  `model` and `effort` optional strings.
- `roleDefaults` keys: `implement|review|moderate|verify`; value must name an alias.
- Precedence: a project alias replaces a user alias of the same name wholesale (no field
  merge). Project `roleDefaults` win per mode; a `roleDefaults` entry pointing at an unknown
  alias is dropped with an error (the user's entry is not resurrected).
- Resolution order per request: (1) `model` equals an alias name -> alias supplies provider
  and model; call `effort` beats alias `effort`; a different call `provider` is an error;
  (2) no `provider` and no `model` and the mode has a `roleDefaults` alias -> that alias
  (`effort` still overridable); (3) call values as given. `spawn_job` acks add `aliasApplied`
  and `aliasSource` (`alias|roleDefault`). `resume_job` expands aliases but never applies
  `roleDefaults`. `run_pipeline` expands aliases in explicit stages and uses `roleDefaults`
  for the default implement/review/moderate stages.
- The resolved model/effort are then checked against the provider catalog (see
  ARCHITECTURE.md, validation).

## Environment variables

Only variables the code reads.

| Variable | Read by | Default | Effect |
|---|---|---|---|
| `AGENT_SMITH_AGY_BIN` | `providers/agy.ts` | `agy` | Binary to exec/probe. A value containing `/` is checked directly for executability instead of searched on `PATH`. |
| `AGENT_SMITH_CODEX_BIN` | `providers/codex.ts` | `codex` | Same, for codex. |
| `AGENT_SMITH_OPENCODE_BIN` | `providers/opencode.ts` | `opencode` | Same, for opencode. |
| `AGENT_SMITH_CLAUDE_BIN` | `providers/claude.ts` | `claude` | Same, for the claude worker. |
| `AGENT_SMITH_CODEX_SANDBOX` | `providers/codex.ts` | unset | `read-only`, `workspace-write` or `danger-full-access`; overrides every other codex sandbox choice (including `unrestricted` and a mode's read-only request). Other values ignored. Shown in the ack `sandbox` string. |
| `AGENT_SMITH_CODEX_MODEL` | `providers/codex.ts` | unset | Appended as `-c model="<value>"` to every codex run when nonempty, in addition to any `--model` from the request. Not validated and not reflected in `modelResolved`. |
| `AGENT_SMITH_CODEX_HOME`, then `CODEX_HOME` | `providers/codex.ts` | `~/.codex` | Codex config dir: `config.toml` (default model/effort) and `models_cache.json` (stale fallback catalog). |
| `AGENT_SMITH_CLAUDE_HOME`, then `CLAUDE_CONFIG_DIR` | `providers/claude.ts` | `~/.claude` | Claude config dir: `settings.json` top-level `model` is the default model. |
| `AGENT_SMITH_CLAUDE_BARE` | `providers/claude.ts` | unset | `1` adds `--bare` to claude workers (no hooks/CLAUDE.md; disables keychain auth) and suppresses `--setting-sources`. |
| `AGENT_SMITH_CLAUDE_SETTING_SOURCES` | `providers/claude.ts` | `user` | Value for `--setting-sources`; empty string omits the flag. Ignored when `AGENT_SMITH_CLAUDE_BARE=1`. |
| `AGENT_SMITH_HOME` | `providers/aliases.ts` | `os.homedir()` | Where the user-level `.agent-smith/models.json` is looked up. |
| `AGENT_SMITH_STATE_DIR` | `providers/ndjson.ts` | `~/.agent-smith/state` | Provider state root used only when a spawn gives no `stateDir`. The forge always passes the job directory, so MCP/CLI jobs do not use it. |
| `AGENT_SMITH_CHANNEL` | `surfaces/channel/src/server.ts` | enabled | `0` disables the `claude/channel` capability, the startup baseline and the 5 s poll loop. The built plugin sets it to `0`; `dev.sh --channels` leaves it unset. |
| `AGY_WATCH_CWD` | `server.ts`, `monitor.ts`, `watch-hook.ts` | `process.cwd()` | Repo to operate on. MCP server order: positional argv path, then this, then cwd. `monitor.js`: `--cwd`, positional first arg, then this. Hook: last resort after payload `repo`/`dir`/`recordPath` and hook `cwd`. `dev.sh` sets it to `--repo`. |
| `HOME`, `PATH` | `discovery.ts`, `ndjson.ts` | process env | `HOME` roots the default config dirs; `PATH` is probed for provider binaries (cached per binary+PATH). |

Name note: `AGY_WATCH_CWD` is a legacy name from the agy-staff watcher but is the live
repo-selection variable for the channel server, hook and monitor.

## Harness default sources

Used for `modelResolved`/`modelSource: harness-config` (spawn ack), `list_capabilities`
`defaultModel`/`defaultEffort`, and default-pipeline stage models. Synchronous file reads;
never a CLI call on the spawn path.

| Provider | Model discovery (`list_capabilities`) | Default model/effort |
|---|---|---|
| `agy` | `agy models` (base ids; effort composed as `<model>-<low|medium|high>` for those three efforts) | none (harness picks) |
| `codex` | `codex debug models`; on failure `<codexHome>/models_cache.json` (marked `stale`) | `<codexHome>/config.toml` top-level `model`, `model_reasoning_effort` |
| `opencode` | `opencode models` (`verified: false`; use `provider/model` ids) | none |
| `claude` | static `fable`, `opus`, `sonnet`, `haiku` (efforts low/medium/high/xhigh/max) | `<claudeHome>/settings.json` top-level `model` (no effort) |

Sandbox posture per provider (echoed in the ack): agy default = `--dangerously-skip-permissions`
(headless agy cannot prompt, so restricted means silent denial; opt out with `unrestricted:false`
or `AGENT_SMITH_AGY_RESTRICTED=1`, which gives no flag and auto-denies unapproved tools;
read-only is not enforceable). codex default = `-s workspace-write`, `-s read-only` for
read-only modes, bypass flag when unrestricted (resume uses `-c sandbox_mode=...`). claude
default = `--permission-mode dontAsk --permission-prompts none` (no read-only enforcement),
`--dangerously-skip-permissions` when unrestricted. opencode default = the agent's own rules
(no flag), `--auto` when unrestricted.

## Timeouts and limits

| Name | Value | Where |
|---|---|---|
| `DEFAULT_TIMEOUT_MS` | 2 700 000 (45 min); applies when `timeoutMs` is absent, 0 or non-finite | `forge/format.ts` |
| `MIN_TIMEOUT_MS` / `MAX_TIMEOUT_MS` | 1 000 / 21 600 000 (6 h); `clampTimeout` | `forge/service.ts` |
| `wait_ms` (status) | 1 to `MAX_WAIT_MS` = 60 000; polls every 500 ms | `tools.ts` |
| `CATALOG_TTL_MS` | 300 000 (5 min), per provider, in-process | `providers/catalog.ts` |
| Discovery timeout | 10 000 per provider (+1 000 guard) | `catalog.ts` |
| `CATALOG_WAIT_MS` | 2 000, spawn-time catalog race | `service.ts` |
| `PROGRESS_FLUSH_MS` | 250 | `format.ts` |
| Cancel marker poll | 200 ms (job), 250 ms (pipeline) | `service.ts`, `execute.ts` |
| Legacy orphan rule | 2 x default = 90 min silence (no `ownerPid`) | `format.ts` |
| Stale cancel | marker older than 60 s with no live owner | `harness/agent-smith.ts` |
| Stall (`attention`) | 15 min without evidence of progress | `mod/hooks/stale.ts` |
| Check timeout | 60 000 default per check; output tail 2 000 chars | `forge/checks.ts` |
| `REPORT_HEAD_CHARS` | detailed `status` returns the first 8 000 report chars (`reportTruncated`); concise returns 2 000 | `tools.ts`, `views.ts` |
| `changedFiles` cap | 200 paths (`changedFilesTruncated`); git calls capped at 2 s | `format.ts`, `writer.ts` |
| List | default 50, max 500 | `tools.ts` |
| Pipeline concurrency | 1 to 32 | `pipeline/pipeline.ts` |
| Hook | `timeout: 21900` s; watch budget = the job's `timeoutMs` + 60 s (pipelines: 6 h + 60 s); `monitor.js` standalone default 46 min | `build-plugin.mjs`, `watch-hook.ts`, `monitor.ts` |
| Worker name | at most 80 chars | `service.ts` |

## MCP tools

All tools reject unknown fields. Failures return `isError` with a sentence to act on.
Efforts (`EFFORTS`): `low|medium|high|xhigh|max|ultra`; each model lists the efforts it
accepts. Providers: `agy|codex|opencode|claude`. Tools marked structured also return
`structuredContent` (arrays wrapped as `{items}`).

### `list_capabilities` (read-only, structured)
Params: `refresh` boolean (default false; bypass the catalog cache).
Result: `providers[]` (`name`, `available`, `defaultModel`, `defaultEffort`, `defaultSource`
`harness-config|unknown`, `models[{id,label,efforts,defaultEffort}]`, `source`
`live|cache|static`, `stale`, `verified`, `error?`; uninstalled providers appear with
`available:false` and no models), `aliases {aliases[{name,provider,model?,effort?,scope}],
roleDefaults}`, `aliasConfigErrors?`, `modes[{name,description,readOnly,runsCommands}]`,
`efforts` (text).

### `spawn_job` (structured)
| Param | Type | Notes |
|---|---|---|
| `mode` | enum `implement|review|moderate|verify` | required |
| `prompt` | string | required, nonempty |
| `context` | string | optional, 1 to 2 000 chars; why the work matters and who it is for, shown to the worker in its brief |
| `name` | string | worker label for `resume_job`; default `<mode>-<8 hex of id>`; max 80; must not collide with an active job |
| `task` | string | short description; default first prompt line |
| `provider` | enum | default: alias/roleDefault provider, else `agy` if installed, else the first installed |
| `model`, `effort` | string, enum | optional; validated against a fresh catalog, otherwise warnings only |
| `timeoutMs` | integer >= 1 | default 2 700 000, clamped 1 000 to 21 600 000 |
| `unrestricted` | boolean | default true for agy; false for other providers |
| `cwd` | string | absolute existing directory; default server repo; checks resolve against it |
| `conversation` | string | native conversation handle to resume |
| `checks` | array | items `{name, command}` required, `cwd`, `timeoutMs` (int >= 1; default 60 000), `blocking` (default true); run after success; also listed in the worker's brief as its definition of done |

Result (`SpawnAck`): `jobId, name, workerId, role, provider, status:'running', dir, repo,
timeoutMs, unrestricted, note, sandbox, sandboxFlags, readOnlyRequested, readOnlyEnforced,
modelRequested, modelResolved, modelSource` (`requested|harness-config|reported|unknown`),
`preambleApplied`, `warnings?`; plus `notify {mode:'hook', note, monitorCommand?,
monitorTimeoutMs?}`, `aliasApplied?`/`aliasSource?`, and `checks` (names) when checks were
given.

### `resume_job`
Params: `worker` (name or job id, required), `prompt` (required), `model`, `effort`,
`timeoutMs`, `unrestricted` (default: the original job's), `cwd` (absolute existing directory;
default: the original job's). An explicit cwd changes the process working directory while
retaining the prior conversation, which can still mention its previous workspace. Provider, mode, workerId,
name and conversation come from the finished job; no `provider` or `checks` parameter.
Refuses running workers, workers without a conversation handle, ambiguous names. Result:
a `SpawnAck` plus `notify` (not structured).

### `list_jobs` (read-only, structured)
Params: `provider` enum `agent-smith|agy-staff|all` (default `agent-smith`), `status` enum
`running|succeeded|failed|canceled`, `limit` 1-500 (default 20 concise, 50 detailed), `since` (ISO time
or relative `30m`/`2h`/`1d`; jobs last active at or after it), `session` (only jobs spawned by this server
process; empty after a restart), `response_format` `concise|detailed` (default `concise`). Running first,
then newest. Concise rows: `jobId, name, status, provider, model, mode, summary` (trimmed to 200 chars on a
word boundary), `toolCalls, lastActivity` (one line), `startedAt, finishedAt, nextAction?, warningCount?`.
Detailed rows (`JobSummary`): `jobId, name, workerId, role, latestSummary, summarySource,
source, status, provider, mode, model, task, toolCalls, currentActivity, lastActivity, startedAt,
updatedAt, finishedAt, warnings[], nextAction, unrestricted?`. `latestSummary` is untrusted.

### `status` (read-only, structured)
Params: `jobId` (required), `wait_ms` 1-60000 (long-poll while running), `response_format`
`concise|detailed` (default `concise`), `include_diff` (boolean).
Concise result: `jobId, name, provider, model, mode, status`, `acceptance {state, passed[], failed[]
(check names), pending?, reason?}`, `startedAt, finishedAt, durationMs, toolCalls, lastActivity`,
`changedFileCount`, `changedFiles` (first 20), `nextAction`, `error`, `warnings` (deduped strings), one `report`
(first 2 000 chars; a trailing note says it was cut and `reportTruncated` is true), `summary` only when
the report does not already contain it, and with `wait_ms`: `waited`, `stillRunning`. Null fields are omitted.
`include_diff` (either format) adds `diff`: a unified diff of `changedFiles` against the job's spawn-time
`gitBaseline.head`, run in the job's `cwd`, capped at 40 000 chars on a line boundary. `diffNote` says how
to see the rest (`git diff <head> -- <file>`), lists new untracked files (which a diff cannot show), or
explains why there is no diff (no git baseline, job still running, no changes; `diff` is then null or empty).
The diff is evidence, not attribution: parallel workers in one tree see each other's edits, and edits that
were already uncommitted at spawn in a changed file are included.
Detailed result (the full record): `JobSummary` fields plus `report` (first 8 000 chars), `reportTruncated`, `error`,
`exitCode`, `unrestricted`, `pipeline`, `stage`, `usage`, `conversation`, `effort`, `cwd`,
`modelRequested/modelResolved/modelSource`, `preambleApplied`, `sandbox`, `sandboxFlags`,
`readOnlyRequested/readOnlyEnforced`, `cancellable`, `gitBaseline?`, `changedFiles?`,
`changedFilesTruncated?`, `acceptance {state:'accepted|rejected|unchecked', checks[],
at?, pending?, reason?}`, and with `wait_ms`: `waited:true`, `stillRunning`.

### `cancel` (destructive, idempotent)
Params: `jobId` (a job id or a pipeline run id; a run record is tried first). Job result:
`{jobId, requested, signalled, note}`; `signalled` is true only when this process held the
live worker. Run result: `{requested, runId, note}`. A request does not prove the worker
stopped; check `status`.

### `run_pipeline`
Params: `spec` object (unknown fields rejected): `name` (required), `task` (required unless
`stages`), `workDir` (default repo), `concurrency` 1-32, `unrestricted` (default: true for agy stages, false for others),
`stages[]`. Stage fields: `name`, `provider` (required unless `continues` is set); `agentName`, `workerId`,
`conversation`, `continues` (see below), `model`, `effort`, `prompt`, `context` (as `spawn_job`), `title`, `role`, `dependsOn[]`, `workDir`,
`resultPath`, `timeoutMs`, `routingPinned`, `checks[]` (same shape as `spawn_job`),
`consumes[{stage,path,label?}]`. Without `stages`: implement -> review -> moderate from
installed providers. Result: `{runId, recordPath, stages[{name,provider,dependsOn}],
started:true, notify}` (not structured).

#### Fixing from a review: `continues`
`continues: "<stage>"` makes a stage resume an earlier stage's worker instead of starting a
fresh one: same provider (omit `provider` to inherit it), same worker identity, same
conversation, and the target's `workDir` unless the stage sets its own. The stage prompt
gets the artifacts of its `dependsOn` stages (plus `consumes`) as usual, so a stage that
depends on a review receives the review findings.

```yaml
- name: build
  provider: agy
- name: review
  provider: codex
  dependsOn: [build]
- name: fix
  continues: build           # agy, build's conversation and worker
  dependsOn: [review]
  checks: [{ name: unit, command: npm test }]
```

The target must be a `dependsOn` ancestor on the same provider, and `conversation` cannot
be set alongside it; these are rejected at load time. If the target produced no conversation
handle (or an escalation moved it to another provider) the stage fails with code
`no-conversation` and the reason. Rounds are explicit: `build -> review1 -> fix1 -> review2 ->
fix2`, with `fix2` continuing `fix1` or `build`. `checks` on the fix stage gate acceptance
as on any stage. A complete example is in `the-codes/cli/pipeline.example.yaml`.

### `pipeline_status` (read-only)
Params: `runId` (required), `response_format` `concise|detailed` (default `concise`). Detailed result:
the full `PipelineRecord` (`runId, pipeline, status running|passed|partial|failed, startedAt, finishedAt,
stageResults{stage -> status, acceptance passed|failed|unchecked, jobId, observations, ...}, error?`).
Concise result: `runId, pipeline, status, startedAt, finishedAt, durationMs, error?` and per stage
`status, acceptance, durationMs, jobId, checks {passed[], failed[]}, artifact` (the result path),
`failure` (`code: message`) and `outputTail` (last 500 chars); no `observations`.

### Tool errors
Bad arguments, unknown jobs/runs/workers and refused actions come back as tool results with
`isError: true` and one sentence naming the next step (e.g. `Worker "Ada" is still running; wait for its
completion notice or call cancel.`).

## Where state lives

| Path | Content | Git |
|---|---|---|
| `<repo>/.agent-smith/jobs/<jobId>/` | job directory (see ARCHITECTURE.md) | ignored (`.agent-smith/`) |
| `<repo>/.agent-smith/pipelines/` | run records, `.cancel` markers, `<runId>/artifacts/` | ignored |
| `<repo>/.agent-smith/models.json` | project aliases | ignored by this repo's `.gitignore`; in a consuming repo, commit it or ignore it as you prefer |
| `<repo>/.agy-staff/jobs/` | compat mirror for the mod | ignored (`.agy-staff/`) |
| `~/.agent-smith/models.json` | user aliases | n/a |
| `~/.agent-smith/state` (`AGENT_SMITH_STATE_DIR`) | provider state when no `stateDir` is given | n/a |
| `builds/local-plugin/`, `.claude/settings.local.json`, `the-codes/surfaces/channel/dist/` | build output / local enablement | ignored |
| `~/.claude/plugins` | Claude's own plugin registry/data; not written by Agent Smith setup | n/a |

## Build and launch

- `npm run build` builds the channel (`dist/server.js`, `monitor.js`, `watch-hook.js`).
- `npm run setup:claude`: builds `builds/local-plugin/agent-smith` (copies hooks/types/skills
  and `runtime/` with dist and node_modules, generates `hooks/watch-hooks.json`, rewrites
  `plugin.json` with the MCP server entry `node ${CLAUDE_PLUGIN_ROOT}/runtime/dist/server.js`
  and `AGENT_SMITH_CHANNEL=0`), validates it, and enables it in
  `.claude/settings.local.json` via a directory marketplace. No global config is touched.
- `dev.sh [--repo DIR] [--channels] [claude flags]`: session-scoped launch with
  `--plugin-dir the-codes/surfaces/mod` and an inline MCP config (`AGY_WATCH_CWD=<repo>`);
  `--channels` adds `--dangerously-load-development-channels server:agent-smith`.
- CLI: `agent-smith run|resume|ls|status|cancel|doctor` (`scripts/agent-smith.mjs`; Node
  >= 22.18 with native TypeScript stripping).
