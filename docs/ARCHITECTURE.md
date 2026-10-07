# Agent Smith runtime

Agent Smith owns external harness execution. Claude controls it through MCP; the
CLI is another adapter to the same service. agy-staff is historical interoperability,
not the execution backend.

```text
Claude MCP tools / CLI
       |
       v
ForgeService -- startPipeline -- DAG scheduler
       |              |
       |              +-- explicit executable acceptance checks
       v
provider subprocess (Codex / agy / OpenCode / Claude)
       |
       v
.agent-smith/jobs/<jobId>/  (canonical manifest, events, report)
       |                 |
       |                 +-- channel: completion / attention + worker output excerpt
       v
.agy-staff/jobs/ compatibility projection
       |
       v
Claude mod: progress band, /forge pane, supported native task-list projection
```

## Ownership

- `providers/` builds CLI arguments, parses structured events, and owns process
  groups, timeouts, terminal results, model settings, and native conversation IDs.
- `forge/` owns job manifests, worker identity, cancellation requests, artifact
  preservation, supervisor ownership, and pipeline run persistence.
- `pipeline/` owns dependency validation, bounded scheduling, failure propagation,
  routing decisions, and continuation context. It does not interpret prose.
- `verify/` runs configured acceptance commands against the actual working tree.
- `surfaces/channel/` exposes MCP controls and sends selected state changes.
- `surfaces/mod/` reads the compatibility projection using the restricted host
  filesystem API. Its state is a UI projection, not another execution runtime.
- `cli/` handles arguments and detached supervision using the same forge APIs.

The old `core/` SQLite library is not the authoritative execution store. There is
no second CLI worker runner or separate CLI job projection.

## Identity and output

A `workerId` identifies the logical worker across follow-ups. Its `name` is the
human label, `role` is the job mode, and `task` is the work description. A new
invocation gets a unique job ID and may resume the native provider conversation.
A pipeline has a separate unique run ID, with stage results referencing job IDs.

`latestSummary` contains bounded actual assistant output with explicit source
`worker`; thinking is excluded. Agent Smith does not turn generic tool output
into findings or generate uncited summaries. The complete final report remains
available separately.

Worker-written artifacts survive final assistant summaries. Default artifacts are
scoped by run and stage; repeated pipeline names do not overwrite previous runs.
Inputs are the actual upstream artifact references. Worker cwd remains the source
checkout, so artifact isolation is not source-code isolation.

## Completion and acceptance

Job status describes harness execution. Stage acceptance is unchecked without
configured commands, passed when blocking checks run and pass, and failed when
blocking checks fail or cannot run. Nonblocking checks retain their evidence.
The canonical default DAG is implement, then review, then moderate; moderation
consumes both implementation and reviewer artifacts.

A cancellation marker expresses intent. Terminal cancellation requires worker
acknowledgement. A running owner polls requests, stops the worker process group,
and records the result. If the owner dies, records can stay running and cancellation
cannot stop orphaned workers. Prolonged silence is flagged for attention; owner
reconciliation and automatic replay are not implemented.

## Claude integration

MCP starts external work. Channels deliver completion/attention transitions when
enabled by the host. Routine progress and evolving summaries stay in the terminal
UI. The mod uses supported host task tools for task-list projection, with genuine
host task IDs. It does not pretend external workers are native Agent loops.

Provider auth, permissions, models, and resume capabilities remain provider-owned.
The service records requested settings and refuses unsupported combinations where
known. API-level model substitution, live app-server steering, isolated worktree
creation, and native subagent dispatch are separate future capabilities.
