/**
 * band.ts — the BAND's own decisions. Presentation shared with the pane is NOT
 * re-declared here; it is imported from ./format.ts.
 *
 * WHY THIS FILE EXISTS, SEPARATE FROM register.tsx
 * ────────────────────────────────────────────────
 * A Claude Code hooks module may only import `claude-code` and files inside the
 * plugin's own folder, and `claude-code` only resolves inside Claude Code. So a
 * test that imports `register.tsx` cannot run under `node --test`. Everything
 * testable therefore lives one module over, in modules with no JSX and no
 * `claude-code` import. register.tsx is then a thin shell: read state, resolve
 * elements, paint.
 *
 * WHAT IS HERE AND WHAT IS NOT
 * ────────────────────────────
 * NOT here, because ./format.ts already owns it and both surfaces must agree:
 *   pickGlyph · pickColor · isTerminal · elapsed · elapsedCell · toolCountCell
 *   · ellipsis · oneLine · describeTool · describeActivity · formatJobLine
 * Those are re-exported from the bottom of this file so the band's render code
 * has ONE import site for "how a job looks" and cannot drift from the pane's.
 *
 * HERE, because they are band-specific and the pane has no use for them:
 *   noColor · isShown · rowBudget · reconcile · buildLine · LINGER_MS
 *
 * THE RULES THIS FILE ENCODES (agent-configs/shared/TERMINAL-UI.md)
 * ───────────────────────────────────────────────────────────────────
 *   L22-35  Nothing moves unless the user caused it. → the band never inserts a
 *           row in response to the clock, and `rowBudget` bounds the row count.
 *   L48-55  A line reads in its first 40 columns. → identity first.
 *   L61-87  Colour is never the only channel; dimColor for secondary, NEVER
 *           `gray` (a fixed colour that vanishes on light or dark).
 *   L124-135 wrap="truncate-end" everywhere; elapsed LAST; fixed-width clock.
 *   L147-158 4 rows then `+N more`; 30 s linger; 1 s clock gated on visibility.
 *   L170-176 No jobs → render nothing; yield to `next(e)`; skip on hasSurvey.
 */

import {
  ELAPSED_WIDTH,
  elapsedCell,
  ellipsis,
  isTerminal,
  pickColor,
  pickGlyph,
} from './format.ts';
import type { RadarJob, RadarStatus } from '../types/index.d.ts';

export { elapsedCell, isTerminal, pickColor, pickGlyph, ellipsis } from './format.ts';
export { formatJobLine } from './format.ts';

/* ────────────────────────────────────────────────────────────────────────────
 * TIMING (TERMINAL-UI.md L147-162)
 * ────────────────────────────────────────────────────────────────────────────
 * Both numbers come from TERMINAL-UI.md, which took them from the two shipped
 * reference mods. Note 1000 is not arbitrary: the elapsed cell is the fastest
 * thing a person reads and the seconds digit is the only thing that changes, so
 * 1 Hz is exact rather than merely frequent.
 */

/** How long a finished job stays in the band. TERMINAL-UI.md L150, both mods. */
export const LINGER_MS = 30_000;

/** Rows the band draws before `+N more`. TERMINAL-UI.md L151. */
export const BAND_ROWS = 4;

/**
 * How far past the linger the tick keeps drawing.
 *
 * A finished job's row has to disappear ~30s after it finished, and the band
 * clock is what redraws it. Without this cushion the row survives one extra
 * tick — `isShown` is true at 29_999ms and false at 30_001ms — and the row you
 * were reading blinks out for one frame. Both reference mods add 3s for exactly
 * this reason. This is rule #1 of TERMINAL-UI.md (nothing moves unless the user
 * caused it) arriving as a flicker rather than as a row count change.
 */
export const TICK_CUSHION_MS = 3000;

