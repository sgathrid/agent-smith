/**
 * providers/types.ts — the contract every worker adapter implements.
 *
 * WHY THIS FILE IS SELF-CONTAINED
 * ================================
 * The core layer (core/types.ts) is being written concurrently by another
 * engineer. Importing it here would create a build-order dependency on work
 * that does not exist yet, so this file defines its own MINIMAL, structurally
 * compatible versions of Job / Activity / TokenUsage.
 *
 * Once core/types.ts lands, these local types MUST be reconciled with it —
 * either by deleting the duplicates here and re-exporting from core, or by
 * proving structural compatibility. See ../README.md ("Reconciliation debt").
 *
 * The rule for this layer: providers may speak in whatever dialect their CLI
 * emits, but they must translate into ProviderEvent before anything else sees
 * them. core/ never parses agy/Codex/OpenCode/Anthropic JSON.
 */

// ---------------------------------------------------------------------------
// Tokens / usage
// ---------------------------------------------------------------------------

/**
 * Normalized token counters.
 *
 * WHY THE EXPLICIT OPTIONALS
 * --------------------------
 * Every CLI names these differently and omits different ones:
 *   agy     -> input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens
 *   codex   -> input_tokens, cached_input_tokens, cache_write_input_tokens,
 *              output_tokens, reasoning_output_tokens   (NO total)
 *   claude  -> input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
 *              output_tokens (+ usage.output_tokens_details.thinking_tokens)
 *   opencode-> UNKNOWN (see opencode.ts)
 * `total_tokens` is therefore OPTIONAL and providers that can compute it DO.
 * We never fabricate a zero: absent means absent.
 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

// ---------------------------------------------------------------------------
// SpawnSpec — what the caller asks for
// ---------------------------------------------------------------------------

/**
 * Everything needed to start one worker process.
 *
 * The six non-optional fields (mode, prompt, cwd, timeoutMs, unrestricted) are
 * the contract from the task brief. `jobId` is technically optional but every
 * provider generates one when absent, because WorkerHandle.id must exist.
 */
export interface SpawnSpec {
  /** Pipeline stage name, e.g. "implement" | "review" | "moderate". */
  mode: string;

  /** The instruction handed to the model. Passed as argv, never via stdin. */
  prompt: string;

  /** Provider-native model id, e.g. "gemini-3.8-flash-high", "gpt-5.6-sol", "sonnet". */
  model?: string;

  /**
   * Reasoning effort, provider-native ("high" | "xhigh" | ...).
   * NOTE: agy accepts effort BOTH as its own flag (--effort) and baked into the
   * model id ("gemini-3.8-flash-high"). We prefer the id form; see agy.ts.
   */
  effort?: string;

  /** Absolute working directory for the child process. */
  cwd: string;

  /** Hard wall-clock budget in ms. Enforced by us, and passed to the CLI where supported. */
  timeoutMs: number;

  /**
   * True  => bypass the tool-approval prompts (worker is trusted, repo is disposable).
   * False => worker runs sandboxed/ro where possible.
   *
   * THIS IS NOT COSMETIC. agy's headless mode cannot prompt for permission, so
   * a denied tool silently produces an empty success. See agy.ts.
   */
  unrestricted: boolean;

  /** Resume a prior conversation/session/thread where the provider supports it. */
  conversation?: string;

  // ---- additive fields, all optional, defaulted per provider ----------------

  /** Stable id for this job. Generated (randomUUID) if omitted. */
  jobId?: string;

  /**
   * Run read-only where the provider can enforce it (codex: `-s read-only`).
   * Providers that cannot enforce it ignore this; the ack reports that via
   * `readOnlyEnforced`. Ignored when `unrestricted` is true.
   */
  readOnly?: boolean;

  /** Extra directories to widen the worker's sandbox to (agy --add-dir / codex --add-dir). */
  addDirs?: string[];

  /** Extra environment for the child. Merged over process.env, never replacing it wholesale. */
  env?: NodeJS.ProcessEnv;

  /**
   * Where provider-written state goes. Defaults to
   * `${AGENT_SMITH_STATE_DIR ?? ~/.agent-smith/state}/<provider>/<jobId>`.
   * Override for tests.
   */
  stateDir?: string;

  /** Max characters of tool input/output retained per event. Default 2000. */
  maxOutputChars?: number;
}

// ---------------------------------------------------------------------------
// ProviderEvent — the normalized progress stream
// ---------------------------------------------------------------------------

export type ActivityStatus = 'active' | 'done' | 'error' | 'denied';

