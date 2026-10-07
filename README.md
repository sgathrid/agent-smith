# Agent Smith

Delegate coding work from Claude Code to the **actual Codex, OpenCode, agy, or
Claude harness**, then observe and follow up with the worker. Agent Smith replaces
agy-staff execution; the agy-staff reader and state mirror support existing history
and the terminal plugin. No agy-staff installation is required to run workers.

## Start a Claude session

Use Node 22.18+ (or a current Node 24/26 release) and an authenticated worker CLI.
The Claude mod API also requires a compatible Claude Code release; this repository
is verified against 2.1.292.

For development in **this repository**, enable a self-contained local plugin:

```sh
npm install
npm --prefix the-codes/surfaces/channel install
npm run setup:claude
claude
```

Run these commands from the repository root. Setup builds the UI, MCP runtime,
dependencies, delegation skill, and completion hook into
`builds/local-plugin/agent-smith`, then declares this checkout's directory
marketplace in `.claude/settings.local.json`. Existing local settings are
preserved. Setup writes no user settings or global enablement. Claude itself
maintains its marketplace registry and plugin data under `~/.claude/plugins`;
the plugin is enabled only for this checkout and its files load in place. Re-run
setup if you move the checkout; run `npm run build:plugin` after source changes
and restart Claude to load the new hook.

Project/local settings cannot set `CLAUDE_CODE_PLUGIN_DIRS`. Putting the plugin
in the project's `.claude/skills/` would suppress its completion hook; the
local marketplace avoids both limitations.

Completion is announced by a job-scoped `PostToolUse` command hook
(`asyncRewake`, declared in `hooks/watch-hooks.json`) that runs
`runtime/dist/watch-hook.js` after `spawn_job`, `run_pipeline` or `resume_job`.
It watches only that job or run, exits 2 when it finishes or needs attention to
wake Claude, and nothing runs while idle. This replaces the former always-on
plugin monitor, which appeared in Claude's exit dialog and polled forever.
Fallbacks when hooks are unavailable (headless `-p`, other clients): run the
ack's `notify.monitorCommand` (`node runtime/dist/monitor.js --job <id> --cwd
<repo>`, or `--run <id>`) under the Monitor tool with a timeout of at most
1,800,000 ms and re-arm on expiry, or use `status` with `wait_ms` /
`pipeline_status`. Unverified: whether a running async hook shows in the exit
dialog, whether the hook timeout cap accommodates 45-minute jobs (set to 2760 s),
and waking while Claude is mid-turn. `/forge` opens the right-third job pane. `/forge` opens the right-third job pane.

The `.claude` under `agent-configs/` is a configuration example, not an active
root configuration. Claude does not read it when launched from this repo root.
The setup above uses the root `.claude` without relocating that example.

For a session in **another project**, use the session-scoped launcher:

```sh
npm install
npm --prefix the-codes/surfaces/channel install
npm run build
/path/to/agent-smith/dev.sh --repo /path/to/your/project
```

This loads the MCP control tools and the `/forge` pane for this session. It does
not install a global plugin or modify your Claude settings. Add `--channels` to
opt into the development channel for completion and attention notifications:

```sh
/path/to/agent-smith/dev.sh --repo /path/to/your/project --channels
```

Channels are a Claude research preview and may be unavailable under organization
policy. The MCP tools still work without notifications: use `status` or
`pipeline_status`. The terminal UI continues to show progress.

Ask Claude to delegate, specifying the worker name, harness, model, and task:

> Use Agent Smith to start a Codex worker named Ada, with my available Codex model,
> to review the authentication changes. Keep it restricted. Follow up with Ada
> after reading its findings.

## Tools and worker identity

- `spawn_job`: start a named external worker and return immediately.
- `list_jobs`, `status`: inspect its task, role, activity, latest summary, report,
  conversation handle, and lifecycle.
- `resume_job`: address a completed worker by job ID or unambiguous name. A new
  invocation retains the worker identity and resumes its harness conversation.
- `cancel`: request cancellation of a job or pipeline run.
- `run_pipeline`, `pipeline_status`: run and inspect a mixed-harness DAG.

A worker has a human name and stable `workerId`; each invocation has a separate
`jobId`. Pipeline runs have their own unique `runId`. Names are labels, not native
Claude agent addresses. Follow-up to an active CLI invocation is rejected: live
steering is not implemented by these subprocess adapters.

Live summaries are bounded excerpts of actual worker assistant output, labeled
with `summarySource: "worker"`. They are not an orchestrator's clinical or technical
conclusions. Routine output stays in the UI; completion and attention notifications
include a bounded excerpt. Full reports and original event logs remain on disk.

## Permissions and acceptance

Workers use their harness's restricted configuration by default. This is not
inheritance of the parent Claude session's permission rules. Codex uses its
workspace-write sandbox; Claude uses noninteractive permission denial; agy and
OpenCode have their own configured permissions. `unrestricted: true` explicitly
requests the provider's bypass mode. A denied, malformed, empty, timed-out, or
cancelled run is not successful execution.

Successful execution alone does not prove the task is correct. Configure stage
`checks` to gate acceptance with executable commands. A stage without checks has
`acceptance: "unchecked"`. Review prose is evidence for the supervising agent;
Agent Smith does not infer an approval verdict from it.

Workers operate in the requested working tree. Parallel editing stages share it;
use separate worktrees via stage `workDir` when edits must be isolated. Artifacts
are separate from the source tree, under a unique run directory. A worker-written
artifact is preserved; its final chat summary is only a fallback when no artifact
was produced.

## Optional CLI

The CLI is a thin adapter over the same forge service and state as MCP:

```sh
node scripts/agent-smith.mjs doctor
node scripts/agent-smith.mjs run implement --name Ada --provider codex \
  --model YOUR_AVAILABLE_MODEL --effort high --prompt 'Implement the requested fix' \
  --check 'npm test' --foreground
