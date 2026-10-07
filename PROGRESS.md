# Agent Smith: current status

Last checked against commit `dbe5f3e` (2026-10-07). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for design and [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for knobs and tool parameters.

## Done

- **Runtime**: CLI and MCP share `ForgeService` and the persistent DAG runner. Jobs live in
  `.agent-smith/jobs/<id>/` (`job.json` anchor, progress, events, argv, stderr, result,
  `result.md`, `cancel`/`orphaned` markers); pipeline runs in `.agent-smith/pipelines/`.
- **Providers**: `agy`, `codex`, `opencode`, `claude` adapters with sandbox description,
  per-provider `listModels`, and harness-config defaults (codex `config.toml`, claude
  `settings.json`) read without running a CLI.
- **MCP surface**: 8 tools (`list_capabilities`, `spawn_job`, `resume_job`, `list_jobs`,
  `status`, `cancel`, `run_pipeline`, `pipeline_status`); `structuredContent` on
  `list_capabilities`, `spawn_job`, `list_jobs`, `status`; tool annotations; instructions that
  mark worker text as untrusted.
- **Closed modes** `implement|review|moderate|verify` as presets (preamble + sandbox
  posture); spawn acks report effective sandbox, `readOnlyEnforced`, requested vs resolved
  model and source, warnings.
- **Model catalog**: lazy, 5-minute per-provider cache, stale-on-error; validation rejects only
  on fresh verified catalogs, otherwise warns and passes through.
- **Aliases**: optional `models.json` (project over user) with per-mode `roleDefaults`, applied
  in `spawn_job`, `resume_job` and pipelines.
- **Acceptance**: `spawn_job` `checks` -> `acceptance.json` (`accepted|rejected|unchecked`),
  merged into `status`; pipeline stages use the same rules.
- **Derived fields**: `nextAction`, orphan detection (`ownerPid`, 90-minute legacy rule),
  stale-cancel rule, `gitBaseline`/`changedFiles`.
- **Notifications**: job-scoped `PostToolUse` `asyncRewake` hook (`watch-hook.js`, generated
  `hooks/watch-hooks.json`, timeout 21 900 s) replaces the always-on monitor; `monitor.js --job|--run`
  stays as a manual Monitor fallback; acks carry `notify`; `status wait_ms` as last resort.
  The built plugin runs the MCP server with `AGENT_SMITH_CHANNEL=0` so only the hook notifies.
- **Mod**: `/forge` pane, live band, native task-list projection; reads the `.agy-staff/jobs/`
  compat mirror and the `orphaned` marker.
- **Local setup**: `npm run setup:claude` builds a self-contained plugin and enables it for
  this checkout only (directory marketplace in `.claude/settings.local.json`); `dev.sh` is the
  session-scoped alternative.

## Verification status

Re-run on 2026-10-07 for this update:

- `npm run typecheck`: clean.
- `npm test`: 568 tests, 566 pass, 2 fail. The failures are in
  `the-codes/surfaces/mod/tests/jobs.node-test.ts` ("the real corpus ..."): they assume a
  fixed set of jobs in an external agy-staff directory (a developer-machine path) and are not
  runtime regressions.
- Not re-run for this update: `claude plugin validate`, mod engine tests, the built-bundle SDK
  smoke tests, any live provider job.

Covered by automated tests only (fixture or fake workers, real subprocesses and stdio MCP
where noted): forge writer/format/orphan/next-action/checks, provider argv and event
translation, catalog and alias logic, tool handlers, policy/poller dedupe, hook parsing and
job watcher, pipeline runner, CLI.

Reported verified live earlier (from previous revisions of this file and adapter source
comments; not re-confirmed in this update): plain `claude` 2.1.292 startup connected the
plugin's MCP server and `/forge` worked (with the old monitor, seven tools then); agy
headless behavior (denied tool exits 0 with an empty result) and the agy/claude/codex flags
the adapters use were checked against real CLIs. No successful paid-model end-to-end job is
claimed by the automated suite.

## Known gaps and unverified

- **Hook behavior in real Claude Code is unverified**: exit-dialog behavior of async hooks,
  whether a 21 900 s hook timeout is honored for long jobs, and wake while Claude is
  mid-turn. The watch budget follows the job's own `timeoutMs` (+60 s).
- Hooks do not exist in headless `-p` or other MCP clients; those need the `notify.monitorCommand`
  fallback or `status wait_ms`.
- **OpenCode**: model listing is `verified: false` and its success-stream parsing is
  provisional; no sandbox flag exists (default permissions, `--auto` when unrestricted).
  Qualify against a real install before relying on it.
- No model-specific live qualification; catalog validation depends on each CLI's own listing.
- Owner crash: the job is derived `failed (orphaned)` and cancel cannot stop the leaked worker;
  there is no owner lease, reconciliation or automatic replay. Pipeline records can stay
  `running` after a supervisor dies (no orphan derivation for runs).
- Acceptance checks for `spawn_job` run in the MCP server process; if it exits before the job
  finishes, `acceptance.json` stays at the pending placeholder.
- `changedFiles` is a worktree diff, so concurrent jobs in one worktree can see each other's edits.
- No live steering (follow-ups need a finished conversation), no isolated worktrees, external
  workers are tracked tasks rather than native Claude subagents or teammates.
- Doc/code drift to clean up: comments in `forge/service.ts` cite a "no-long-call rule" in
  `server.ts` that is not written there; `server.ts` comments still say the native plugin uses
  a separate monitor and list five tools; `surfaces/channel/README.md` lists seven tools
  (`list_capabilities` is missing).

## Next steps

1. Run the plugin in real Claude Code (interactive and `-p`) and record hook wake, exit-dialog
   and mid-turn behavior; adjust the hook timeout or add re-arm if needed.
2. Owner leases and reconciliation for jobs and pipeline runs.
3. Qualify OpenCode and per-model discovery against live installs.
4. Make the two corpus tests hermetic (fixtures instead of an external directory).
5. Isolated worktrees for concurrent implement jobs.
