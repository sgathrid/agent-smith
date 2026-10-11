# Using Agent Smith

Start with the [README](../README.md#get-started) to install Agent Smith in your project. This guide covers other ways to launch it and details you may need while working.

## Launch for one session

From your Agent Smith checkout, build the server and launch Claude in your project:

```sh
npm run build
./dev.sh --repo /absolute/path/to/project
```

This loads the MCP tools and Forge for that session. It does not enable the plugin persistently in the project. This route has no completion hook; Claude must request job status. The installed plugin described in the README includes the hook.

## Choose a model

Ask Claude which workers and models are available. Agent Smith uses provider discovery, including cached or static catalogs where needed. Leave the model unspecified to use the worker CLI's configured default.

For example:

> Have a Claude worker using Sonnet review this branch. Call it Rae.

Use an optional `models.json` to name recurring choices or set defaults by mode. See the [model configuration](CONFIGURATION.md#modelsjson-aliases-and-per-mode-defaults).

## Worker modes

The mode describes the task; it does not choose the model.

| Mode | Task |
|---|---|
| `implement` | Make a change and report what changed. |
| `review` | Find defects, missed cases, and unsupported claims without editing. |
| `moderate` | Independently probe earlier work and reviewer findings without editing. |
| `verify` | Run checks and report what happened. |

## Worker permissions

Workers use their own CLI permissions. They do not inherit the permissions of the coordinating Claude session.

| Provider | Default behavior |
|---|---|
| Codex | Workspace-write sandbox; read-only sandbox for review and moderate modes. |
| Claude | Cannot prompt for approval. Review and moderate modes add an inspection-tool allowlist and deny editing tools. |
| agy | Unrestricted, because its headless CLI cannot prompt for approval. Review and moderate modes request no edits but do not enforce read-only access. |
| OpenCode | Uses its configured permission rules. Review and moderate modes request no edits but do not enforce read-only access. Support is provisional. |

For agy, pass `unrestricted: false` or set `AGENT_SMITH_AGY_RESTRICTED=1` to keep approval restrictions. Unapproved tools may then be denied. For other providers, `unrestricted: true` enables the provider's approval-bypass behavior.

The job acknowledgement reports `sandbox` and `readOnlyEnforced` for the actual invocation, including overrides. Codex uses a filesystem sandbox; Claude's restrictions operate through its tools. See [permission configuration](CONFIGURATION.md#harness-default-sources) for provider details.

Workers operate in the directory you give them. Use separate git worktrees for parallel workers that edit files.

## Attach acceptance checks

A check is a command Agent Smith runs after successful worker execution. In a `spawn_job` call, the `checks` parameter can contain:

```json
[
  { "name": "tests", "command": "npm test", "timeoutMs": 300000 }
]
```

Checks run in the worker's directory unless you specify another directory. Blocking checks decide whether the result is `accepted` or `rejected`. Without checks, it is `unchecked`. A check with `"blocking": false` reports its outcome without deciding acceptance.

See the [tool reference](CONFIGURATION.md#mcp-tools) for complete `spawn_job` and `run_pipeline` parameters.

## Follow up or cancel

Ask Claude to follow up with a finished worker by name or job ID. The worker retains its conversation; a follow-up creates a new job record. Running workers cannot receive follow-ups. You can cancel them instead.

## Inspect and clean up job records

Each job has a directory under `.agent-smith/jobs/` containing its state, progress, result, and logs. Attached checks have an `acceptance.json` record. Pipelines live under `.agent-smith/pipelines/`.

From the Agent Smith checkout, preview archiving finished jobs older than 14 days:

```sh
node scripts/agent-smith.mjs gc --repo /absolute/path/to/project --dry-run
```

Remove `--dry-run` to move those jobs into `.agent-smith/archive/`. Add `--delete` only if you want to discard them instead.

## Troubleshooting

### A worker is unavailable

Confirm its CLI is installed and authenticated. The server inherits the `PATH` of the process that launched Claude. Restart Claude after changing it, or set the matching binary path: `AGENT_SMITH_CODEX_BIN`, `AGENT_SMITH_OPENCODE_BIN`, `AGENT_SMITH_AGY_BIN`, or `AGENT_SMITH_CLAUDE_BIN`.

### Completion notices do not arrive

The completion hook loads with the built, installed plugin. Restart Claude after setup or a rebuild. Temporary `dev.sh` sessions and other clients can use `status` with `wait_ms` or `pipeline_status`. The launch acknowledgement also includes a monitor command when available.

Very long jobs have not been validated against the host's completion-hook time limits.

### A worker produced no useful result

Read its failure reason, denied actions, and `nextAction`. Agent Smith treats an empty successful reply as a failure. Fix the reported cause before rerunning; approval bypass grants the worker broader permissions.

### A job times out

The default job budget is 45 minutes. Increase `timeoutMs` or split the task. Jobs whose recorded supervising process has died are reported as failed rather than left running.
