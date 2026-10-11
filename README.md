# Agent Smith

Claude Code is good at delegating. Until now it could only delegate to copies of
itself. Agent Smith lets it hand work to Codex, OpenCode, agy and other Claude
models as first-class sub-agents. Each runs in its own real command-line harness,
under its own permissions, and reports back to the session that sent it.

The result is a mixed team with Claude in charge: one model writes the change,
another reviews it, and a test suite decides whether it is finished. That last
part matters most.

## Why another layer

An external agent that exits cleanly has told you only that it stopped. It may
have been denied the tools it needed, timed out, or "succeeded" with an empty
reply. Each of these looks like success from the outside. Agent Smith exists to
stop that fiction reaching the session that delegated the work.

It keeps two questions apart. *Did the worker finish?* is execution, and comes
from the harness. *Is the work acceptable?* is acceptance, and comes only from
checks you attach, such as a test command or a linter, run after the worker
stops. A worker's own summary is treated as a claim to be verified, never as an
instruction to be followed.

## Getting started

You need Node 22.18 or later, Claude Code, and at least one worker CLI installed
and logged in: `codex`, `opencode`, `agy` or `claude`.

```sh
npm install
npm --prefix the-codes/surfaces/channel install
npm run setup:claude
claude
```

`setup:claude` builds the plugin and registers this checkout with Claude Code for
this project only. It writes no user-wide settings. After changing the source,
run `npm run build:plugin` and restart Claude.

To use Agent Smith in another project for a single session, without installing
anything:

```sh
npm run build
/path/to/agent-smith/dev.sh --repo /path/to/your/project
```

That route has no completion hook, so Claude must ask for job status itself
rather than being woken.

Then ask for work in plain language:

> Have Codex review the changes on this branch. Call it Ada. When it finishes,
> ask it to explain its most serious finding with a failing input.

Claude looks up which agents and models are installed, starts the worker, and is
woken when it finishes. It then reads the findings and follows up with the same
worker, which still remembers the conversation.

## How it works

Agent Smith is an MCP server plus a small Claude Code plugin. Claude sees eight
tools; in practice it uses four.

- **`spawn_job`** starts a named worker on a provider (Codex, OpenCode, agy or
  Claude) with a mode, a prompt, and optionally a working directory, model,
  effort level and checks. It returns at once; the work carries on in the
  background.
- **`status`** reads a job: whether it finished, what the worker said, which
  files changed, and whether the checks passed.
- **`resume_job`** sends a follow-up to a finished worker by name, keeping its
  conversation.
- **`run_pipeline`** chains workers. For example, agy implements, Codex reviews,
  and each stage has its own checks.

The remaining tools list what is installed (`list_capabilities`), list past
workers (`list_jobs`), cancel work (`cancel`) and read a pipeline's state
(`pipeline_status`). Every parameter is documented in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md).

Claude does not poll for results. A hook watches each job and wakes Claude when
it finishes or needs attention.

### Modes

Every job has one of four modes. A mode frames the request and sets how much the
worker may touch. It never chooses the model.

| Mode | What the worker is asked to do |
|---|---|
| `implement` | Make the change and report what it changed and found. |
| `review` | Find defects, missed cases and unsupported claims, without editing. |
| `moderate` | Independently test earlier work and a reviewer's claims. |
| `verify` | Run the checks and report exactly what happened. |

"Without editing" is enforced only where the harness can enforce it, which
today means Codex. Elsewhere it is an instruction, and the job's
`readOnlyEnforced` field tells you which you got.

### Checks

A check is a command that must succeed:

```json
{ "name": "tests", "command": "npm test", "timeoutMs": 300000 }
```

Checks run in the worker's directory after it finishes. The job is then
*accepted* or *rejected*. Without checks it is *unchecked*: Agent Smith will tell
you the worker finished, but not that it was right. A check marked
`"blocking": false` is reported but does not decide the verdict.

### Models

Agent Smith ships no model list. It asks each installed harness what it
supports, so the choice is always current. To run Sonnet as a sub-agent, use the
Claude provider with `model: "sonnet"`; for Codex, any model its CLI offers. Leave
the model out and each harness uses its own default. Recurring choices can be
named in an optional `models.json`, as in "use `sol-high` for every review"; see
[docs/CONFIGURATION.md](docs/CONFIGURATION.md).

