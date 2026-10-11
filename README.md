# Agent Smith

Run Codex, OpenCode, and agy workers from Claude Code.

Ask Claude to delegate a task, watch the worker in `/forge`, and follow up with the same worker when it finishes. Each worker runs through its own command-line tool, using its own model and permissions.

> Have Codex review the changes on this branch. Call the worker Ada and ask for concrete bugs with failing examples.

## What you can do

- Use another agent to implement a change or give you a second opinion.
- Watch worker activity, results, and checks together in `/forge`.
- Follow up by name without starting the worker's conversation over.
- Chain implementation and review, with tests or lint commands attached to each stage.

## Get started

You need **Node.js 22.18 or later**, **Claude Code**, and an installed, authenticated worker CLI: `codex`, `agy`, `opencode`, or `claude`. You can use Claude itself as a worker; a second provider is optional.

Clone Agent Smith and install its dependencies:

```sh
git clone https://github.com/sgathrid/agent-smith.git
cd agent-smith
npm install
npm --prefix the-codes/surfaces/channel install
```

Build and enable the plugin in the project you want to work on. Replace `/absolute/path/to/project` with that project's directory:

```sh
npm run setup:claude -- --repo /absolute/path/to/project
cd /absolute/path/to/project
claude
```

Setup adds Agent Smith to that project's local Claude settings. Keep the Agent Smith checkout in place: the plugin loads from it. To work on Agent Smith itself, run `npm run setup:claude` without `--repo`.

In Claude, run `/mcp` to confirm Agent Smith is connected. Then ask:

> Which Agent Smith workers are available?

Pick an available provider and try the review prompt above. Open `/forge` to see the worker's activity. When it finishes, Claude receives a completion notice and can read its findings.

## Watch with Forge

`/forge` opens the worker panel above your prompt. Select a worker to see its activity, original task, result, and checks. Active work and completed history have separate tabs.

Press **Ctrl+X, then Tab** to focus the panel. **Escape** returns you to the prompt. See the [Forge controls](the-codes/surfaces/mod/README.md#canonical-tracking) for navigation and shortcuts.

## Try these workflows

### Make a change and check it

> Have Codex fix the off-by-one error in pager.ts and add a regression test. Attach `npm test` as a blocking acceptance check.

Agent Smith runs the attached command after the worker succeeds and reports whether it passed. Without attached checks, the result is marked `unchecked`.

### Get another agent to review it

> Set up a pipeline: Codex implements idle-session expiry after 30 minutes, with `npm test` as a blocking check. Then a Claude worker reviews the change for bugs and missing tests.

### Follow up with the same worker

> Ask Ada to explain its most serious finding with a failing input.

Follow-ups retain the worker's conversation. Wait for it to finish before sending a follow-up.

## How it works

The plugin gives Claude tools to start, inspect, resume, and cancel external workers. Workers run locally in the directory you give them. Job records and results live in `.agent-smith/jobs/` inside your project.

Worker completion and acceptance are separate: a finished worker has produced a result; attached checks determine whether it passes your requirements.

Codex, Claude, and OpenCode use restricted permissions by default. **agy runs unrestricted by default** because its headless CLI cannot ask for approval. Read the [worker permissions](docs/USAGE.md#worker-permissions) before using it. OpenCode support is provisional pending validation with a working account. Give parallel workers separate git worktrees when they will edit files.

## Documentation

- [Usage and troubleshooting](docs/USAGE.md): temporary sessions, models, permissions, checks, and job cleanup.
- [Configuration reference](docs/CONFIGURATION.md): tool parameters, model aliases, and environment variables.
- [Architecture](docs/ARCHITECTURE.md): execution, storage, and pipeline design.
- [Smoke testing](docs/SMOKE.md): validation with fake and live providers.

## Development

```sh
npm run verify          # Typecheck and test
npm run smoke           # Exercise MCP with fake worker CLIs
npm run build:plugin    # Rebuild after source changes; restart Claude
```

The default tests and smoke test use fake CLIs and consume no model quota. See [delivery status](PROGRESS.md) for project progress, or [open an issue](https://github.com/sgathrid/agent-smith/issues) for help or a bug report.

MIT licensed.
