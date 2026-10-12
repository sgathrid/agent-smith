# providers/ — spawning and observing workers

This directory owns **how workers are started and watched**. It is the only
layer that speaks CLI dialects. `core/` is provider-agnostic and `harness/`
reads state that workers write themselves; neither parses agy/Codex/OpenCode/
Anthropic JSON.

Non-negotiables, enforced in `ndjson.ts` so no adapter can quietly break them:

- **No TTY, no PTY, ever.** stdio is `['ignore'|'pipe', 'pipe', 'pipe']`. This
  is the claude-squad trap: a PTY merges stderr into stdout and destroys NDJSON
  framing, so "just wrap it in a pty" makes every event parser wrong.
- **stdin is `ignore` by default.** Codex reads stdin when it is a pipe and will
  block forever waiting for input nobody sends.
- **Exit code is corroboration, never proof.** A job that produced no work is a
  failure even at exit 0. See "The denial trap" below.
- **Every terminal path resolves `waitForResult()`** — success, error, timeout,
  cancel, and the awkward ones (process died with no terminal event).

## The Provider interface

```ts
interface Provider {
  name: string;
  available(): Promise<boolean>;
  spawn(spec: SpawnSpec): Promise<WorkerHandle>;
}

interface WorkerHandle {
  id: string;
  stateDir: string;
  cancel(): void;
  waitForResult(): Promise<JobResult>;
  onEvent(listener: (event: ProviderEvent) => void): () => void; // additive
  readonly events: AsyncIterable<ProviderEvent>;               // additive
}
```

`spawn()` rejects **only** when the process cannot start at all (ENOENT, bad
cwd). Once running, every outcome — including an instant crash — arrives through
`waitForResult()`, never as a rejection.

`onEvent` and `events` are additive beyond the four members in the original
brief. Live progress is the entire point of this project (agy-staff wrote a
complete event log to disk and then told the host model not to look at it), so
an interface that can only report at the end does not serve the thesis. `onEvent`
is the push form a store writer wants; `events` is the async-iterable form for
draining and tests. Both feed the same bus.

### JobStatus

`'success' | 'error' | 'denied' | 'timeout' | 'cancelled' | 'malformed' | 'spawn-failed'`

`'denied'` exists as a first-class member because collapsing it into `error`
destroys the only information an operator needs. `'malformed'` means the process
ended but we never saw a terminal event — a crash, an OOM kill, or a CLI whose
output format changed. It is deliberately distinct from `'error'`.

## Per-provider invocation

Exact argv. All four are spawned with piped stdio and no TTY.

### agy (Antigravity) — `agy.ts`

```
agy --print=<prompt> --output-format stream-json
    [--model <id>] [--effort <low|medium|high|xhigh|max>]
    [--print-timeout <dur>] [--add-dir <dir>]...
    [--dangerously-skip-permissions] [--conversation <id>]
```

- `--print=` **must** use the attached form. `--print <prompt>` with a space
  makes agy consume the next token; with a multi-word prompt that silently
  splits the prompt and leaves a stray word as a positional.
- `--effort` is only emitted when the model id does not already carry an effort
  suffix (`gemini-3.8-flash-high` → skip it, it is already encoded).
- `--print-timeout` is a Go duration; `SpawnSpec.timeoutMs` is converted
  (`toGoDuration`) and we *also* enforce the budget ourselves.

**Verified by executing** against the live binary, plus ~14 900 archived
`step_update` records from `~/Repos/renyi/.agy-staff/jobs/`. Event shapes:
`{event:'init'}`, `{event:'step_update', step_update:{step_index, state, step_type,
tool_name, tool_info:{name,parameters,output,error}, text_delta, duration_seconds,
usage}}`, `{event:'result', result:{conversation_id,status,response,duration_seconds,
num_turns,usage,denied_actions?}}`. `step_type` observed: `tool`, `agent_response`,
`user_input`, `system_message`, `error_message`, `checkpoint`. `state`:
`ACTIVE` | `DONE` | `ERROR`.

