export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

export interface SpawnSpec {
  mode: string;
  prompt: string;
  model?: string;
  effort?: string;
  cwd: string;
  timeoutMs: number;
  unrestricted: boolean;
  conversation?: string;
  jobId?: string;
  readOnly?: boolean;
  artifactPath?: string;
  addDirs?: string[];
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  maxOutputChars?: number;
}

export type ActivityStatus = 'active' | 'done' | 'error' | 'denied';

export interface ActivityRef {
  stepIndex: number;
  tool: string;
  toolCallId?: string;
  input?: string;
  output?: string;
  truncated?: boolean;
  denied?: boolean;
}

export type ProviderEvent =
  | { kind: 'started'; at: string; conversationId?: string; model?: string; raw?: unknown }
  | { kind: 'text'; at: string; text: string; stream: 'assistant' | 'thinking'; delta?: boolean }
  | { kind: 'activity-start'; at: string; activity: ActivityRef }
  | { kind: 'activity-update'; at: string; activity: ActivityRef }
  | { kind: 'activity-end'; at: string; activity: ActivityRef; status: ActivityStatus; durationSeconds?: number }
  | { kind: 'usage'; at: string; usage: TokenUsage }
  | { kind: 'notice'; at: string; level: 'info' | 'warn' | 'error'; message: string; raw?: unknown }
  | { kind: 'heartbeat'; at: string; pid?: number }
  | { kind: 'user-message'; at: string; text: string };

export type JobStatus =
  | 'success'
  | 'error'
  | 'denied'
  | 'timeout'
  | 'cancelled'
  | 'malformed'
  | 'spawn-failed';

export interface DeniedAction {
  action?: string;
  displayName?: string;
  nonfatal?: boolean;
  raw?: unknown;
}

export interface JobResult {
  jobId: string;
  provider: string;
  ok: boolean;
  status: JobStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  response: string;
  error?: string;
  deniedActions?: DeniedAction[];
  usage?: TokenUsage;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  stateDir: string;
  raw?: unknown;
  /**
   * Live input only: texts accepted by WorkerHandle.send() that the worker never
   * read (no 'user-message' event before the process exited), oldest first.
   * Absent when empty. These were not delivered and belong to the next turn.
   */
  unreadInput?: string[];
}

export interface WorkerHandle {
  id: string;
  stateDir: string;
  /**
   * Kill the worker. Escalates SIGTERM -> SIGKILL after a grace period.
   * Idempotent. waitForResult() then resolves with status 'cancelled'
   * (or 'timeout' if the timeout fired first — whichever actually happened).
   */
  cancel(): void;
  /** Resolves exactly once, when the job reaches a terminal state. Never rejects. */
  waitForResult(): Promise<JobResult>;
  onEvent(listener: (event: ProviderEvent) => void): () => void;
  readonly events: AsyncIterable<ProviderEvent>;
  /**
   * Present only when the provider has liveInput. Writes one user message into
   * the running turn; the worker reads it at its next step, and a 'user-message'
   * event reports the read. Returns false (nothing written) once the turn's
   * result has arrived or the process is gone; the caller then delivers the
   * message as the next turn. true means accepted, not read: a message still
   * unread when the process exits is listed in JobResult.unreadInput.
   */
  send?(text: string): boolean;
}

export interface Provider {
  name: string;

  /**
   * True when the binary exists on PATH *and* is plausibly usable.
   * Must be cheap, must not require a TTY, and must never throw.
   * registry.detectAvailable() runs this for every provider.
   */
  available(): Promise<boolean>;

  /**
   * Start a worker. Failures, including a binary that cannot be started at all
   * (ENOENT, bad cwd), arrive through the returned handle's waitForResult()
   * as status 'spawn-failed' — never as a rejection.
   */
  spawn(spec: SpawnSpec): Promise<WorkerHandle>;

  /**
   * Report the sandbox/permission posture `spawn(spec)` WILL apply, derived from
   * the same code path that builds argv (not a parallel guess). Pure, no I/O.
   */
  describeSandbox?(spec: Pick<SpawnSpec, 'unrestricted' | 'readOnly' | 'artifactPath'>): SandboxInfo;

  /**
   * True when the CLI can change reasoning effort per run (a flag or a model-id
   * variant). Default true. When false, forge/service.ts does not ask for one
   * and records the request as a warning instead of an applied effort.
   */
  readonly supportsEffort?: boolean;

  readonly defaultUnrestricted?: boolean | 'always';

  /**
   * True when a running worker accepts messages mid-turn (WorkerHandle.send and
   * the 'user-message' event). Absent means false. Only claude has it.
   */
  readonly liveInput?: boolean;

  /**
   * The provider's own configured default model/effort, read from its config
   * file only. Sync, no CLI, no network: safe on the spawn hot path.
   */
  harnessDefaults?(): { model?: string; effort?: string };

  /** Discover models. Optional; never throws. Must be lazy (never called at startup). */
  listModels?(options?: ListModelsOptions): Promise<ModelCatalog>;
}

export interface ModelInfo {
  id: string;
  label: string;
  efforts: string[];
  defaultEffort?: string;
}

export interface ModelCatalog {
  provider: string;
  models: ModelInfo[];
  defaultModel?: string;
  defaultEffort?: string;
  defaultSource: 'harness-config' | 'unknown';
  source: 'live' | 'cache' | 'static';
  stale: boolean;
  verified: boolean;
  error?: string;
  probeFailed?: boolean;
}

export interface ListModelsOptions {
  timeoutMs?: number;
}

export interface SandboxInfo {
  sandbox: string;
  flags: string[];
  readOnlyEnforced: boolean;
}
