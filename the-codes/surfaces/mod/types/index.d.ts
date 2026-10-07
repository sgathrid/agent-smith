/**
 * types/index.d.ts — the mod's own state shapes, plus the plugin-state
 * declaration the mod API needs.
 *
 * WHY THE MOD DEFINES ITS OWN JOB SHAPE INSTEAD OF USING ObservedJob:
 *
 * harness/ObservedJob is the right shape for a *store row* and the wrong shape
 * for a *list row*. It carries `raw: Record<string, unknown>` (the whole provider
 * payload — good for a debug dump, dead weight for rendering), it carries no tool
 * history and no activity, and its `startedAt` is honestly `null` for agy-staff
 * because agy-staff does not record a start time (normalize.ts says so and
 * refuses to invent one).
 *
 * The pane needs three things ObservedJob does not have:
 *   - toolCount, counted from events.jsonl (a real quantity, shown as-is)
 *   - activity, one terse phrase for the most recent tool
 *   - a start time, derived from the worker-started line in .log
 *
 * So `resolve()` (hooks/jobs.ts) is the single place that turns one job on disk
 * into one drawable row. Keeping the mapping in one function is what makes the
 * band and the pane incapable of disagreeing about what a job looks like — and
 * `resolve()` is the ONLY function that decides status, for either surface.
 */

// ── the pane's row shape ────────────────────────────────────────────────────

/**
 * The six states the pane can draw.
 *
 * Deliberately NOT the same union as harness's ObservedStatus: the pane adds
 * `attention` (a running job that has gone silent, surfaced from
 * core/liveness.ts's stall verdict) because "needs you" is a thing a human must
 * be able to tell apart from "still working", and the pane has no other way to
 * say it. The mapping is total and lives in projectRadarJob().
 */
export type RadarStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'attention'
  | 'unknown';

/**
 * One job, as the pane draws it. Immutable; treat as a snapshot.
 *
 * `ObservedJob` in harness/types.ts is explicitly a snapshot too (point 5 of its
 * reconciliation note): readers must be re-callable at any cadence and two reads
 * are two independent observations that are allowed to disagree. Nothing in the
 * pane holds one of these across ticks expecting it to stay fresh.
 */
export interface RadarJob {
  /** agy-staff's job id, e.g. `implement-musm82da-f1dc1fe4`. */
  readonly id: string;

  /** Lifecycle state as the pane draws it. See RadarStatus. */
  readonly status: RadarStatus;

  /**
   * Epoch ms, or null when no start could be established.
   *
   * NULL IS A REAL VALUE AND MUST BE RENDERED AS A BLANK CELL, NOT AS 0.
   * A job with no known start has an unknown elapsed time; printing `0s` would
   * be a fabrication and printing `Infinity` would be worse.
   */
  readonly startedAt: number | null;

  /** Epoch ms once terminal, else null. */
  readonly endedAt: number | null;

  /**
   * Tool invocations counted from events.jsonl, or null when the file is gone.
   *
   * NULL IS COMMON AND CORRECT. agy-staff deletes events.jsonl on a warning-free
   * success (hazard A), so most finished jobs have no count. Inventing 0 there
   * would draw a confident lie.
   */
  readonly toolCount: number | null;

  /** Terse "what it is doing" phrase, already truncated at the source. '' if idle. */
  readonly activity: string;

  /** The task description, first line only. Never the whole prompt. */
  readonly task: string;

  /** Non-fatal signals, provider codes preserved. Empty means "nothing flagged". */
  readonly warnings: readonly { code: string; message: string }[];

  /**
   * The de-polluted final report, or null.
   *
   * Run through `stripSystemNotifications()` (hazard C). Populated only when the
   * reader is asked for it — the pane's detail view asks, the band does not,
   * because the band would otherwise re-read 256 KB of markdown every 3 s to
   * draw a six-character line. `null` therefore means "not requested" as well as
   * "nothing there", and the band must never read it.
   */
  readonly report: string | null;

  /** Current reasoning text, or null when the job has not produced any yet. */
  readonly reasoning: string | null;

  /** Raw provider payload, for the pane's debug view only. Never parsed by a surface. */
  readonly raw: Record<string, unknown>;
}

/** One tool call, for the detail pane's history. */
export interface ToolEntry {
  /** Epoch ms, or null if the event carried no usable time. */
  readonly at: number | null;
  /** agy tool name, e.g. `run_command`. */
  readonly tool: string;
  /** Terse description of what it was called with. */
  readonly label: string;
  /** Truncated output preview, or '' when there was none. */
  readonly output: string;
  /** 'done' | 'error' | 'active', from the event's own state field. */
  readonly state: string;
}

// ── mod plugin state ────────────────────────────────────────────────────────

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
      /** Job id the user has opened in the detail pane, or null for the list. */
      selected: string | null;
      /** Scratch: 'list' | 'detail'. Redundant with `selected`, kept for clarity. */
      view: 'list' | 'detail';
      /** Clock the pane subscribes to so elapsed cells tick. The BAND writes it. */
      now: number;
      /** Job ids dismissed with `c`; filtered against on read, never deleted. */
      cleared: string[];
      /**
       * The band's own snapshot of the jobs directory, from the 3 s poll.
       *
       * SEPARATE FROM THE PANE'S READ ON PURPOSE. The pane re-reads on demand —
       * a keypress is a deliberate act and deserves fresh data — while the band
       * is driven by a poll and must never block a redraw on 20 file reads. Both
       * are read-only projections of the same files, so they cannot disagree
       * about the truth, only about when they looked.
       */
      bandJobs: RadarJob[];
      /**
       * Resolved once at session start: which repo to watch, and whether colour
       * is allowed (NO_COLOR / FORCE_COLOR / TERM=dumb). Re-reading env per frame
       * would be a pointless syscall per redraw.
       *
       * THE PANE READS `repo` FROM HERE TOO, and that is the point. `$.cwd` is
       * refused by the mod loader, so the session cwd has to be captured once and
       * folded in here; the pane reading the result means the band and the pane
       * cannot end up pointed at different repos.
       */
      bandConfig: { repo: string; colour: boolean };
    };
  }
}