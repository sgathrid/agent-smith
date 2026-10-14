# Agent Smith <picture><source media="(prefers-color-scheme: dark)" srcset="docs/logo-options/hairline-icon-shades-dark.svg" /><source media="(prefers-color-scheme: light)" srcset="docs/logo-options/smith-shades-opencode-shadow.svg" /><img alt="" src="docs/logo-options/smith-shades-opencode-shadow.svg" height="45" align="center" /></picture>

**Run `codex`, `agy`, and `opencode` as native sub-agents inside Claude Code.**

Out of the box, Claude Code can only delegate to copies of itself. Agent Smith lets you spawn **Codex**, **agy**, **OpenCode**, and isolated **Claude** workers the exact same way you use a built-in Claude sub-agent: ask in plain English, watch them run live above your prompt and in Claude's native task list, follow up with them by name, and gate their work on real shell checks (`npm test`, `cargo check`) before Claude accepts the result.

```text
 ● Ada · codex review     reading src/pager.ts · 22 tools ·           02m18s
 ● Gus · agy implement    cargo test --workspace · 341 tools ·        12m04s
 ✓ Rae · codex review     finished · 2 files · checks 2/2 ·              48s
   +1 more · /forge
```

## Install

Requires **Node 22.18+**, **Claude Code**, and at least one worker CLI on your `PATH` (`codex`, `agy`, `opencode`, or `claude`).

**Inside a Claude Code session:**
```text
/plugin install agent-smith --marketplace sgathrid/agent-smith
```

**Or from your terminal:**
```sh
claude plugin install agent-smith --marketplace sgathrid/agent-smith
```

Restart Claude Code after installing so the live UI band, native task projection, and completion hooks load.

<details>
<summary><strong>Local clone & single-repo setup</strong></summary>

If you cloned this repository locally:

```sh
npm install
npm run build:plugin
```

- **Install user-wide + run `doctor`:** `npx . setup` (or `node scripts/agent-smith.mjs setup`)
- **Enable for this checkout only** (writes `.claude/settings.local.json` with `agent-smith@agent-smith`, cleans up legacy `agent-smith-dev` entries, and never touches `~/.claude`):
  ```sh
  npm run setup:claude
  ```
- **Enable for another repo only:**
  ```sh
  node scripts/agent-smith.mjs setup --local --repo /path/to/your/project
  ```
- **Verify detected worker CLIs:** `node scripts/agent-smith.mjs doctor`

</details>

## Quick Start

Talk to Claude the same way you would for a native sub-agent:

> **"Have Codex review the diff on this branch. Call the worker Ada. When she finishes, ask her for a failing input on her top finding."**

Or chain multiple agents together:

> **"Have agy implement 30-minute idle session expiry, have Codex review the diff, and have agy fix anything Codex flags. Gate it on `npm test`."**

What happens under the hood:
1. **Background spawn:** Claude checks `list_capabilities` and launches the worker in the background. No polling loops burning your context window.
2. **Native UI & task list:** The worker appears in Claude Code's task list and in the live status band above your prompt. Press `1`–`4` on an empty prompt (or run `/forge Ada`) to open its live transcript in the sidebar.
3. **Verified wake:** When the worker exits, Agent Smith records the git diff, runs your shell `checks`, and wakes Claude with a single status line:
   ```text
   Agent Smith · ✓ Ada (codex review) succeeded in 43s · 2 files changed · checks 2/2
   ```
4. **Stateful follow-up:** Claude reads the report and check verdicts via `status`, and can continue that worker's exact conversation thread by name via `resume_job`.

## Why Agent Smith

When you shell out to an external CLI in the background, **`exit 0` only tells you the process stopped.** It might have hit a headless permission denial and exited cleanly after doing nothing, timed out, or claimed *"All tests pass!"* without running a single test.

> [!IMPORTANT]
> **Execution is not acceptance.** Agent Smith treats every worker's summary as an untrusted claim. If a worker exits `0` with an empty response or blocked tool calls, it is marked `failed` (`✗ failed · suspicious success`). A job is only marked `accepted` when the shell `checks` you attach (`npm test`, `tsc --noEmit`, `cargo test`) actually pass after the worker exits.

## Core Workflows

### 1. Second Opinion + Follow-Up (`spawn_job` → `resume_job`)

Give a worker a `name` so Claude (or you) can follow up in the same native conversation thread:

