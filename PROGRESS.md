# Agent Smith replacement implementation

Implemented: CLI and MCP share ForgeService and the persistent DAG runner.
Luna workers owned provider adapters, runtime hardening, CLI, and Claude plugin
projection; the primary agent integrated and independently reviewed the seams.

## Delivered

- Named workers with stable identities, roles, task, current tool activity, and
  bounded worker-authored output excerpts. Thinking events are excluded.
- Follow-ups by name or job ID resume the same harness conversation; ambiguous
  names, live workers, and missing resume handles fail explicitly.
- `/forge` pane and compact live band; native TaskCreate/TaskUpdate projection
  uses actual host task IDs and records terminal outcomes honestly.
- CLI foreground/background runs and MCP share canonical job/run records.
- Run-scoped artifacts preserve worker-written reports. Executable checks gate
  acceptance; unchecked execution remains explicitly distinguishable.
- Cross-supervisor cancellation requests, process-group termination, referenced
  supervisor lifetime, path containment, and provider-owned transcript handles.
- Session-scoped launcher, built MCP entrypoint, portable fixture tests and docs.

## Verification

- Clean source snapshot: typecheck and 494 Node tests passed; channel build passed.
  Dependencies were reused through local symlinks, not reinstalled from the network.
- Claude plugin validation passed; 14 engine tests passed, including the actual
  host TaskCreate/TaskUpdate bridge. Mod Node tests: 97 passed.
- SDK stdio protocol against the built snapshot server passed delegation, named
  resume, actual output summaries, preserved artifacts, and acceptance failures.
- Session launcher passed repository paths with spaces, channel opt-in, MCP
  configuration, and forwarded Claude flags. `git diff --check` passed.

Fixture harnesses exercised real subprocesses, stdio MCP, and persistent files.
No successful live paid-model execution is claimed by these automated checks.

## Repo-local native Claude setup

- `npm run setup:claude` builds a self-contained plugin and declares the checkout
  as a directory marketplace in root `.claude/settings.local.json`. Existing local
  settings are preserved; no global config or global enablement is written.
- The nested `agent-configs/.claude` remains an inactive example. Project/local
  settings cannot set `CLAUDE_CODE_PLUGIN_DIRS`, so the active setup uses a local
  marketplace with a relative plugin source instead.
- The plugin includes Forge, MCP tools, delegation instructions, and a
  job-scoped `PostToolUse` `asyncRewake` hook (`hooks/watch-hooks.json`, running
  `runtime/dist/watch-hook.js`) that watches only the job just spawned and exits 2
  to wake Claude; nothing runs while idle. The always-on `experimental.monitors`
  entry was removed because a running monitor shows in Claude's exit dialog and
  polls forever. monitor.js stays staged as a manual fallback (`--job`/`--run`,
  under Monitor); acks carry a `notify` hint. Its MCP server runs without the
  channel poller. Unverified: exit-dialog behavior of async hooks, hook timeout
  cap for 45-minute jobs (set 2760 s), and wake while mid-turn.
- Earlier live plain `claude` 2.1.292 startup (with the old monitor) confirmed one monitor, connected
  `plugin:agent-smith:agent-smith` with seven tools, and working `/forge`.
  Claude's normal registry/data writes under `~/.claude/plugins` were authorized;
  sandbox-only startup could load the UI/monitor but blocked the MCP data folder.
- Built bundle passed SDK delegation/resume/acceptance checks after copying to a
  separate temporary path with spaces. Built monitor smoke verified idle lifetime,
  session-cwd reading, completion output, and clean SIGTERM shutdown.
- Plugin/marketplace validation and typecheck passed; 15 engine tests passed.
  Current broad suite: 494 of 496 passed. The two failures are live corpus
  assumptions in `jobs.node-test.ts` about Renyi's changing agy-staff job directory.
- Forge requests one-third terminal width for list and detail. Claude retains
  control of saved manual sizing and renders inline in narrow terminals.

## Remaining boundaries

External workers are tracked native tasks, not intercepted Claude Agent loops or
native teammates. Follow-ups require a completed conversation; live steering is
not implemented. Owner crashes can leave running records and orphaned workers;
owner leases/reconciliation are the next runtime step. OpenCode success-stream
qualification remains provisional. Isolated worktrees and model-specific live
qualification are separate follow-up work.
