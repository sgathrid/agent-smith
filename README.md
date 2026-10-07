# Agent Smith

Agent Smith lets Claude Code delegate work to the real Codex, OpenCode, agy and
Claude CLIs, watch the workers, and follow up with them. It runs as a Claude Code
plugin with an MCP server (8 tools) and a `/forge` pane.

The problem it addresses: an external worker exiting 0 does not mean the task is
done. Agent Smith keeps execution status ("did the process finish cleanly")
separate from acceptance ("did your checks pass"). Acceptance comes from
executable checks you attach, not from the worker's own report. Denied, empty,
malformed, timed-out and cancelled runs are never reported as success. Worker
output (summaries, reports) is treated as untrusted data, never as instructions.

## Quick start

Prerequisites:

- Node 22.18 or newer.
- Claude Code. The mod API used by the pane is verified against 2.1.292.
- At least one authenticated worker CLI on `PATH`: `codex`, `opencode`, `agy` or `claude`.

Install and build from the repository root:

```sh
npm install
npm --prefix the-codes/surfaces/channel install
```

Then pick one launch path.

**This repo (persistent, project-scoped): `npm run setup:claude`**

```sh
npm run setup:claude
claude
```

This builds a self-contained plugin (UI, MCP runtime, delegation skill, completion
hook) into `builds/local-plugin/agent-smith`, validates it, and registers this
checkout as a directory marketplace in `.claude/settings.local.json`. Existing
local settings are preserved; no user or global settings are written. Re-run it if
you move the checkout. After source changes run `npm run build:plugin` and restart
Claude so the rebuilt plugin and hook load.

**Any other project (session-scoped): `dev.sh`**

```sh
npm run build
/path/to/agent-smith/dev.sh --repo /path/to/your/project
/path/to/agent-smith/dev.sh --repo /path/to/your/project --channels
```

`dev.sh` launches `claude` for that session only, with `--plugin-dir` (the pane
and skill) and `--mcp-config` (the MCP server). It installs nothing and modifies
no Claude settings. `--repo` defaults to the current directory; other flags are
passed through to `claude`. `--channels` adds
`--dangerously-load-development-channels server:agent-smith`, an opt-in
development channel (a Claude research preview, possibly blocked by organization
policy). The `dev.sh` path has no plugin hook, so completion notices come from the
channel if enabled; otherwise use `status` with `wait_ms`.

First delegation:

> Use Agent Smith to start a Codex worker named Ada to review the authentication
> changes. Keep it restricted. Follow up with Ada after reading its findings.

Claude should call `list_capabilities`, then `spawn_job`, and be woken when the
job finishes.

## What you get

| Tool | Purpose |
|---|---|
| `list_capabilities` | Installed providers, their discovered models, efforts and defaults, aliases, and the valid modes. `refresh: true` bypasses the discovery cache. |
| `spawn_job` | Start one named worker (`mode`, `prompt`, optional `provider`, `model`, `effort`, `checks`, `timeoutMs`, `unrestricted`); returns an ack immediately. |
| `resume_job` | Send a follow-up to a finished worker by name or job ID, keeping its harness conversation. Refuses running or ambiguous workers. |
| `status` | Read one job: lifecycle, summary, report, acceptance, `nextAction`, changed files. `wait_ms` (1 to 60000) long-polls a running job. |
| `list_jobs` | List workers and their latest worker-written summaries; filter by provider source, status, limit. |
| `cancel` | Request cancellation of a job or a pipeline run. Check `status` afterwards. |
| `run_pipeline` | Run a multi-stage DAG across harnesses with per-stage checks; returns a run ID. |
| `pipeline_status` | Persisted state and acceptance results of one run. |

A worker has a name and a stable `workerId`; each invocation has its own `jobId`.
Pipeline runs have a `runId`. Names are labels, not native Claude agent addresses.
The `spawn_job` ack includes `sandbox`, `readOnlyRequested`, `readOnlyEnforced`,
`modelRequested`, `modelResolved`, `modelSource`, `timeoutMs`, `unrestricted`,
`warnings` and a `notify` hint.