```jsonc
// 1. Run a read-only review on Codex
spawn_job({
  "name": "Ada",
  "provider": "codex",
  "mode": "review",
  "prompt": "Review the changes on this branch for race conditions and missed edge cases."
})

// 2. Follow up with Ada in the same Codex conversation
resume_job({
  "worker": "Ada",
  "prompt": "Show a minimal reproducer for finding #2."
})
```

### 2. Test-Gated Implementation (`checks`)

The worker sees `checks` in its brief as its definition of done, and Agent Smith executes them after the worker exits:

```jsonc
spawn_job({
  "name": "Gus",
  "provider": "codex",
  "mode": "implement",
  "prompt": "Fix the off-by-one boundary in pager.ts and add a regression test.",
  "checks": [
    { "name": "typecheck", "command": "npm run typecheck" },
    { "name": "unit", "command": "npm test", "timeoutMs": 120000 }
  ]
})
```

### 3. Multi-Model Build → Review → Fix (`run_pipeline` + `continues`)

One model builds, another model family reviews in a read-only sandbox, and the original builder resumes its own conversation (`continues: "build"`) with the review findings to fix what was flagged:

```jsonc
run_pipeline({
  "spec": {
    "name": "session-expiry",
    "stages": [
      {
        "name": "build",
        "provider": "agy",
        "role": "implement",
        "prompt": "Expire idle sessions after 30 minutes."
      },
      {
        "name": "review",
        "provider": "codex",
        "role": "review",
        "dependsOn": ["build"],
        "prompt": "Review the diff for bugs, regressions, and missing tests."
      },
      {
        "name": "fix",
        "continues": "build",
        "role": "implement",
        "dependsOn": ["review"],
        "prompt": "Fix every defect raised in the review.",
        "checks": [{ "name": "tests", "command": "npm test" }]
      }
    ]
  }
})
```

## Live Terminal UI (`AbovePrompt` Band & `/forge`)

Active workers render as numbered rows right above your prompt—zero spinners, zero flicker, and invisible when idle.

| Key / Command | Action |
|---|---|
| `1`–`4` (empty prompt) | Open the sidebar directly on band row `1`–`4` |
| `/forge` | Open the sidebar on this session's workers |
| `/forge <name\|jobId>` | Open a specific worker's live transcript, diff, and check output |
| `/forge all` | Show all repository jobs across sessions (`a` / `s` toggles inside the list) |
| `t` (in worker view) | Show the full prompt sent to the worker, including the Agent Smith brief |
| `Enter` (on a tool row) | Inspect tool call input and output |
| `b` / `x` | Back to worker list / Close the sidebar |

## Modes, Sandboxes & Models

### Modes

A mode sets the worker's brief and sandbox posture—never the model.

| Mode | Purpose | Read-Only? | Runs Commands? |
|---|---|---|---|
| `implement` | Make focused code changes small enough to review | No | Yes |
| `review` | Find defects, regressions, and unsupported claims without editing files | Yes | No |
| `moderate` | Independently verify or refute earlier work and reviewer claims | Yes | No |
| `verify` | Run verification commands and report exact outcomes without editing | No | Yes |

### Sandboxing & Permissions

Workers do not inherit your Claude Code session's permissions. Each runs under its own CLI harness defaults:

| Provider | Default Sandbox Posture | Read-Only Enforcement (`review` / `moderate`) |
|---|---|---|
| **`codex`** | `-s workspace-write` (writes restricted to workspace) | Enforced by sandbox (`-s read-only`) |
| **`claude`** | `--permission-mode dontAsk --permission-prompts none` | Enforced (`--disallowedTools Edit Write NotebookEdit` + read-only shell allowlist) |
| **`opencode`** | Harness default permission rules | Prompt instruction (`readOnlyEnforced: false`) |
| **`agy`** | Unrestricted by default (headless `agy` cannot prompt and silently refuses tools otherwise; pass `unrestricted: false` or `AGENT_SMITH_AGY_RESTRICTED=1` to restrict) | Prompt instruction (`readOnlyEnforced: false`) |

Passing `unrestricted: true` to `codex`, `claude`, or `opencode` asks for confirmation in Claude Code before launching (disable in headless automation with `AGENT_SMITH_CONFIRM_UNRESTRICTED=0`). To keep parallel `implement` workers from stepping on each other's uncommitted edits, point each at its own git worktree via `cwd`.

### Dynamic Model Discovery & `models.json`