/* ────────────────────────────────────────────────────────────────────────────
 * NO_COLOR (TERMINAL-UI.md L88-89, https://no-color.org/)
 * ────────────────────────────────────────────────────────────────────────────
 * The six accessibility affordances, and what this band does about each:
 *
 *   1. colour is never the only channel → pickGlyph always draws, and every
 *      state has a distinct one. Works with colour entirely removed.
 *   2. prefers-reduced-motion → the band has ZERO animation and no spinner
 *      (TERMINAL-UI.md L180-196). There is nothing to disable, which is the
 *      cheapest possible answer to this affordance.
 *   3. NO_COLOR (any non-empty value) → accents dropped, glyph and bold kept.
 *   4. prefers-contrast: more → bold survives with colour off; that is the
 *      contrast affordance a terminal actually has.
 *   5. `--ax-screen-reader` renders flat text and strips decoration. The band
 *      still reads because the glyph IS the state. Nothing to detect: there is
 *      no API, and guessing would be worse than relying on the glyph — which is
 *      what TERMINAL-UI.md L214 tells us to do.
 *   6. TERM=dumb / FORCE_COLOR=0 → treated as the same request as NO_COLOR.
 *
 * `noColor` takes the environment as an argument so it is testable with no
 * engine. register.tsx supplies it from `$.env.get`, which requires each
 * variable name to be spelled as a string literal (VERIFIED: a computed name is
 * refused at compile time).
 */