## Concepts

### Modes

A job `mode` is one of four. A mode sets only a prompt preamble and a sandbox
posture; it never picks a provider or model.

| Mode | Preamble gist | Read-only requested |
|---|---|---|
| `implement` | Do the work and report what changed and found. | no |
| `review` | Report defects, missed cases and unsupported claims; do not edit. | yes |
| `moderate` | Probe prior work independently; findings only, do not edit. | yes |
| `verify` | Run the checks and report what actually happened. | no |

Read-only is enforced only where the provider's CLI can enforce it. Today that is
Codex (`-s read-only`); for agy, OpenCode and Claude the request is made through
the prompt but not enforced. The ack's `readOnlyEnforced` tells you which case you
got, so do not assume a review worker cannot write. `unrestricted: true` turns
read-only off.

### Providers and model discovery

`list_capabilities` asks each installed harness for its models (cached for 5
minutes per provider, stale-on-error, 10 s timeout each). It reports, per
provider: `models` with the efforts each accepts, `defaultModel`/`defaultEffort`,
and `defaultSource` (`harness-config` when the default was read from that
harness's own configuration, `unknown` otherwise), plus `source`, `stale`,
`verified` and any `error`. Uninstalled providers appear with `available: false`.

If you omit `model` and `effort`, the harness uses its own configured default;
Agent Smith ships no model lists or presets. If a requested model is not what the
harness resolves, the ack's `modelSource` (`requested`, `harness-config`,
`reported`, `unknown`) and `warnings` say so. If `provider` is omitted,
`spawn_job` uses the first available provider.