Agent Smith ships **no hardcoded model list**. It queries your installed CLIs (`codex debug models`, `agy models`, `opencode models`, and local config files) so new models work immediately.

> [!NOTE]
> For ordinary Claude sub-agents, Claude Code uses its built-in `Agent` tool by default. It only uses Agent Smith's `claude` provider when a Claude worker needs executable `checks`, a stage in a pipeline, a named conversation to `resume_job` later, or isolated permissions.

You can optionally define model aliases or per-mode defaults in `<repo>/.agent-smith/models.json` or `~/.agent-smith/models.json`:

```json
{
  "aliases": {
    "fast": { "provider": "codex", "model": "gpt-5-mini", "effort": "low" },
    "deep": { "provider": "codex", "effort": "high" }
  },
  "roleDefaults": { "review": "deep", "moderate": "deep" }
}
```

## MCP Tools & Standalone CLI

| MCP Tool | What it does |
|---|---|
| `spawn_job` | Launch a named background worker (`implement`, `review`, `moderate`, `verify`) with optional `context`, `cwd`, `model`, `effort`, and `checks`. |
| `resume_job` | Follow up with a finished worker by `name` or `jobId`, continuing its native conversation. |
| `run_pipeline` | Run a multi-stage DAG of workers with per-stage `checks`, artifact handoffs, and `continues` loops. |
| `status` | Read a job's state, worker report, `acceptance` check results, `changedFiles`, and optional git `diff` (`include_diff: true`). |
| `pipeline_status` | Read per-stage statuses, acceptance verdicts, and artifacts for a pipeline run. |
| `list_jobs` | List running and recent jobs (filtered by `status`, `since`, `session`). |
| `list_capabilities` | Discover installed provider CLIs, available models, effort levels, and configured aliases. |
| `cancel` | Cancel a running job or pipeline. |

Every feature also works directly from your shell via the standalone CLI:

```sh
node scripts/agent-smith.mjs doctor
node scripts/agent-smith.mjs run implement --provider codex --name Ada --prompt "Fix pager.ts" --check "npm test"
node scripts/agent-smith.mjs resume Ada --prompt "Add an edge-case test for empty pages"
node scripts/agent-smith.mjs run ./the-codes/cli/pipeline.example.yaml
node scripts/agent-smith.mjs ls --status running
node scripts/agent-smith.mjs status <jobId-or-runId>
node scripts/agent-smith.mjs cancel <jobId-or-runId>
node scripts/agent-smith.mjs gc --older-than 14d        # archive old settled jobs (--dry-run, --delete)
```

All job state is stored as plain files in `<repo>/.agent-smith/jobs/<jobId>/` (`job.json`, `progress.json`, `events.jsonl`, `result.md`, `acceptance.json`).

## Troubleshooting

- **Provider shows as unavailable:** The MCP server inherits the `PATH` of the shell that launched Claude Code. Restart Claude Code where `codex` / `agy` / `opencode` / `claude` is on `PATH`, or set `AGENT_SMITH_CODEX_BIN`, `AGENT_SMITH_AGY_BIN`, `AGENT_SMITH_OPENCODE_BIN`, or `AGENT_SMITH_CLAUDE_BIN`.
- **Claude isn't woken when a job finishes:** Restart Claude Code after installing the plugin. When the fallback hook wakes Claude, Claude Code labels the message *"Stop hook feedback"*—that label is normal host behavior, not an error.
- **Worker failed with denied actions:** The worker hit a sandbox limit. Check `nextAction` in `status`; if appropriate, re-run or resume with `unrestricted: true`.
- **Job timed out or orphaned:** Default timeout is 45 minutes (`timeoutMs` up to 6 hours). If a supervising process dies, Agent Smith marks the job `failed (orphaned)` instead of leaving it stuck on `running`.

## Development & Docs

```sh
npm install
npm run verify          # Typecheck + test suite (uses fake CLIs, zero token spend)
npm run smoke           # End-to-end MCP smoke test against fake Codex and agy CLIs
npm run build:plugin    # Bundle self-contained plugin into builds/local-plugin/agent-smith
npm run setup:claude    # Build, validate, and enable in .claude/settings.local.json
```

- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — MCP tool schemas, environment variables, timeouts, and `models.json`.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Job directory format, status derivation, orphan recovery, and notifications.
- [the-codes/surfaces/mod/README.md](the-codes/surfaces/mod/README.md) — `AbovePrompt` worker band and `/forge` sidebar internals.

MIT licensed.