ACTIVE and DONE arrive as separate records for the same `step_index`, and only
ACTIVE carries `tool_info.parameters` — the adapter remembers per-step state so
the DONE record is not useless on its own.

### The denial trap

agy runs headless and **cannot prompt for tool permission**, so a tool needing
approval is auto-denied. Verified live:

```
{"event":"result","result":{"status":"SUCCESS","response":"",
  "denied_actions":[{"action":"command","display_name":"RunCommand"}]}}
$ echo $?   →   0
```

Exit 0. `status` is the string `"SUCCESS"`. `response` is empty. Every naive
integration reports a successful job that did nothing, and a chained
implement→review pipeline then reviews a patch that was never written and reports
green. That is worse than a crash, because it is quiet.

Four independent detectors, because each fails in a different situation:

1. `result.denied_actions` non-empty → `'denied'` (primary)
2. `tool_info.error.type === 'TOOL_ERROR'` matching agy's own denial wording →
   `'denied'` (early signal, before the result event)
3. `status !== 'SUCCESS'` → `'error'`
4. `status === 'SUCCESS'` **and** empty response **and** tool calls were made →
   `'denied'`, never `'success'` (last-resort net)

Detection 4 is deliberately paranoid: a model that burned tokens and made tool
calls but produced no final text, with no explicit denial, is a failure shaped
like a success. The genuinely-empty case (no tool calls) is allowed to pass.

The fix is upstream too — `unrestricted: true` adds
`--dangerously-skip-permissions` — but detection stays, because a config-level
allow-rule can still deny one command and the flag does not override an
explicit deny.

> **agy-staff deletes `progress.json` and `events.jsonl` on warning-free
> success.** A missing `progress.json` means **"job finished"**, never "job
> vanished". Treating absence as liveness reports every healthy job as missing.
> The authoritative terminal signal is `result.md` + `result.md.status.json`.
> This directory never polls that tree — it is `harness/`'s job — but it is the
> single most misreadable fact in the system, so it is written down here.

### codex — `codex.ts`

```
codex exec --json --skip-git-repo-check -C <cwd>
    [--model <id>] [--add-dir <dir>]...
    (-s workspace-write | --dangerously-bypass-approvals-and-sandbox)
    <prompt>
```

Verified by running `--help` on 0.161.0 (flags re-checked after an upgrade from
0.160.1) and by executing the exact command end to end.

Events observed live: `thread.started` (`thread_id`), `turn.started`,
`item.completed` (`item:{id,type:'agent_message',text}`),
`turn.completed` (`usage:{input_tokens,cached_input_tokens,cache_write_input_tokens,
output_tokens,reasoning_output_tokens}`). `cached_input_tokens` maps to
`cacheReadTokens` so core/ can sum across providers. No `total_tokens` — left
undefined rather than invented.

Two verified gotchas:

- **stdin.** "If stdin is piped and a prompt is also provided, stdin is appended
  as a `<stdin>` block." Our `stdio[0]='ignore'` is a closed fd, not a pipe, so
  codex does not enter that path. Changing it to `'pipe'` hangs forever.
- **Untrusted directory.** Outside a git repo codex prints
  `Not inside a trusted directory and --skip-git-repo-check was not specified.`
  and writes **nothing** to stdout — not even an error event. We always pass
  `--skip-git-repo-check`: refusing to run because there is no `.git` is not a
  useful policy for an orchestrator. Absence of a result event is a reachable
  failure mode and maps to `'malformed'`.

`unrestricted:false` → `-s workspace-write`, not `read-only`: a review stage
that cannot write a scratch note cannot work, and there is no approval mechanism
in headless mode to hang on.

### opencode — `opencode.ts`

```
opencode run --standalone --format json
    [--model <provider/model#variant>] [--auto] [--session <id>] <prompt>
```

**This is the least-verified adapter. Read the section at the bottom.**