export function noColor(env: {
  readonly NO_COLOR?: string;
  readonly FORCE_COLOR?: string;
  readonly TERM?: string;
}): boolean {
  // no-color.org: present AND non-empty means "no colour". An exported-but-blank
  // NO_COLOR= is explicitly not a request, so it must not disable colour.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return true;
  const force = env.FORCE_COLOR;
  if (force === '0' || force === 'false') return true;
  if (env.TERM === 'dumb') return true;
  return false;
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE LINE
 * ────────────────────────────────────────────────────────────────────────────
 * Shape, in TERMINAL-UI.md's own hierarchy order (L41-46):
 *
 *   identity → liveness (clock, tools) → activity, with elapsed LAST.
 *
 *   running : ` ● implement-musm82da  341 tools · cargo test --workspace 12m04s`
 *   done    : ` ✓ research-muroabc finished · 8 tools 48s`
 *   failed  : ` ✗ implement-mursjrt2 failed · agy_error 43m48s`
 *   canceled: ` · implement-musledug canceled 01m15s`
 *   unknown : ` ? implement-foo no state yet 02m04s`
 *
 * THE ONE PLACE THE BAND AND THE PANE DISAGREE, ON PURPOSE
 * ────────────────────────────────────────────────────────
 * format.ts's `formatJobLine` puts the clock SECOND and relies on
 * `ELAPSED_WIDTH` right-alignment to keep the columns steady. That is correct
 * for a pane, whose rows are compared against each other in a list.
 *
 * The band puts it LAST, and the reason is that TERMINAL-UI.md L129-132 is
 * about a property the band has and the pane does not: the band's clock is the
 * ONLY thing that changes between two renders of an otherwise identical line, so
 * a ticking field in the middle of it drags the activity text sideways every
 * second. In a pane that never happens (nothing redraws a pane row just because
 * time passed) and the fixed-width cell is the better answer there.
 *
 * Both are 6 columns wide, so the two surfaces still agree on how much room the
 * clock takes. They differ in ORDER only. See README.md §Deviation.
 */

/** One assembled line: the two Text segments plus the exact plain string. */
export interface BandLine {
  /** First segment, drawn in the accent and (for running) bold. */
  readonly head: string;
  /** Second segment, drawn `dimColor`. Ends with the elapsed time. */
  readonly tail: string;
  /** `head + tail`: exactly what the terminal shows, for tests and width work. */
  readonly plain: string;
  readonly glyph: string;
  /** null means "pass no colour prop at all" — NO_COLOR, canceled, unknown. */
  readonly accent: 'yellow' | 'green' | 'red' | 'cyan' | undefined;
  readonly bold: boolean;
}

/** ` · ` — one column each. Part of the tail's budget. */
const SEP = ' · ';

/** Only running and attention are bold: the states that are still in flux. */
function bold(status: RadarStatus): boolean {
  return status === 'running' || status === 'attention';
}

/**
 * The outcome word. Null when the job is live and there is nothing to report.
 *
 * `warnings: true` on a `succeeded` job becomes words ("finished, warnings"),
 * not a different glyph or a different colour. Two reasons. harness/normalize.ts
 * is explicit that a non-empty result with a warnings flag stays `succeeded`, so
 * a colour change would contradict the type contract; and TERMINAL-UI.md L85-87
 * reserves red for real failures, and a job that produced a full report is not
 * one.
 */
function verdict(job: RadarJob): string | null {
  switch (job.status) {
    case 'running':
    case 'attention':
      return null;
    case 'succeeded':
      return job.warnings.length > 0 ? 'finished, warnings' : 'finished';
    case 'failed': {
      // The first warning code is the useful one and it is a stable string,
      // chosen by harness/normalize.ts (suspicious_success, empty_output,
      // tool_error, ...). Its MESSAGE is prose and is deliberately not used
      // here: TERMINAL-UI.md L52-54 keeps sentences off a band line.
      const code = job.warnings[0]?.code;
      return code === undefined || code === '' ? 'failed' : `failed · ${code.replace(/_/g, ' ')}`;
    }
    case 'canceled':
      return 'canceled';
    case 'unknown':
      return 'no state yet';
  }
}

/**
 * Assemble one band line.
 *
 * `now` is a parameter, never `Date.now()`: a formatter that reads the clock
 * cannot be tested at a boundary, and "is this still inside its 30 s?" is
 * exactly a boundary question.
 *
 * `colour: false` drops the accent and nothing else — bold stays, because bold
 * is a contrast affordance rather than a colour.
 */
export function buildLine(
  job: RadarJob,
  now: number,
  options: { readonly colour?: boolean } = {},
): BandLine {
  const colour = options.colour !== false;
  const glyph = pickGlyph(job.status);
  const accent = colour ? pickColor(job.status) : undefined;
  const isBold = bold(job.status);

  // L48-55: identity first, and it must survive the first 40 columns. Nothing
  // precedes the id, because the id is the one field that cannot be dropped.
  const head = ` ${glyph} ${job.id} `;

  const parts: string[] = [];
  const say = verdict(job);
  if (say !== null) parts.push(say);

  // Terse activity, truncated at the source (TERMINAL-UI.md L195-196). Only for
  // live jobs: what a finished job was last doing is not news. It goes BEFORE the
  // tool count so the quantity the eye scans for sits next to the clock.
  if (!isTerminal(job.status) && job.activity !== '') {
    parts.push(ellipsis(job.activity, 40));
  }

  // Tool count is a real quantity counted from events.jsonl, and it is OMITTED
  // entirely when null: agy-staff deletes events.jsonl on a warning-free success
  // (HAZARD A), so for a cleanly finished job there is genuinely no count on disk.
  // Printing `0 tools` is a fabrication and `? tools` implies we looked and failed.
  if (job.toolCount !== null) parts.push(`${job.toolCount} tools`);

  // Elapsed LAST (L129-132), always present, always ELAPSED_WIDTH columns. A job
  // with no known start gets a BLANK cell rather than `0s`: harness/normalize.ts
  // refuses to invent a start time and neither do we, and a confident `0s` about
  // a job that has been working for half an hour is a lie.
  const span = job.startedAt === null ? null : (job.endedAt ?? now) - job.startedAt;
  const clock = span === null ? '' : elapsedCell(span);

  const tail = parts.length > 0 ? `${parts.join(SEP)}${SEP}${clock}` : clock;
  return { head, tail, plain: `${head}${tail}`, glyph, accent, bold: isBold };
}

/* ────────────────────────────────────────────────────────────────────────────
 * VISIBILITY, BUDGET, AND NOT FLICKERING
 * ────────────────────────────────────────────────────────────────────────────
 * These three are what keep TERMINAL-UI.md's one rule (L22-35) true.
 */

/**
 * Should this job be on screen at all?
 *
 * Live (running or attention): always. Terminal: for LINGER_MS after it
 * actually finished.
 *
 * MEASURED FROM `endedAt` — the instant agy-staff wrote the terminal file — AND
 * NOT from when we first noticed. That distinction is load-bearing against the
 * real corpus: `/Users/gathrid/Repos/renyi/.agy-staff/jobs` holds 20 jobs
 * finished hours ago, and a band that showed four of them at session start would
 * be asserting that work is in flight when it is not. The 30 s therefore also
 * serves as the honest bound on "I missed the finish, and that is fine".
 */
export function isShown(job: RadarJob, now: number): boolean {
  if (!isTerminal(job.status)) return true;
  if (job.endedAt === null) return false;
  return now - job.endedAt < LINGER_MS;
}

/** How many rows the band may paint, and how many jobs it is hiding. */
export interface BandBudget {
  readonly rows: readonly RadarJob[];
  readonly hidden: number;
}

/**
 * Pick the rows to paint: at most BAND_ROWS, never more than the engine's own
 * `maxRows` allows, and never tall enough that the engine has to scroll us.
 *
 * TERMINAL-UI.md L151: cap at 4, then `+N more`. The engine reserves one row of
 * `maxRows` for its own "n more" line when a tree is taller than the site
 * (claude-code.d.ts, AbovePrompt props), so we take `maxRows - 1` and spend the
 * last row on our own overflow line. Clamped to 1, because a 1-row band that
 * shows one job beats one that shows nothing.
 */
export function rowBudget(shown: readonly RadarJob[], maxRows?: number): BandBudget {
  let cap = BAND_ROWS;
  if (typeof maxRows === 'number' && Number.isFinite(maxRows)) {
    cap = Math.max(1, Math.min(cap, Math.floor(maxRows) - 1));
  }
  return { rows: shown.slice(0, cap), hidden: Math.max(0, shown.length - cap) };
}

/** The overflow line. Dim, and it names the command that opens the rest. */
export function overflowLine(hidden: number): string {
  return `   +${hidden} more · /agent-smith`;
}

/**
 * Fold a fresh reading of a job over what we already knew, so a transient read
 * failure cannot make a line blink out and back.
 *
 * THE HAZARD. agy-staff rewrites progress.json every ~100ms and DELETES it on a
 * warning-free success (HAZARD A in the-codes/harness/agy-staff.ts). A reader
 * that infers "job gone" from "progress.json gone" makes the row vanish for a
 * few hundred milliseconds and reappear as done — the flicker TERMINAL-UI.md's
 * one rule forbids, arriving through visibility instead of row count.
 *
 * THE FIX HAS TWO HALVES, and this function is only the second.
 *
 *   a) Terminal state is anchored ONLY on `<id>.result.md.status.json`, which
 *      agy-staff always writes. Nothing in ./jobs.ts reads terminal state out of
 *      an absent file. That half is the load-bearing one and it lives there.
 *
 *   b) Even so, a poll can fail for reasons unrelated to the job (EBUSY on the
 *      directory, a half-written JSON body). So a terminal status we have
 *      already established is STICKY here: once done/failed/canceled, only a
 *      fresh terminal reading may move it, and a reading that says nothing
 *      leaves it exactly as it was.
 *
 * The stickiness is deliberately ONE-WAY. Upgrading running → done on new
 * evidence is correct and must happen. Downgrading done → running or
 * done → unknown on absent evidence is the flicker, and is refused.
 */
export function reconcile(previous: RadarJob | undefined, next: RadarJob): RadarJob {
  if (previous === undefined) return next;

  if (isTerminal(previous.status) && !isTerminal(next.status)) {
    // Rule (b): a terminal row never un-finishes on weaker evidence.
    return previous;
  }

  if (isTerminal(previous.status) && previous.endedAt !== null && next.endedAt === null) {
    // A fresh reading that could not parse status.json this tick. Keeping the
    // old instant is what stops the row's clock restarting from zero while it
    // still has LINGER_MS left to live.
    return { ...next, startedAt: previous.startedAt, endedAt: previous.endedAt };
  }

  if (next.activity === '' && previous.activity !== '') {
    // progress.json mid-write: the activity clause is absent, not "idle".
    return { ...next, activity: previous.activity };
  }

  // A tool count is monotonic for the life of a job. A partial read that cannot
  // see events.jsonl must not walk the number backwards.
  if (previous.toolCount !== null && (next.toolCount === null || next.toolCount < previous.toolCount)) {
    return { ...next, toolCount: previous.toolCount };
  }

  return next;
}