### Permissions

Workers start with their harness's own restricted settings, not the permissions
of your Claude session. Codex can write to its workspace and nothing else.
Claude, run headless, is refused any tool it would have to ask about.
`unrestricted: true` lifts these limits.

agy is the exception. Headless, it cannot ask permission and silently refuses
instead, so it runs unrestricted by default. Set `unrestricted: false`, or
`AGENT_SMITH_AGY_RESTRICTED=1`, to change that. Workers edit the directory they
are given. To keep parallel workers from treading on each other, give each its
own git worktree.

## Watching the work

`/forge` opens a panel above the prompt listing live and recent workers. Choose
one to see its activity, its original task, its result and its checks, updated
as it runs. Failures stay on the Active list until you acknowledge them or a
day passes, then move to History. The panel's keys work once it has focus: press Ctrl+X, then Tab.
Escape returns you to the prompt. The full list of keys is in the
[pane's README](the-codes/surfaces/mod/README.md).

Everything the panel shows is read from plain files in `.agent-smith/jobs/` in
your repository, one directory per job. If the panel and Claude ever disagree,
those files are the record. They accumulate. `node scripts/agent-smith.mjs gc`
moves finished jobs older than a fortnight into `.agent-smith/archive/`.
`--dry-run` shows what would move; `--delete` discards them instead.

## Examples

A fix that only counts if the tests pass:

```
spawn_job { "mode": "implement", "name": "Ada", "provider": "codex",
            "prompt": "Fix the off-by-one in pager.ts and add a test.",
            "checks": [{ "name": "tests", "command": "npm test" }] }
```

One agent builds, another reviews:

```
run_pipeline { "spec": { "name": "session-expiry",
  "stages": [
    { "name": "build",  "provider": "agy",   "role": "implement",
      "prompt": "Expire idle sessions after 30 minutes.",
      "checks": [{ "name": "tests", "command": "npm test" }] },
    { "name": "review", "provider": "codex", "role": "review",
      "dependsOn": ["build"], "prompt": "Review the change." }
  ] } }
```

A Sonnet worker for a second opinion, then a follow-up:

```
spawn_job  { "mode": "review", "name": "Rae", "provider": "claude",
             "model": "sonnet", "prompt": "Review the diff on this branch." }
resume_job { "worker": "Rae", "prompt": "Explain finding 2 with a failing input." }
```

## When things go wrong

- **A provider shows as unavailable.** The MCP server could not find the binary.
  It inherits the `PATH` of whatever launched Claude. Restart Claude, or point at
  the binary with `AGENT_SMITH_CODEX_BIN` (likewise `_OPENCODE_`, `_AGY_`,
  `_CLAUDE_`).
- **Claude is never woken.** The completion hook exists only in the installed
  plugin, not under `dev.sh`, and only loads after a restart. Without it, ask for
  `status` with `wait_ms`.
- **A worker "succeeded" but did nothing.** It was probably refused a tool.
  Agent Smith records that as a failure. The job's `nextAction` suggests a fix,
  usually rerunning with `unrestricted: true`. Do that only if you accept what
  the worker could then do.
- **A job was cut off.** The default budget is 45 minutes; raise `timeoutMs` or
  split the task. A job whose supervising process died is marked as orphaned
  rather than left "running" for ever.

## Limits

Running workers cannot be steered; you can follow up only once they finish. MCP's
new Tasks extension is not used, because Claude Code does not yet support it.
Agent Smith's own job files already do that work. OpenCode support is
provisional until it has been tested against a working account. Whether a very
long job's completion hook survives Claude's own time limits has not been
verified.

## Working on Agent Smith

```sh
npm run verify          # typecheck and the full test suite
npm run smoke           # MCP smoke test against fake Codex and agy CLIs
npm run build:plugin    # rebuild the plugin, then restart Claude
```

Tests use fake CLIs through the real process and MCP boundaries, so they spend
no model quota. `node scripts/smoke.mjs --live --providers=agy,codex` repeats the
smoke test against the real agents. The design is described in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and delivery status in
[PROGRESS.md](PROGRESS.md).

MIT licensed.