`--standalone` is passed because `run` otherwise talks to a *background server*:
the process we spawn is not the process doing the work, so `cancel()` does
nothing and a "finished" worker leaves a server running.

`addDirs` is **deliberately ignored**. The v2 docs list `--dir`, but it is not
in `opencode run --help` on v2.0.26 and passing it makes the CLI print usage and
exit non-zero — a guaranteed spawn failure. There is a regression test pinning
this, because the stale docs make it look like an oversight.

Unlike the others there is no way to express a restricted run: `unrestricted:false`
omits `--auto` and relies on the agent's configured permissions.

### claude — `claude.ts` (the prober / moderator)

```
claude -p --output-format stream-json --verbose --forward-subagent-text
    [--model <id>] [--add-dir <dir>...]
    (--dangerously-skip-permissions | --permission-mode dontAsk --permission-prompts none)
    [--session-id <uuid>] [--setting-sources <list>]
    <prompt>
```

Verified by `--help` on 2.1.295 (re-checked after upgrade from 2.1.292) and by
executing the invocation against a live model.

- `--verbose` is required for the full event stream under `--print`.
- `--forward-subagent-text` is what makes a moderator usable: without it a
  subagent's reasoning is invisible, and a moderator that cannot see what the
  prober did is just another proposer. Subagent text arrives with
  `parent_tool_use_id` set; we prefix it `[subagent]` and deliberately **exclude**
  it from `JobResult.response`, so a subagent's chatter cannot corrupt the
  moderated output.
- `unrestricted:false` → `--permission-mode dontAsk --permission-prompts none`,
  **not** `manual`. `manual` in print mode means waiting for an approval that
  can never arrive, so a restricted run would hang until the timeout. `dontAsk`
  means deny-without-prompting: it fails loudly instead of stalling. The cost is
  that a restricted moderator may come back with denied tools, which we report as
  `'denied'` — a moderator with no tools cannot moderate.
- **Hooks run headless.** A `SessionStart` hook from local config fired during
  verification and injected company knowledge into the run. A headless moderator
  can therefore be steered by whatever hooks happen to be configured. Defaults to
  `--setting-sources user`; `AGENT_SMITH_CLAUDE_BARE=1` switches to `--bare`
  (no hooks, no CLAUDE.md, keychain auth disabled) for a hermetic run.
- **No `--print-timeout` equivalent.** The budget is enforced entirely by our
  SIGTERM→SIGKILL escalation.

## UNVERIFIED / needs testing

Flag *existence* was checked against `--help` on every CLI. Flag *semantics* and
success-path event shapes were only verified where a run actually succeeded.