/**
 * Provider-local identity of a tool call, in a form the mod surface can render.
 * `input`/`output` are PRE-TRUNCATED by the provider adapter to
 * SpawnSpec.maxOutputChars so the store never receives a 4 MB cargo-clip dump.
 */
export interface ActivityRef {
  /** Monotonic step number within the job. Used as the activity key. */
  stepIndex: number;
  /** Provider-native tool name, e.g. "run_command", "Bash", "Edit". */
  tool: string;
  /** Provider-native tool-call id when one exists (claude tool_use_id, opencode partID). */
  toolCallId?: string;
  input?: string;
  output?: string;
  /** True when the provider truncated input/output before handing it to us. */
  truncated?: boolean;
  /** Set when the tool was auto-denied by policy rather than failing on its own. */
  denied?: boolean;
}

/**
 * ONE normalized event. Every adapter emits a subsequence of these and nothing
 * else. The store maps them onto Job/Activity rows.
 *
 * DESIGN NOTE: there is deliberately NO "finished" variant. JobResult is the one
 * and only completion channel (via WorkerHandle.waitForResult), so a consumer
 * can never disagree with itself about whether a job ended.
 */
export type ProviderEvent =
  /** Process spawned; carries whatever the CLI reported about itself. */
  | { kind: 'started'; at: string; conversationId?: string; model?: string; raw?: unknown }

  /** Assistant prose. `stream` distinguishes user-visible text from thinking. */
  | { kind: 'text'; at: string; text: string; stream: 'assistant' | 'thinking'; delta?: boolean }

  /** A tool call began. Emit once per step_index, on the ACTIVE transition. */
  | { kind: 'activity-start'; at: string; activity: ActivityRef }

  /** Incremental output for an in-flight tool call (agy text_delta-style). */
  | { kind: 'activity-update'; at: string; activity: ActivityRef }

  /** A tool call reached a terminal state. */
  | { kind: 'activity-end'; at: string; activity: ActivityRef; status: ActivityStatus; durationSeconds?: number }

  /** Token accounting. Emitted whenever a CLI reports it; not necessarily once. */
  | { kind: 'usage'; at: string; usage: TokenUsage }

  /**
   * Anything worth showing the operator that is not a tool call: stderr
   * warnings, API errors, "permission auto-denied" notices, parse failures.
   * `level: 'error'` does NOT mean the job failed — see JobResult for that.
   */
  | { kind: 'notice'; at: string; level: 'info' | 'warn' | 'error'; message: string; raw?: unknown };

/** Convenience: everything an event bus can carry for a single job. */
export type AnyProviderEvent = ProviderEvent;

// ---------------------------------------------------------------------------
// JobResult
// ---------------------------------------------------------------------------

/**
 * How a job ended.
 *
 * `denied` is the reason this union exists as more than `{success, error}`.
 * agy exits 0 with status "SUCCESS" and an empty response when a tool is
 * soft-denied. If we collapse that to `success`, a job that did nothing is
 * indistinguishable from a job that did everything. We verified this live; see
 * agy.ts. Every provider maps its own failure vocabulary onto these codes.
 */
export type JobStatus =
  | 'success'   // provider reported completion and the CLI agreed
  | 'error'     // provider reported an error, or the CLI exited non-zero
  | 'denied'    // tool permission was refused; the work did not happen
  | 'timeout'   // we killed it at SpawnSpec.timeoutMs
  | 'cancelled' // WorkerHandle.cancel() was called
  | 'malformed' // process ended but we never saw a terminal event (see adapters)
  | 'spawn-failed'; // could not start the process at all

/** agy's `result.denied_actions[]` entry, normalized. Kept first-class. */
export interface DeniedAction {
  /** agy action kind, e.g. "command". */
  action?: string;
  /** agy display name, e.g. "RunCommand". */
  displayName?: string;
  /** Raw entry, in case a future CLI adds fields we have not modelled. */
  raw?: unknown;
}

export interface JobResult {
  jobId: string;
  provider: string;
  ok: boolean;
  status: JobStatus;
  /** null when the process died on a signal. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** The provider's final assistant text. May legitimately be "" — see 'denied'. */
  response: string;
  /** Human-readable failure reason. Present for every status except 'success'. */
  error?: string;
  /** Non-empty => the job is NOT a success, regardless of exit code or status string. */
  deniedActions?: DeniedAction[];
  usage?: TokenUsage;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  /** Directory holding this job's provider-written state (events.jsonl, stderr.log, result.json). */
  stateDir: string;
  /** The provider's terminal event, verbatim. For debugging only. */
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Provider / WorkerHandle
// ---------------------------------------------------------------------------

export interface WorkerHandle {
  /** Stable id. Equal to SpawnSpec.jobId when supplied, else a generated UUID. */
  id: string;

