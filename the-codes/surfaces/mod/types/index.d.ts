export type RadarStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'attention'
  | 'unknown';

export type ContinuationKind = 'follow-up' | 'steer';

export interface RadarJob {
  readonly id: string;
  readonly name?: string | null;
  readonly workerId: string;
  readonly turn: number;
  readonly role?: string | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly acceptance?: RadarAcceptance;
  readonly changedFileCount?: number | null;
  readonly failureReason?: string | null;
  readonly failureDetail?: string | null;
  readonly lastEventAt?: number | null;
  readonly liveness?: { readonly state: 'active' | 'in-tool' | 'waiting' | 'silent' | 'dead'; readonly silentForMs: number; readonly since: number | null; readonly forMs: number; readonly tool?: string } | null;
  readonly pipeline?: string | null;
  readonly stage?: string | null;
  readonly attempt?: number | null;
  readonly latestSummary?: string | null;
  readonly summarySource?: 'worker' | null;
  readonly status: RadarStatus;
  readonly startedAt: number | null;
  readonly chainStartedAt?: number | null;
  readonly endedAt: number | null;
  readonly toolCount: number | null;
  readonly activity: string;
  readonly task: string;
  readonly prompt?: string | null;
  readonly preamble?: string | null;
  readonly messages?: readonly { readonly sender: 'follow_up' | 'steer'; readonly text: string }[];
  readonly warnings: readonly { code: string; message: string }[];
  readonly report: string | null;
  readonly reasoning: string | null;
  readonly progress?: ProgressDigest | null;
  readonly supersededBy?: string | null;
  readonly followedBy?: string | null;
  readonly continuedFrom?: string | null;
  readonly continuationKind?: ContinuationKind | null;
  readonly pendingSteers?: number | null;
  readonly pendingMessages?: number | null;
  readonly staleReads?: readonly string[] | null;
  /** The worker's own sub-agents (an agy swarm or agy sub-agents), from team.json; absent when it has none. */
  readonly team?: Team | null;
  readonly raw: Record<string, unknown>;
}

/**
 * Sub-agents a worker started inside its own harness. Agent Smith does not run
 * or steer them; the provider adapter observes them and the writer stores the
 * latest snapshot in the job's team.json. Every field is what the provider
 * itself reported; nothing is guessed.
 */
export type TeamSource = 'agy-swarm' | 'agy-subagents';

/** The provider's own word for where a member stands. agy reports working | waiting | killed. */
export type TeamMemberState = 'working' | 'waiting' | 'done' | 'failed' | 'killed';

export interface TeamMember {
  /** Stable within the team: the member's name (agy swarm) or its conversation id. */
  readonly id: string;
  readonly name: string;
  /** `coordinator`, `worker`, or the sub-agent's role line. */
  readonly role: string;
  readonly model: string | null;
  /** The model as the provider shows it (`Gemini 4 Neon (High)`). */
  readonly modelLabel: string | null;
  /** One line: what the member was asked to do (plan task line, else first line of its brief). */
  readonly task: string | null;
  readonly state: TeamMemberState;
  /** A short phrase for what it is doing now (`git show …/trace.rs`), or its last step. */
  readonly activity: string | null;
  readonly toolCount: number;
  readonly tokensOut: number | null;
  /** Epoch ms. */
  readonly startedAt: number | null;
  readonly lastEventAt: number | null;
  /** Its newest board post: sequence number and first line. */
  readonly lastPost: { readonly seq: number; readonly text: string } | null;
}

export interface Team {
  readonly schema: 1;
  readonly source: TeamSource;
  readonly title: string | null;
  /** Newest board sequence number (agy swarm). */
  readonly boardHead: number | null;
  /** Members other than the worker itself (the coordinator is the worker and is never listed). */
  readonly members: readonly TeamMember[];
  /** Epoch ms of the snapshot. */
  readonly updatedAt: number;
}

/** members/<memberId>.json: a bounded detail snapshot for one member, like view.json for a worker. */
export interface MemberView {
  readonly schema: 1;
  readonly id: string;
  readonly name: string;
  /** Its full brief, when the provider shows it. */
  readonly brief: string | null;
  /** Its newest board post in full, or its final reply. */
  readonly report: string | null;
  readonly timeline: readonly ActivityEvent[];
  readonly truncated: boolean;
}

export type ActivityEvent =
  | { sequence: number; kind: 'assistant'; at: string; text: string }
  | { sequence: number; kind: 'tool'; at: string; stepIndex: number; tool: string; input: string; output: string; state: string }
  | { sequence: number; kind: 'message'; at: string; text: string; delivery: 'next-step' | 'turn-start'; sender: 'follow_up' | 'steer' };

export interface RadarAcceptance {
  readonly state: 'accepted' | 'rejected' | 'unchecked';
  readonly pending?: boolean;
  readonly budgetMs?: number;
  readonly running?: string;
  readonly checks: readonly {
    name: string; ok: boolean; outputTail: string;
    reason?: string; timedOut?: boolean; signal?: string | null; skipped?: string;
  }[];
}

declare module 'claude-code' {
  /**
   * State the host persists for this plugin, keyed by plugin name.
   *
   * These atoms MUST be declared at module scope, outside the hook closures.
   * An atom created inside `register()` would be a new store on every hot
   * reload, so a reload would silently drop the user's selection and any job
   * state the pane had accumulated.
   */
  interface PluginState {
    'agent-smith': {
      selected: string | null;
      pinnedTurnId: string | null;
      now: number;
      follow: boolean;
      taskOpen: boolean;
      listPage: number;
      paneOpen: boolean;
      expandedTools: string[];
      readError: string | null;
      bandJobs: RadarJob[];
      nativeTaskLinks: Record<string, {
        taskId: string;
        status: 'in_progress' | 'completed' | 'deleted';
        fingerprint: string;
        doneAt?: number;
      }>;
      bandConfig: { repo: string; colour: boolean; source: 'cwd' | 'launch' };
      notices: { kind: 'job' | 'run'; id: string; workerId?: string; fromTurn?: number; readHead?: string; at: number; until: number; saidAttention?: boolean; saidDead?: boolean; saidExited?: boolean; saidStageAttention?: string[] }[];
      launched: { jobs: string[]; runs: string[] };
      listScope: 'session' | 'all';
    };
  }
}

export type ProgressPhase = 'starting' | 'exploring' | 'editing' | 'testing' | 'running';
export interface ProgressDigest {
  readonly phase: ProgressPhase;
  readonly filesRead: number;
  readonly searches: number;
  readonly edited: readonly string[];
  readonly editedCount: number;
  readonly commands: number;
  readonly testRuns: number;
  readonly lastTestFailed: boolean;
  readonly repeat: { readonly label: string; readonly count: number } | null;
}
