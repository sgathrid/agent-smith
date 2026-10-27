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
 *   pickGlyph · pickColor · isTerminal · isRecessive · elapsed · elapsedCell
 *   · fitCell · jobLabel · jobDetail · describeTool · describeActivity
 *   · formatJobLine · formatJobRow
 * formatJobRow is the band AND the pane's row, from one function with one set of
 * cells. That is deliberate: two formatters for the same visual object is how
 * the band and the pane stop agreeing about what a job looks like.
 *
 * HERE, because they are band-specific and the pane has no use for them:
 *   noColor · isShown · rowBudget · reconcile · LINGER_MS
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
  bandColumns,
  elapsedCell,
  fitBandColumns,
  formatJobRow,
  isTerminal,
  paneColumns,
  pickColor,
  pickGlyph,
  type RowOptions,
} from './format.ts';
import type { RadarJob } from '../types/index.d.ts';

export { elapsedCell, isTerminal, pickColor, pickGlyph } from './format.ts';

/* ────────────────────────────────────────────────────────────────────────────
 * TIMING (TERMINAL-UI.md L147-162)
 * ────────────────────────────────────────────────────────────────────────────
 * Both numbers come from TERMINAL-UI.md, which took them from the two shipped
 * reference mods. Note 1000 is not arbitrary: the elapsed cell is the fastest
 * thing a person reads and the seconds digit is the only thing that changes, so
 * 1 Hz is exact rather than merely frequent.
 */

/**
 * How long a finished job stays in the band (and in the host task list). Shorter
 * than TERMINAL-UI.md's 30 s on purpose: the completion hook and `/forge` already
 * carry the result, so a lingering row only clutters the prompt.
 */
export const LINGER_MS = 10_000;

/** Rows the band draws before `+N more`. TERMINAL-UI.md L151. */
export const BAND_ROWS = 4;

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
 * The band row is the PANE row with the tool count switched off and a fixed
 * budget, and both come out of format.ts's `formatJobRow`. That is the whole
 * reason this section is short: the row used to be built here, separately, with
 * its own field order and its own head/tail split, and the two surfaces drifted.
 *
 *   running : ` ⏺ the output gate core              running tests  28m03s`
 *   needs   : ` ⚠ close the registration leaks       no output 16m  14m48s`
 *   done    : ` ✓ show the doctor each column        finished    1m15s`
 *   failed  : ` ✗ registration uses the column       failed ∙ tool error  4m36s`
 *
 * WHAT THE BAND DOES NOT SHOW, and why each is right:
 *
 *   the job id      30 columns of which 9 are a constant mode and 9 a UUID
 *                   fragment. The task is the identity; the id is in the pane.
 *   the mode        `implement` is 100% of a 20-job corpus. A column whose every
 *                   value is the same value is not a column.
 *   the tool count  TERMINAL-UI.md §Hierarchy puts counts outside a glance row,
 *                   and this is the glance surface. It survives in the PANE,
 *                   where it is a liveness signal on a running job.
 *   the raw command `cargo tree -p renyi-mcp -e features -i` is precise and
 *                   unreadable. The band says `running tests`.
 *
 * WHAT THE BAND STILL SHOWS: task, state, elapsed. That is the whole contract,
 * and the budget is chosen so a band row reads completely at 80 columns.
 *
 * THE BAND/PANE ORDERING DEVIATION IS GONE. It used to be that the band put the
 * clock last and the pane put it second. Both now put it last, because
 * TERMINAL-UI.md's rule is about a property the band has — the ticking field
 * drags whatever follows it sideways — and the pane has no reason to violate a
 * rule that costs it nothing. See format.ts's header comment.
 */

/** One assembled line: the Text segments plus the exact plain string. */
export type BandLine = import('./format.ts').JobRow;

/**
 * Assemble one band line.
 *
 * `now` is a parameter, never `Date.now()`: a formatter that reads the clock
 * cannot be tested at a boundary, and "is this still inside its 30 s?" is
 * exactly a boundary question.
 *
 * `colour: false` drops the accent and nothing else — bold stays, because bold
 * is a contrast affordance rather than a colour. `width`, the columns the host
 * gives the row, fits the cells to it; without one the fixed band budget holds.
 */
export function buildLine(
  job: RadarJob,
  now: number,
  options: { readonly colour?: boolean; readonly width?: number; readonly longestLabel?: number } = {},
): BandLine {
  const columns = options.width === undefined ? bandColumns()
    : options.longestLabel === undefined ? { ...paneColumns(options.width), tools: false }
    : { ...fitBandColumns(options.width, options.longestLabel), tools: false };
  const row = formatJobRow(job, { now, ...columns } satisfies RowOptions);
  const colour = options.colour !== false;
  return {
    ...row,
    accent: colour ? row.accent : undefined,
  };
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
 * be asserting that work is in flight when it is not. The linger therefore also
 * serves as the honest bound on "I missed the finish, and that is fine".
 */
export function isShown(job: RadarJob, now: number): boolean {
  if (job.supersededBy && isTerminal(job.status)) return false;
  if (!isTerminal(job.status) || job.acceptance?.pending) return true;
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
  return `   +${hidden} more ∙ /forge`;
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

  if (
    isTerminal(previous.status) && previous.status === next.status &&
    previous.endedAt !== null && next.endedAt !== null && next.endedAt > previous.endedAt
  ) {
    // A terminal row whose end was inferred ("now") on each read would otherwise
    // linger forever; the first instant we saw it finish is the end.
    return { ...next, endedAt: previous.endedAt };
  }

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