  /**
   * Directory this worker's state is written to. Always created before spawn()
   * resolves, so a consumer can tail it immediately. See ndk: writeStateDir().
   *
   * Layout (uniform across ALL providers, not just agy):
   *   <stateDir>/events.jsonl   normalized ProviderEvent, one JSON per line
   *   <stateDir>/argv.json      the exact argv + cwd we spawned with
   *   <stateDir>/stderr.log     the child's stderr, verbatim
   *   <stateDir>/result.json    the JobResult, written on completion
   * agy additionally has agy-staff's own <cwd>/.agy-staff/jobs/<jobId>.* tree,
   * which harness/ (not us) reads.
   */
  stateDir: string;

  /**
   * Kill the worker. Escalates SIGTERM -> SIGKILL after a grace period.
   * Idempotent. waitForResult() then resolves with status 'cancelled'
   * (or 'timeout' if the timeout fired first — whichever actually happened).
   */
  cancel(): void;

  /** Resolves exactly once, when the job reaches a terminal state. Never rejects. */
  waitForResult(): Promise<JobResult>;

  /**
   * ADDITIVE (not in the brief's four-member shape, but needed for live
   * progress — see README "Reconciliation debt").
   *
   * Subscribe to normalized events. Returns an unsubscribe function. Listeners
   * are called synchronously in stream order; do not block in them.
   */
  onEvent(listener: (event: ProviderEvent) => void): () => void;

  /**
   * ADDITIVE. Same events as onEvent(), consumed as an async iterable.
   * Backed by a bounded queue so a slow consumer cannot OOM the parent, but a
   * consumer that falls further behind than the bound will see dropped events.
   * Prefer onEvent() for a store writer; use this for tests and CLI drain.
   */
  readonly events: AsyncIterable<ProviderEvent>;
}

export interface Provider {
  /** Registry key: "agy" | "codex" | "opencode" | "claude". */
  name: string;

  /**
   * True when the binary exists on PATH *and* is plausibly usable.
   * Must be cheap, must not require a TTY, and must never throw.
   * registry.detectAvailable() runs this for every provider.
   */
  available(): Promise<boolean>;

  /**
   * Start a worker. Rejects ONLY if the process could not be spawned at all
   * (ENOENT, bad cwd). Once the process is running, failures arrive through
   * the returned handle's waitForResult() — never as a rejection.
   */
  spawn(spec: SpawnSpec): Promise<WorkerHandle>;

  /**
   * Report the sandbox/permission posture `spawn(spec)` WILL apply, derived from
   * the same code path that builds argv (not a parallel guess). Pure, no I/O.
   */
  describeSandbox?(spec: Pick<SpawnSpec, 'unrestricted' | 'readOnly'>): SandboxInfo;

  /**
   * The provider's own configured default model/effort, read from its config
   * file only. Sync, no CLI, no network: safe on the spawn hot path.
   */
  harnessDefaults?(): { model?: string; effort?: string };

  /** Discover models. Optional; never throws. Must be lazy (never called at startup). */
  listModels?(options?: ListModelsOptions): Promise<ModelCatalog>;
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

/** One discoverable model, normalized across providers. */
export interface ModelInfo {
  /** Provider-native id to pass as `--model`. For agy this is a BASE id (effort suffix stripped). */
  id: string;
  label: string;
  /** Efforts this model accepts, provider-native strings (codex includes e.g. "ultra"). */
  efforts: string[];
  defaultEffort?: string;
}

/** What `listModels()` returns. Never throws; failures land in `error`. */
export interface ModelCatalog {
  provider: string;
  models: ModelInfo[];
  /** Provider default read from the harness's own config, when it exists. */
  defaultModel?: string;
  defaultEffort?: string;
  defaultSource: 'harness-config' | 'unknown';
  /** Where this listing came from. */
  source: 'live' | 'cache' | 'static';
  /** True when served from an expired cache because a refresh failed. */
  stale: boolean;
  /** False when the discovery path has not been verified against a real install (opencode). */
  verified: boolean;
  error?: string;
}

export interface ListModelsOptions {
  timeoutMs?: number;
}

/** Effective sandbox posture for a spawn, echoed in the spawn ack. */
export interface SandboxInfo {
  /** Human-readable, e.g. "codex -s read-only" or "agy proceed-in-sandbox (cannot prompt)". */
  sandbox: string;
  /** Flags that will be passed for sandbox/permissions, verbatim. */
  flags: string[];
  /** True only if a requested readOnly is actually enforced by the CLI. */
  readOnlyEnforced: boolean;
}