Efforts: `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; each model lists the
subset it accepts.

### Aliases and models.json

Optional, and nothing ships by default. Define aliases in
`<repo>/.agent-smith/models.json` (project) or `~/.agent-smith/models.json`
(user; `AGENT_SMITH_HOME` overrides the home directory). Both are gitignored here.

```json
{
  "aliases": {
    "sol-high": { "provider": "codex", "model": "gpt-6.1-sol", "effort": "high" }
  },
  "roleDefaults": { "review": "sol-high" }
}
```

- Alias names match `[a-z0-9][a-z0-9._-]*`; `provider` is required, `model` and `effort` optional.
- Pass an alias as `model`. It supplies the provider, model and effort.
- Precedence: explicit call arguments, then the project file, then the user file.
  A project alias replaces a same-named user alias wholesale (no field merging).
  An explicit `effort` on the call overrides the alias's effort.
- `roleDefaults` (keys: `implement`, `review`, `moderate`, `verify`) apply only
  when the call names neither provider nor model. A default pointing at an
  unknown alias is ignored and reported.
- An explicit `provider` that conflicts with the alias's provider is an error.
- Invalid files are reported in `list_capabilities` as `aliasConfigErrors`.
- Aliases also work in `run_pipeline` stages and `resume_job`.

### Acceptance

Execution status (`running`, `succeeded`, `failed`, `canceled`) and acceptance are
separate fields. Pass `checks` to `spawn_job` or to a pipeline stage:

```json
{ "name": "tests", "command": "npm test", "cwd": ".", "timeoutMs": 300000, "blocking": true }
```

Once the job succeeds the checks run in its working directory and `status` reports
`acceptance` as `accepted` or `rejected`. A job that does not succeed is rejected.
With no checks, acceptance is `unchecked`. Agent Smith never infers an approval
verdict from review prose; the supervising agent reads it as evidence. Summaries
and reports are worker-written claims: verify them with checks or the diff.

### Notifications

Completion is announced by a job-scoped `PostToolUse` command hook with
`asyncRewake`, declared in the built plugin's `hooks/watch-hooks.json` and
matching `spawn_job`, `resume_job` and `run_pipeline`. It runs
`runtime/dist/watch-hook.js`, which watches only that job or run, and exits 2
when it finishes or needs attention, which wakes Claude with a short excerpt. The
watch budget is the job's own timeout plus a minute (up to the 6-hour cap), and the
hook timeout is set to 21 900 s. Nothing runs
while idle; this replaced an earlier always-on plugin monitor.

Fallbacks when hooks are unavailable (headless `-p`, other clients): run the
ack's `notify.monitorCommand` under the Monitor tool (its `monitorTimeoutMs` is
capped at 1,800,000 ms; re-arm on expiry), or call `status` with `wait_ms`, or
`pipeline_status`.

### Failure hints, changed files, orphans

- `status` includes a derived `nextAction` for bad terminal states: orphaned
  supervisor (resume or rerun), denied actions (retry with `unrestricted: true` or
  give an approved path), timeout (raise `timeoutMs` or split the task), network
  errors (retry once), empty output (ask via `resume_job` or rerun).
- Terminal manifests carry `changedFiles` (and `changedFilesTruncated`) computed
  against a baseline. It is evidence, not attribution: parallel workers in one
  tree can see each other's edits. Read-only modes normally yield `[]`.
- If a job's supervisor process exits before the job finishes, the job is marked
  `orphaned` rather than left running. Crash reconciliation and automatic replay
  are not implemented.

### Permissions and isolation

Workers start with their harness's restricted configuration, not the parent
Claude session's permission rules: Codex workspace-write, Claude noninteractive
permission denial, OpenCode its configured permissions. `unrestricted: true`
requests the provider's bypass mode. **agy is the exception:** headless agy cannot
prompt and silently auto-denies tools, so it defaults to
`--dangerously-skip-permissions`. Pass `unrestricted: false` (or set
`AGENT_SMITH_AGY_RESTRICTED=1`) to keep agy restricted. Workers
edit the requested working tree; use a stage `workDir` (for example a separate git
worktree) to isolate parallel editors. Default job budget is 45 minutes.

## Example sessions

Delegate with checks:

```
list_capabilities {}
spawn_job { "mode": "implement", "name": "Ada", "provider": "codex",
            "prompt": "Fix the off-by-one in pager.ts and add a test.",
            "checks": [{ "name": "tests", "command": "npm test" }] }
-> { jobId, status: "running", readOnlyEnforced: false, notify: {...} }
   (hook wakes Claude on completion)
status { "jobId": "<jobId>" }
-> status: "succeeded", acceptance: "accepted", changedFiles: ["pager.ts", ...]
```

Review pipeline:

```
run_pipeline { "spec": { "name": "auth-fix", "task": "Harden session expiry",
  "stages": [
    { "name": "build",  "provider": "agy",    "role": "implement", "prompt": "..." },
    { "name": "review", "provider": "codex",  "role": "review", "dependsOn": ["build"],
      "prompt": "Review the changes." }
  ] } }
-> { runId, stages: [...], started: true }
pipeline_status { "runId": "<runId>" }
```

Omit `stages` and defaults are derived from installed providers (implement on agy,
review on codex, moderate on claude, using their own configured models).

Alias usage and follow-up:

```
spawn_job { "mode": "review", "name": "Rae", "model": "sol-high",
            "prompt": "Review the diff on this branch." }
resume_job { "worker": "Rae", "prompt": "Explain finding 2 with a failing input." }
```

## The /forge pane

`/forge` opens a right-third pane listing worker jobs; selecting one opens a
detail view with its task, tool history, current activity, warnings and final
report (the report is shown only there). A one-to-four line band above the prompt
shows one live line per running job (activity, tool count, elapsed time), with
glyphs for running, stalled, finished, failed and canceled. It renders nothing
when there is nothing to show. See `the-codes/surfaces/mod/README.md` for the band.

## Repo layout

```
dev.sh                    session-scoped launcher
scripts/                  agent-smith.mjs (CLI entry), build-plugin.mjs, setup-local-claude.mjs
the-codes/
  core/ forge/            job store, forge service, modes, checks, acceptance
  providers/              codex, opencode, agy, claude adapters, catalog, aliases
  harness/ pipeline/      history readers, DAG runner
  cli/                    CLI and pipeline.example.yaml
  verify/                 verification gate and checks
  surfaces/channel/       MCP server, tools, watch hook, monitor
  surfaces/mod/           /forge pane, band, delegate skill