node scripts/agent-smith.mjs ls
node scripts/agent-smith.mjs status RUN_ID_OR_JOB_ID
node scripts/agent-smith.mjs resume Ada --prompt 'Address the failing edge case' --foreground
node scripts/agent-smith.mjs cancel RUN_ID_OR_JOB_ID
node scripts/agent-smith.mjs run the-codes/cli/pipeline.example.yaml --foreground
```

Without `--foreground`, the CLI starts a detached supervisor. Run `--help` for the
current flags. `doctor` reports installed binaries, not authentication or model
availability. Model IDs come from the user's provider configuration; this project
never promises that a particular account can run a particular model.

## State and boundaries

`.agent-smith/jobs/<jobId>/` holds the canonical manifest, progress, events, result,
report, and cancel request. `.agent-smith/pipelines/` holds run records and isolated
artifacts. A compatibility projection lives in `.agy-staff/jobs/` for the terminal
plugin. Both directories are local and ignored by git.

Job cancellation reaches the owning supervisor through a persistent request and
signals the worker process group on Unix. If its supervisor dies, records can
remain running; the watcher flags prolonged silence as needing attention.
Cancellation needs a live supervisor. Crash reconciliation and automatic replay
are not implemented.

The plugin can project external workers into Claude's native task list where the
host supports those tools. External harness conversations remain external; they
are not Claude Agent loops, native teammates, or targets for native SendMessage.
Use Agent Smith's resume tool for follow-ups.

OpenCode's successful event stream remains provisional until qualified against a
working configured account. Automated verification uses fake CLIs through the
real process and MCP boundaries; it does not consume model quota.

## Development

```sh
npm run verify
npm run test:plugin
npm run build
```

Luna agents may implement separate seams, but the primary developer owns final
integration and protocol verification. See [PROGRESS.md](PROGRESS.md) for delivery
status and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for runtime ownership.

## Model aliases

Optional; no presets ship. Define aliases in `<repo>/.agent-smith/models.json` or
`~/.agent-smith/models.json` (`AGENT_SMITH_HOME` overrides home):
`{"aliases":{"sol-high":{"provider":"codex","model":"gpt-6.1-sol","effort":"high"}},"roleDefaults":{"review":"sol-high"}}`.
Pass an alias as `model`. Precedence: explicit call args > project file > user file.
A project alias replaces a same-named user alias wholesale. `roleDefaults` (implement,
review, moderate, verify) apply only when a call names no provider or model. An explicit
provider that conflicts with the alias's provider is an error.

MIT licensed.