**opencode — least trustworthy.** I never observed a successful run. Both attempts
failed at the provider layer (`provider.quota` HTTP 402 "Insufficient account
funds", `provider.no-route` "Model unavailable"). That is an account problem, not
a flag problem, but it means:

- **Success-path event names are UNVERIFIED.** OpenCode's documented SSE
  vocabulary (`message.part.updated`, `session.idle`, `session.error`) is the
  *server* bus; `run --format json` is documented only as "raw JSON events" and
  probably emits the same, but "probably" is not verification.
- Token field names are UNVERIFIED; both snake_case and Vercel-AI-style
  (`promptTokens`/`completionTokens`) spellings are accepted.
- `--standalone` runtime behaviour is unconfirmed (does it really isolate the
  server?).

Mitigation: the parser is **defensive, not precise**. Text, tool calls and usage
are extracted by content rather than event name; every unrecognised type is
emitted as a `notice` naming the type; and exit-0-with-no-text maps to
`'malformed'` with an error that says the likeliest cause is a parser gap, not an
empty model response. **Nothing is ever silently dropped.** The first run against
a funded account should be treated as a discovery run — read the
"unrecognised event type" notices and extend the parser.

**codex.** `item.started` / `item.updated` are handled if they exist and ignored
if not (`--help` does not enumerate event names, and my run made no tool calls).
The tool `item.type` vocabulary (`command_execution`, `file_change`,
`mcp_tool_call`, `reasoning`, `todo_list`) comes from Codex's docs, not local
observation. Denial detection from message text is unverified.

**claude.** `user` messages carrying `tool_result` are documented but absent
from my run (no tool calls). `--max-turns` accepted in print mode is untested.

**agy.** Highest confidence: full event schema verified against both the live
binary and ~14 900 archived records. `--sandbox`, `--log-file`, `--project` are
deliberately not passed; `--project` has no `SpawnSpec` field and is a harness
concern.

**Not tested at all:** concurrent spawn of many workers per provider (the
registry's concurrency cap lives in `core/`), and behaviour when a worker ignores
SIGTERM mid-tool-call (escalation to SIGKILL after 5 s is implemented but only
exercised by the orphan-descendant test).

## Environment overrides

Each adapter honours an env var so a non-PATH install needs no code change, and
`registry.binaryFor()` surfaces it so "provider not found" says which command was
looked for.

| Var | Effect |
|---|---|
| `AGENT_SMITH_STATE_DIR` | Root for provider-written state. Default `~/.agent-smith/state`. |
| `AGENT_SMITH_AGY_BIN` / `_CODEX_BIN` / `_OPENCODE_BIN` / `_CLAUDE_BIN` | Binary name or absolute path. |
| `AGENT_SMITH_CODEX_MODEL` / `_CODEX_SANDBOX` | codex `-c model=` / `-s` override. |
| `AGENT_SMITH_HOME` | Root for alias resolution (`aliases.ts`). Falls back to `~`. Not used by `stateRoot()`. |
| `AGENT_SMITH_CLAUDE_HOME` / `CLAUDE_CONFIG_DIR` | Claude config dir. Falls back to `~/.claude`. |
| `AGENT_SMITH_CODEX_HOME` / `CODEX_HOME` | Codex home. Falls back to `~/.codex`. |
| `AGENT_SMITH_CLAUDE_SETTING_SOURCES` | `--setting-sources` value; empty string omits the flag. |
| `AGENT_SMITH_CLAUDE_BARE=1` | Use `--bare`. |

## stateDir layout

Uniform across all four providers, created before `spawn()` resolves so a
consumer can tail immediately:

```
<stateDir>/events.jsonl   normalized ProviderEvent, one JSON per line
<stateDir>/argv.json      the exact argv + cwd we spawned with
<stateDir>/stderr.log     the child's stderr, verbatim (4 MB cap)
<stateDir>/result.json    the JobResult, written on completion
```

agy additionally has agy-staff's own `<cwd>/.agy-staff/jobs/<jobId>.*` tree,
which `harness/` reads. This layer does not touch it.

## Reconciliation debt with core/types.ts

`providers/types.ts` defines a **local minimal** `ProviderEvent`, `TokenUsage`,
`JobStatus` and `JobResult` because `core/types.ts` is being written
concurrently. `ProviderEvent` is deliberately a union of six variants
(`started` / `text` / `activity-start` / `activity-update` / `activity-end` /
`usage` / `notice`) with tool input and output already truncated to
`SpawnSpec.maxOutputChars`, so the store never receives a multi-megabyte cargo-clip
dump.

Two deliberate choices to revisit during reconciliation:

- **There is no `'finished'` event.** `waitForResult()` is the single completion
  channel, so a consumer cannot disagree with itself about whether a job ended.
  If `core/` wants a terminal event on the bus too, add it in core rather than
  here.
- **`notice` level is about presentation, not job status.** A `level:'error'`
  notice can accompany a successful job (e.g. a retried API call). Only
  `JobResult.status` decides success.

`TokenUsage` leaves counters optional and never fabricates a zero: agy reports
`total_tokens` but no `cache_write`; codex reports no `total_tokens`;
Anthropic reports `cache_creation_input_tokens`. Inventing a total in any one
adapter would make cross-provider totals wrong in a way that is hard to notice.