docs/                     ARCHITECTURE.md, CONFIGURATION.md
agent-configs/            shared configuration examples (not an active config)
```

State is local and gitignored: `.agent-smith/jobs/<jobId>/` (manifest, events,
result, report) and `.agent-smith/pipelines/`, plus a compatibility projection in
`.agy-staff/jobs/` for the terminal plugin.

An optional CLI over the same service is `node scripts/agent-smith.mjs`
(`doctor`, `run`, `ls`, `status`, `resume`, `cancel`; `--help` lists flags).
Details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Development

| Script | Does |
|---|---|
| `npm run verify` | `tsc --noEmit` then the full test suite |
| `npm test` | Node test runner over `the-codes/**/*.test.ts` and `*.node-test.ts` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Compile the channel/MCP server to `the-codes/surfaces/channel/dist` |
| `npm run build:plugin` | Build, then stage the plugin in `builds/local-plugin/agent-smith` |
| `npm run test:plugin` | `claude plugin validate` and `claude plugin test` on the mod |

Tests sit beside code in `__tests__/` directories or as `*.test.ts`; the mod uses
`*.node-test.ts`. Automated provider tests use fake CLIs through the real process
and MCP boundaries and consume no model quota.

Known environmental failures: two tests in
`the-codes/surfaces/mod/tests/jobs.node-test.ts` ("the real corpus resolves..." and
"the real corpus exercises the tool count...") read a machine-local corpus of
agy-staff jobs at `/Users/gathrid/Repos/renyi/.agy-staff/jobs`. They skip when
that directory is absent, but fail on a machine where it exists with different
contents (observed here: a corpus job lacking a tool count). Other tests do not
depend on it.

## Troubleshooting

- **Providers show unavailable:** the MCP server could not find the binary. Restart
  Claude so the rebuilt plugin loads, and check the `PATH` of the environment that
  launched Claude (the MCP server inherits it). Binary names can be overridden with
  `AGENT_SMITH_{CODEX,OPENCODE,AGY,CLAUDE}_BIN`.
- **No completion wake:** the hook only exists in the built plugin
  (`setup:claude`); `dev.sh` has none. Run `npm run build:plugin` and restart after
  source changes. In headless `-p` or other clients hooks may be unavailable; use
  the Monitor fallback or `status` with `wait_ms`. Putting the plugin under
  `.claude/skills/` would suppress its hook.
- **Exit dialog:** a running async hook may appear when you exit Claude while a job
  is in flight; see limitations.
- **agy returns nothing or is denied:** agy cannot prompt, so unapproved tools are
  auto-denied and it can exit 0 with an empty response. Agent Smith treats denied
  actions as a failure (`status` shows `nextAction`). Retry with `unrestricted: true`
  (agy `--dangerously-skip-permissions`) only if you accept the risk.

## Status and known limitations

Unverified: whether a running async hook shows in Claude's exit dialog; whether the
hook timeout of 21 900 s (6 h 5 min) is honored for long jobs; waking Claude while it
is mid-turn. OpenCode's successful event stream is provisional until qualified
against a working account.

Not built: `job://` resources, MCP Tasks vocabulary, a separate permission-level
field, live steering of a running CLI invocation (resume works only on finished
workers), crash reconciliation and automatic replay.

See [PROGRESS.md](PROGRESS.md) for delivery status. MIT licensed.
