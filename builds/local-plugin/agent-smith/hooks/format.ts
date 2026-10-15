/**
 * format.ts — PURE presentation logic for the /forge pane and the band.
 *
 * WHY THIS FILE IS NOT `register.tsx`:
 * `node --test --experimental-strip-types` CANNOT load a .tsx file — TypeScript's
 * type stripping has no JSX transform (verified: any JSX element in an imported
 * .tsx is a hard parse error). So if the formatters lived next to the render
 * code they would be untestable under the repo's own test runner, which defeats
 * the point of making them pure in the first place. Everything testable lives
 * here, in a module with zero imports and zero I/O. `register.tsx` imports this
 * file and does nothing but lay out what these functions return.
 *
 * NOTHING in here reads the clock, the filesystem, or any atom. "Now" is always
 * a parameter, for the same reason core/liveness.ts does it: a formatter that
 * called Date.now() itself could not be tested at a boundary.
 *
 * THE RULES ENCODED BELOW come from agent-configs/shared/TERMINAL-UI.md. Where a
 * rule needed interpretation the reasoning is inline.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ROW, IN ONE PLACE
 * ─────────────────────────────────────────────────────────────────────────────
 * Every job row in either surface is these four segments, in this order:
 *
 *     {glyph} {label} {detail} {elapsed}
 *       1        2       3        4
 *
 *   1 glyph     EAW=Neutral, one column, always drawn. Never colour alone.
 *   2 label     THE TASK, from `prompt_source.task`. Fixed-width cell.
 *   3 detail    what it is doing (live) or how it ended (terminal). Fixed cell.
 *   4 elapsed   fixed 6 columns, RIGHT-aligned, and LAST — see ELAPSED_WIDTH.
 *
 * WHY THE JOB ID IS NOT ON THE ROW ANY MORE. Measured against the real 20-job
 * corpus in .agy-staff/jobs: every id is `implement-musm82da-f1dc1fe4`. That is
 * 30 columns of which the mode is constant (`implement`, 100% of the corpus, so
 * it is not information) and `-f1dc1fe4` is a UUID fragment that distinguishes
 * nothing a reader can act on. The request the job was actually given sits in
 * `prompt_source.task` and reads "open an agent-built dashboard with real names,
 * decoded inside Renyi". That is the identity. The id survives in the DETAIL
 * view, where it is what you would paste into `agy` to talk about the job.
 *
 * WHY ELAPSED IS LAST AND FIXED-WIDTH. TERMINAL-UI.md §Width: "put the volatile
 * field last — elapsed time ticks every second; if it sits mid-line, everything
 * after it shifts horizontally each tick." The pane used to put the clock second
 * and rely on right-alignment; that is safe (see ELAPSED_WIDTH) but it is a
 * weaker version of the same guarantee than simply putting the field last, and
 * the band already did the latter. Both surfaces now agree, so there is no
 * band/pane ordering deviation left to document.
 */

import type { RadarJob, RadarStatus } from '../types/index.d.ts';
import { REASONS, checksReason, reasonFromText } from './reasons.ts';

// ── glyphs ──────────────────────────────────────────────────────────────────

/**
 * Status → glyph. Single-width ONLY, and never an emoji.
 *
 * TERMINAL-UI.md §Glyphs blesses exactly this set, and every member is
 * EAW=Neutral (one column in every locale, which is a correctness property and
 * not a taste question):
 *
 *     running    ⏺  (U+23FA)    succeeded  ✓  (U+2713)
 *     failed     ✗  (U+2717)    attention  ⚠  (U+26A0)
 *     neutral    ∙  (U+2219)
 *
 * The set this file used to draw — `●` `✓` `✗` `!` `·` `?` — had two defects,
 * both of them the ones TERMINAL-UI.md calls out by name:
 *
 *   1. `●` (U+25CF) and `·` (U+00B7) are East Asian Width **Ambiguous**: one
 *      column in a Western terminal, two in a CJK-locale one. That is the silent
 *      column drift the whole glyph section exists to prevent, and it is why
 *      Claude Code itself ships `U+23FA ⏺` on macOS and `U+25CF ●` everywhere
 *      else — even Anthropic treats the choice as a per-platform negotiation.
 *      `⏺` and `∙` are genuinely neutral.
 *   2. `!` for attention is ASCII punctuation rather than a glyph, and `·` for
 *      canceled collided with the separator the rows used between fields, so a
 *      monochrome reader could not tell a cancelled job from a separator.
 *
 * `canceled` is deliberately NOT `✗`. A cancelled job is not a bug —
 * core/types.ts says so explicitly, and adds that alerting on one trains people
 * to ignore alerts. `unknown` keeps ASCII `?`: neutral width, distinct from all
 * five, and honest about the fact that we do not know.
 */
export function pickGlyph(status: RadarStatus): string {
  switch (status) {
    case 'running':
      return '⏺';
    case 'succeeded':
      return '✓';
    case 'failed':
      return '✗';
    case 'attention':
      return '!';
    case 'canceled':
      return '∙';
    default:
      return '?';
  }
}

/**
 * Status → Text colour. ALWAYS paired with pickGlyph.
 *
 * TERMINAL-UI.md §Colour: "never encode meaning by colour alone". The glyph is
 * the redundant channel, so this function is decoration on top of a decision
 * that has already been made without it. Monochrome terminals lose nothing.
 *
 * `undefined` means "pass no colour prop at all". Nothing secondary is coloured:
 * secondary text is `dimColor`, never a colour and never `gray` (a fixed value
 * that vanishes on one of light/dark).
 */
export function pickColor(
  status: RadarStatus,
): 'blue' | 'green' | 'red' | 'cyan' | undefined {
  switch (status) {
    case 'running':
      return 'blue'; // bold is applied at the call site
    case 'succeeded':
      return 'green';
    case 'failed':
      return 'red';
    case 'attention':
      return 'cyan'; // bold at the call site
    default:
      return undefined; // canceled / unknown: glyph only, dim
  }
}

/** True for the states that have stopped and will never move again. */
export function isTerminal(status: RadarStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

/**
 * True for the states that must NOT be drawn at full strength.
 *
 * TERMINAL-UI.md's own instruction for finished rows is recessive; the brief for
 * this pass sharpens it: finished rows are dim, running and failed pop. So
 * `succeeded`, `canceled` and `unknown` are recessive. `failed` is NOT — it is a
 * terminal state but it is the one terminal state the user has to act on, and
 * dimming it is how a failure becomes the thing nobody reads.
 */
export function isRecessive(status: RadarStatus): boolean {
  return status === 'succeeded' || status === 'canceled' || status === 'unknown';
}

// ── elapsed ─────────────────────────────────────────────────────────────────

/**
 * Duration in ms → a compact clock string.
 *
 * `48s`, `12m04s`, `1h02m`. The seconds field is `padStart(2,'0')` because
 * TERMINAL-UI.md §Width calls for tabular alignment and names the terminal
 * equivalent of `font-variant-numeric: tabular-nums` as fixed-width padding:
 * without it `9s` and `12s` occupy different widths and the column tears.
 *
 * Hours deliberately drop the seconds (`1h02m`, not `1h02m03s`). A band that
 * needs 8 columns for a clock is a band that cannot afford 8 columns; at that
 * scale the seconds digit is noise anyway. See ELAPSED_WIDTH.
 */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(total / 3600)}h${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`;
}

/**
 * Column width for `elapsed()`, in terminal columns.
 *
 * WIDTH IS A CORRECTNESS PROPERTY HERE. `48s`, `12m04s` and `1h02m` are 3, 6 and
 * 5 wide; padStart(6) makes all three occupy 6, so the second that changes is
 * the last character of a constant-width cell and nothing to its right moves
 * when the clock ticks. Remove the padding and the row tears every second.
 */
export const ELAPSED_WIDTH = 6;

/** elapsed(), right-aligned into ELAPSED_WIDTH. */
export function elapsedCell(ms: number): string {
  return elapsed(ms).padStart(ELAPSED_WIDTH);
}

/** The clock cell for one job, or a BLANK cell when the start is unknown. */
export function clockCell(job: RadarJob, now: number): string {
  const span = job.startedAt === null ? null : (job.endedAt ?? now) - job.startedAt;
  // BLANK, never `0s`: harness/normalize.ts refuses to invent a start time for
  // agy-staff and neither do we. A confident `0s` about a job that has been
  // working for half an hour is the one lie this surface must not tell.
  return span === null ? '' : elapsedCell(span);
}

// ── the label: the task, not the job id ─────────────────────────────────────

/**
 * How wide the label cell is before the surface's own budget takes over.
 *
 * The pane computes its real widths from `bodyColumns` (see `paneColumns`); this
 * is the fallback for a caller that has no measurement, and it is sized so a
 * band row reads completely at 80 columns — the width TERMINAL-UI.md calls the
 * floor for a glance surface.
 */
export const BAND_LABEL_WIDTH = 44;

/** The detail cell on a band row. Sized to fit 80 columns beside the label. */
export const BAND_DETAIL_WIDTH = 22;

/** Fixed gutter between two cells. One space, always — never a run of them. */
const GUTTER = ' ';

/** Leading gutter before the glyph, so the row is not flush to column 0. */
const LEAD = ' ';

/** Separator between two facts INSIDE one cell. EAW=Neutral (see pickGlyph). */
export const SEP = '∙';

/**
 * Strip markdown decoration from a task line.
 *
 * Backticks and bold markers are how the prompt was WRITTEN; on a status row
 * they are noise that costs four columns per occurrence, and the real corpus has
 * backticked paths and identifiers in most titles.
 */
function unmarkdown(s: string): string {
  return s.replace(/`+/g, '').replace(/\*\*?|__/g, '');
}

/**
 * The task line itself: first non-empty line, markdown stripped, whitespace
 * collapsed. Never the whole prompt — the real tasks run to 60+ lines.
 */
function firstLine(task: string): string {
  for (const raw of task.split('\n')) {
    const line = unmarkdown(raw).replace(/\s+/g, ' ').trim();
    if (line.length > 0) return line;
  }
  return '';
}

/**
 * Cut a task title down to its subject.
 *
 * TWO CUTS, both derived by reading all 20 real task lines in
 * `.agy-staff/jobs/*.spec.json`:
 *
 *   1. `# Task 5a: the output gate core (Renyi, renyi-core)`
 *      → `the output gate core`
 *      A leading parenthetical in a task title is a REPO/SCOPE qualifier
 *      ("Renyi", "Rust + Tauri", "local and you may edit it"), not the subject.
 *      All 14 template tasks in the corpus end this way. The cut is guarded on
 *      the remainder being long enough to still be a title, so a title that is
 *      nothing but a qualifier survives.
 *
 *   2. `Review of 3b: good work, the core rewrite is right. Two gaps, ...`
 *      → `follow-up · 3b`
 *      Six of the corpus's twenty jobs are follow-ups and all six open that way.
 *      The subject of a review IS the thing reviewed, and `3b` is exactly how
 *      the person refers to it — so the label is that, and the reviewer's prose
 *      (which runs to 4000 characters) is dropped rather than truncated. Pairing
 *      a task with its follow-up is then a two-second scan of the label column.
 *
 * Nothing else is stripped. In particular `# Task 3d: close the registration
 * leaks, default to safe, remember decisions` keeps all three clauses: they are
 * the request, not decoration.
 */
export function deriveTaskLabel(task: string): string {
  const line = firstLine(task).replace(/^#+\s*/, '');
  if (line === '') return '';

  // `Review of <thing>:` → `follow-up · <thing>`
  const review = /^review of\s+([^:]{1,40}):/i.exec(line);
  if (review !== null) {
    const subject = unmarkdown(review[1] ?? '').replace(/\s+/g, ' ').trim();
    if (subject !== '') return `follow-up ∙ ${subject.toLowerCase()}`;
  }

  // `# Task 5a: <title>` / `# Task: <title>` → `<id> · <title>` / `<title>`
  let id = '';
  let rest = line;
  const marker = /^task\s*(?:([0-9a-z]{1,4}(?:-[a-z]{1,4})?)\s*)?:/i.exec(line);
  if (marker !== null) {
    id = (marker[1] ?? '').toLowerCase();
    rest = line.slice(marker[0].length).trim();
  }

  // Cut 1: the leading scope parenthetical.
  const paren = rest.indexOf(' (');
  if (paren >= 12) rest = rest.slice(0, paren);

  // Cut 2: the first sentence. Only on `. ` where the period is not part of a
  // number (`3.9 ms/MB`) and the next character starts a new sentence.
  const sentence = /^([\s\S]*?[^0-9.]\.)(?:\s+[A-Z]|$)/.exec(rest);
  if (sentence !== null) rest = sentence[1] ?? rest;

  rest = rest.replace(/[\s,;:—–-]+$/, '').trim();
  if (rest === '') return id === '' ? '' : id;
  if (id !== '') rest = `${id} ∙ ${rest}`;

  // Sentence-case down, but never an acronym: `PHI-boundary test harness` and
  // `The previous run stopped…` must not become `pHI-…` and `the…` by accident
  // on the first rule and by intent on the second.
  return /^[A-Z][a-z]/.test(rest) ? rest[0]!.toLowerCase() + rest.slice(1) : rest;
}

/**
 * What to show when there is no task line at all.
 *
 * The id, minus its two constant parts. `implement-musm82da-f1dc1fe4` → `musm82da`:
 * still an identifier, but 8 columns instead of 30 and unmistakably a fallback
 * next to a real task title. The full id is one keystroke away in the detail
 * view, so nothing is lost by shortening it here.
 */
export function fallbackLabel(id: string): string {
  const parts = id.split('-');
  if (parts.length >= 3) return parts[1] ?? id;
  return id;
}

/** The row's label: the task if there is one, the id if there is not. */
export function jobLabel(job: RadarJob): string {
  if (typeof job.name === 'string' && job.name.trim() !== '') return job.name.trim();
  const label = deriveTaskLabel(job.task);
  return label === '' ? fallbackLabel(job.id) : label;
}

/**
 * Fit a string into a fixed-width cell, cutting at a word boundary.
 *
 * NO ELLIPSIS CHARACTER, and that is the point. `…` (U+2026) is EAW=Ambiguous —
 * one column in a Western terminal, two in a CJK-locale one — so a truncation
 * marker is exactly the character that would make a fixed-width column drift in
 * the locales the fixed width exists to protect. The cell's right edge is the
 * marker: a label that stops mid-clause at column 44 is visibly a clipped label,
 * because every other row's label starts at the same place and ends at the same
 * place. `cell()` therefore slices to exactly `width` columns, always.
 */
export function fitCell(s: string, width: number): string {
  if (width <= 0) return '';
  if (s.length <= width) return s.padEnd(width);
  const cut = s.slice(0, width);
  const space = cut.lastIndexOf(' ');
  // Only break on a space in the last third: breaking early would throw away a
  // third of the cell to save two characters of raggedness.
  const body = space >= Math.floor(width * 0.6) ? cut.slice(0, space) : cut;
  return body.padEnd(width);
}

/** Collapse all whitespace runs to single spaces and cap the length. */
export function oneLine(s: string, max = 400): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max);
}

/**
 * A backwards-compatible length-capped trim.
 *
 * Kept because the DETAIL view uses it for prose that has no cell to sit in
 * (a report excerpt, a warning message). Those are handed to `wrap="truncate-end"`
 * by the renderer as well, so this is belt and braces rather than the mechanism,
 * and it keeps a hard bound on what a single string can cost.
 */
export function ellipsis(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, Math.max(0, max));
}

/**
 * Why a job failed, in two to four words (reasons.ts is the one classifier).
 * The recorded failure text wins; the first warning is the fallback, and its
 * code names the legacy cases whose message is prose. '' when nothing is known.
 */
export function failureWords(job: RadarJob): string {
  const first = job.warnings[0];
  const text = job.failureReason ?? first?.message ?? null;
  if (text !== null && text.trim() !== '') {
    const words = reasonFromText(text);
    if (words !== REASONS.workerError) return words;
  }
  switch (first?.code ?? '') {
    case 'suspicious_success':
    case 'empty_output':
      return REASONS.noOutput;
    case 'timeout':
      return REASONS.timedOut;
    case 'canceled':
      return 'canceled';
    case 'tool_error':
      return REASONS.workerError;
    case '':
      break;
    default:
      return (first?.code ?? '').replace(/_/g, ' ');
  }
  if (job.acceptance?.state === 'rejected' && job.acceptance.checks.length > 0) return failedChecks(job);
  return text !== null && text.trim() !== '' ? REASONS.workerError : '';
}

/** `checks failed: lint` from the failing check names. */
export function failedChecks(job: RadarJob): string {
  return checksReason((job.acceptance?.checks ?? []).filter((c) => !c.ok).map((c) => c.name));
}

// ── the detail cell ─────────────────────────────────────────────────────────

/**
 * What the third cell says.
 *
 * LIVE jobs say what they are doing, in a human verb (see `humanCommand`), plus
 * a tool count — which on a running job is a LIVENESS signal (is the number
 * still climbing?) and on a finished job is noise (TERMINAL-UI.md §Hierarchy
 * puts token counts and tool counts outside a glance row entirely; 504 versus 36
 * tells a reader nothing about which job worked).
 *
 * TERMINAL jobs say how they ended. A failure names its warning CODE rather than
 * its message: harness/types.ts makes the code the stable grouping key and the
 * message display-only, and TERMINAL-UI.md §Hierarchy keeps sentences off a
 * status line.
 */
export function jobDetail(job: RadarJob, options: { tools?: boolean } = {}): string {
  const withTools = options.tools !== false;
  if (isTerminal(job.status)) {
    return outcome(job);
  }
  const parts: string[] = [];
  if (job.status === 'attention') parts.push('stalled');
  if (job.activity !== '') parts.push(job.activity);
  // Tool count is a liveness signal ONLY while the job is live, so `isTerminal`
  // has already excluded it above. HAZARD A still applies on top: agy-staff
  // deletes events.jsonl on a warning-free success, so the count is genuinely
  // absent for some live jobs too and must be OMITTED, never printed as 0.
  if (withTools && job.toolCount !== null) parts.push(`${job.toolCount} tools`);
  return parts.join(` ${SEP} `);
}

/**
 * The outcome for a job that has stopped: `done`, `done · warnings`,
 * `failed · denied view_file`, `checks failed: lint`, `canceled`.
 *
 * Warnings on a `succeeded` job stay words, not a different glyph or colour:
 * harness/normalize.ts is explicit that a non-empty result with a warnings flag
 * stays `succeeded`, and TERMINAL-UI.md reserves red for real failures. A job
 * whose checks failed is not done, whatever the worker said.
 */
export function outcome(job: RadarJob): string {
  switch (job.status) {
    case 'running':
      return '';
    case 'attention':
      return 'stalled';
    case 'succeeded':
      if (job.acceptance?.state === 'rejected' && !job.acceptance.pending && job.acceptance.checks.length > 0) return failedChecks(job);
      return job.warnings.length > 0 ? `done ${SEP} warnings` : 'done';
    case 'failed': {
      const why = failureWords(job);
      return why === '' ? 'failed' : `failed ${SEP} ${why}`;
    }
    case 'canceled':
      return 'canceled';
    case 'unknown':
      return 'unknown';
  }
}

// ── the row ─────────────────────────────────────────────────────────────────

/** Every knob a surface needs to draw one row, and nothing else. */
export interface RowOptions {
  /** Clock. Passed in, never read. */
  readonly now?: number;
  /**
   * Width of the label cell. Named to match `paneColumns`'s return, so
   * `formatJobLine(job, { ...paneColumns(e.props.bodyColumns), now: t })` is the
   * whole call — and so a mismatched key is a type error rather than a silently
   * ignored property. That mistake was made and shipped once: the two shapes were
   * `{label}` and `{labelWidth}`, the spread type-checked anyway because an extra
   * property in a spread is not excess-property-checked, and every row rendered at
   * the band's 44-column budget inside a 166-column pane.
   */
  readonly label?: number;
  /** Width of the detail cell. */
  readonly detail?: number;
  /** Show a tool count on live rows. The band passes false. */
  readonly tools?: boolean;
}

/**
 * One job → one line of plain text, laid out in four fixed-width cells.
 *
 * Shared by the pane's list rows (`<Button label=…>`, which is a single string)
 * and by the band's rows (which need the same cells split into coloured
 * segments). Sharing it is what stops the two surfaces from drifting apart, and
 * it is the reason this function exists in this shape.
 */
export function formatJobLine(job: RadarJob, options: RowOptions = {}): string {
  const {
    now = job.endedAt ?? 0,
    label: labelWidth = BAND_LABEL_WIDTH,
    detail: detailWidth = BAND_DETAIL_WIDTH,
    tools = true,
  } = options;
  const clock = clockCell(job, now);
  const label = fitCell(jobLabel(job), labelWidth);
  const detail = fitCell(jobDetail(job, { tools }), detailWidth).trimEnd();
  return `${LEAD}${pickGlyph(job.status)}${GUTTER}${label}${GUTTER}${detail}${GUTTER}${clock}`.replace(
    /\s+$/,
    '',
  );
}

/**
 * Split a job into the segments a renderer needs, for one fixed column budget.
 *
 * `plain` is exactly what the terminal shows, for tests and for width work. The
 * three text segments are what register.tsx actually draws, so the accent can be
 * applied to the glyph ALONE — TERMINAL-UI.md allows one accent per line, and
 * painting a 44-column task title green would spend the whole budget on
 * something that should be readable in the default foreground.
 */
export interface JobRow {
  readonly glyph: string;
  /** The label cell, already fitted to `labelWidth`. */
  readonly label: string;
  /** The detail cell, already fitted and right-trimmed. */
  readonly detail: string;
  /** The elapsed cell, already fitted. */
  readonly clock: string;
  /** head + label + detail + clock: exactly what the terminal shows. */
  readonly plain: string;
  /** null means "pass no colour prop at all" — NO_COLOR, canceled, unknown. */
  readonly accent: 'blue' | 'green' | 'red' | 'cyan' | undefined;
  /** Only running and attention are bold: the states still in flux. */
  readonly bold: boolean;
  /** True when the whole row should be drawn dim (finished, canceled, unknown). */
  readonly recessive: boolean;
}

export function formatJobRow(job: RadarJob, options: RowOptions = {}): JobRow {
  const {
    now = job.endedAt ?? 0,
    label: labelWidth = BAND_LABEL_WIDTH,
    detail: detailWidth = BAND_DETAIL_WIDTH,
    tools = true,
  } = options;
  const glyph = pickGlyph(job.status);
  const label = fitCell(jobLabel(job), labelWidth);
  const detail = fitCell(jobDetail(job, { tools }), detailWidth).trimEnd();
  const clock = clockCell(job, now);
  const plain = formatJobLine(job, options);
  return {
    glyph,
    label,
    detail,
    clock,
    plain,
    accent: pickColor(job.status),
    bold: job.status === 'running' || job.status === 'attention',
    recessive: isRecessive(job.status),
  };
}

// ── column budgets ──────────────────────────────────────────────────────────

/**
 * Columns the row spends on anything other than the label and the detail.
 *
 * `{glyph}{gutter}{label}{gutter}{detail}{gutter}{clock}` plus the leading
 * gutter: 1 + 1 + 1 + 1 + ELAPSED_WIDTH = ELAPSED_WIDTH + 4.
 */
const ROW_OVERHEAD = ELAPSED_WIDTH + 4;

/** Widest a label cell is ever worth. Past this the tail is what you read. */
const LABEL_MAX = 72;
/** Widest a detail cell is ever worth. */
const DETAIL_MAX = 30;

/**
 * The pane's two variable cells, from the width the engine reports.
 *
 * The pane used to fix the label at the width of the longest JOB ID and let
 * everything after it fall where it fell — which, at 30-character ids, meant the
 * clock and the activity were routinely pushed past a 90-column pane and the
 * rows wrapped to two lines. TERMINAL-UI.md §Width makes wrapping the worst
 * visible failure there is, because a pane row that wraps becomes two rows.
 *
 * So the budget comes from `e.props.bodyColumns`, which is the engine handing us
 * the real measurement, and the invariant that matters is:
 *
 *     label + detail + ROW_OVERHEAD  <=  bodyColumns
 *
 * which `paneColumns` satisfies for every input including degenerate narrow
 * ones. The label gets the larger share because it is level-1 identity and the
 * detail is level-2 liveness, but the label is capped so that on a very wide
 * terminal the detail stays visible rather than being pushed off the right edge
 * by a 120-column task title.
 */
export function paneColumns(bodyColumns: number): { label: number; detail: number } {
  const cols = Number.isFinite(bodyColumns) && bodyColumns > 0 ? Math.floor(bodyColumns) : 80;
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  // Below ~40 columns there is no layout worth having; the label is what
  // survives, because it is the only segment that still identifies the job.
  const label = clamp(Math.min(clamp(cols - 40, 12, LABEL_MAX), Math.max(0, cols - ROW_OVERHEAD - 8)), 0, LABEL_MAX);
  let detail = clamp(cols - label - ROW_OVERHEAD, 0, DETAIL_MAX);
  if (label + detail + ROW_OVERHEAD > cols) detail = Math.max(0, cols - label - ROW_OVERHEAD);
  return { label, detail };
}

/** Widest the band's detail cell is worth once the label column has shrunk to fit. */
const BAND_DETAIL_MAX = 64;

/**
 * The band's cells when every shown label is short: the label column shrinks to
 * the longest label (never under 12), and the detail cell takes what it frees.
 * Rows still align, because every row on screen gets the same widths.
 */
export function fitBandColumns(bodyColumns: number, longestLabel: number): { label: number; detail: number } {
  const base = paneColumns(bodyColumns);
  const label = Math.min(base.label, Math.max(12, longestLabel));
  const detail = Math.max(base.detail, Math.min(BAND_DETAIL_MAX, Math.floor(bodyColumns) - label - ROW_OVERHEAD));
  return { label, detail };
}

/** The same budget with the tool count suppressed: the band's row. */
export function bandColumns(): { label: number; detail: number; tools: boolean } {
  return { label: BAND_LABEL_WIDTH, detail: BAND_DETAIL_WIDTH, tools: false };
}

// ── the header ──────────────────────────────────────────────────────────────

/**
 * The header: ` 2 running ∙ 1 failed ∙ 17 finished`.
 *
 * A failure gets its own count rather than hiding inside "finished", because the
 * list now SORTS failures to the top and a header that does not mention them
 * contradicts its own ordering.
 */
export function formatHeaderLine(summary: {
  running: number;
  failed: number;
  finished: number;
}): string {
  const shown = [
    { label: 'running', n: summary.running },
    { label: 'failed', n: summary.failed },
    { label: 'done', n: summary.finished },
  ].filter((c) => c.n > 0 || c.label === 'done');
  const width = Math.max(2, ...shown.map((c) => String(c.n).length));
  return shown.map((c) => `${String(c.n).padStart(width)} ${c.label}`).join(` ${SEP} `);
}

/** The literal empty state. One line, no box, no spinner, no second line. */
export const EMPTY_STATE = 'No workers yet';

// ── list ordering, and the header counts ─────────────────────────────────────
//
// Both of these were the pane reader's job, and both are PURE: they take a list
// of rows and return a list of rows. They live here rather than in ./jobs.ts
// because jobs.ts is the I/O boundary and this file is the presentation boundary,
// and a sort that needed to read a file to order rows would be a bug worth
// hearing about.

/**
 * The order the PANE draws its list:
 *
 *   0  running            live
 *   1  stalled            live, but gone quiet — directly under the working ones
 *   2  failed             terminal, and the one terminal state to act on
 *   3  everything else    succeeded, canceled, unknown — newest first
 *
 * Most recent first WITHIN each tier. The third tier is not ordered
 * succeeded-before-canceled on purpose: both are "over", and the corpus is 20
 * jobs of which one failed, so a second ordering inside "over" would be a
 * distinction without a difference on the only data there is.
 *
 * WHY FAILED IS ITS OWN TIER AND NOT THE TOP ONE. A failure must never sit at
 * row 4 under three finished jobs — but neither should it displace the job that
 * is actually working. Live first, then the failure, then the rest: that is the
 * order a person acts in.
 */
export function sortJobs(jobs: readonly RadarJob[]): RadarJob[] {
  const rank = (s: RadarStatus): number =>
    s === 'running' ? 0 : s === 'attention' ? 1 : s === 'failed' ? 2 : 3;
  return [...jobs].sort((a, b) => {
    const r = rank(a.status) - rank(b.status);
    if (r !== 0) return r;
    return (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0);
  });
}

/**
 * The order the BAND draws: live first, then terminal, newest first.
 *
 * Different from the pane's, on purpose and for the same reason the glyph set
 * differs in nothing: the band has no header, no footer and four rows, so it has
 * no use for a failure tier of its own — a failed job that finished inside the
 * linger window is already at most four rows from the top.
 */
export function sortForBand(jobs: readonly RadarJob[]): RadarJob[] {
  return [...jobs].sort((a, b) => {
    const rank = (s: RadarStatus): number => (s === 'running' || s === 'attention' ? 0 : 1);
    const r = rank(a.status) - rank(b.status);
    if (r !== 0) return r;
    return (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0);
  });
}

/**
 * The header's three numbers.
 *
 * `attention` counts as RUNNING, not finished: it is still going, it has just
 * gone quiet. Counting it under finished would tell the user a job is over at
 * the exact moment they should be doing something about it.
 */
export function countSummary(jobs: readonly RadarJob[]): {
  running: number;
  failed: number;
  finished: number;
} {
  let running = 0;
  let failed = 0;
  let finished = 0;
  for (const j of jobs) {
    if (j.status === 'running' || j.status === 'attention') running += 1;
    else if (j.status === 'failed') failed += 1;
    else finished += 1;
  }
  return { running, failed, finished };
}

// ── activity, from real agy tool shapes ─────────────────────────────────────

/**
 * agy tool name + parameters → a short "what is it doing" phrase.
 *
 * Measured against the real corpus in .agy-staff/jobs:
 *   run_command           { CommandLine }
 *   view_file             { AbsolutePath }
 *   write_to_file         { TargetFile }
 *   replace_file_content  { TargetFile }
 *   grep_search           { Query | Pattern }
 *   list_dir              { AbsolutePath }
 *   call_mcp_tool         { ServerName, ToolName, Arguments }
 *   manage_task           { Action, TaskId }
 *   schedule              { DurationSeconds, Prompt }
 *
 * TERMINAL-UI.md §Motion: "terse tool descriptions, never raw output". Every
 * branch truncates at the source; there is no code path that hands raw tool
 * output to a list row.
 */
export function describeTool(tool: string, params: Record<string, unknown>): string {
  const str = (k: string): string => {
    const v = params[k];
    return typeof v === 'string' ? v : '';
  };

  switch (tool) {
    case 'run_command':
      return humanCommand(str('CommandLine'));
    case 'view_file':
      return `reading ${basename(str('AbsolutePath'))}`;
    case 'write_to_file':
      // Same verb as replace_file_content, deliberately: from the reader's side
    // there is no difference between "created" and "changed" a file, and the
    // tool name is an implementation detail of agy, not of the work.
    case 'replace_file_content':
      return `editing ${basename(str('TargetFile'))}`;
    case 'grep_search':
      return `searching ${basename(str('Query') || str('Pattern'))}`;
    case 'list_dir':
      return `listing ${basename(str('AbsolutePath'))}`;
    case 'call_mcp_tool':
      return `${str('ToolName') || str('ServerName') || 'an mcp tool'}`;
    case 'manage_task':
      return `task ${str('Action') || 'update'}`;
    case 'schedule':
      return `waiting ${str('DurationSeconds') || '?'}s`;
    default:
      return `using ${tool}`;
  }
}

/**
 * A shell command → what a person would say they are doing.
 *
 * The corpus is 76 run_command records and the raw line is what put
 * `cargo tree -p renyi-mcp -e features -i` on a status row: real, precise, and
 * unreadable at a glance. So the COMMON commands get a verb, and anything else
 * gets a TRIMMED form rather than an invented one.
 *
 * The fallback rule is the important half. When there is no mapping this shows
 * the command's first two words and stops — `git rebase --onto main feature/x`
 * becomes `git rebase`, not `preparing the branch`. Inventing a plausible verb
 * for an arbitrary command would be a lie the user cannot check, and it would be
 * a lie in the one field the band exists to be trustworthy about. `cargo tree`
 * is in the table because it appears in the corpus four times, not because it
 * is universally understood.
 */
export function humanCommand(cmd: string): string {
  const line = cmd.replace(/\s+/g, ' ').trim();
  if (line === '') return 'running a command';

  // A pipeline or a `&&` chain is several actions; the first is what the job is
  // doing now, and the rest are what it will do after. `cargo test 2>&1 | tail`
  // is "running tests", not "running a shell pipeline".
  const first = line.split(/\s*(?:&&|\|\||;|\||&&)\s*/)[0] ?? line;

  const words = first.split(' ').filter((w) => !w.startsWith('-'));
  const prog = basename(words[0] ?? '');
  const sub = words[1] ?? '';

  switch (prog) {
    case 'cargo':
    case 'rustup':
      switch (sub) {
        case 'test':
        case 'nextest':
          return 'running tests';
        case 'clippy':
          return 'linting';
        case 'fmt':
          return 'formatting';
        case 'build':
          return 'building';
        case 'check':
          return 'checking the build';
        case 'tree':
          return 'inspecting dependencies';
        case 'doc':
          return 'reading the docs';
        case 'run':
          return `running ${basename(words[2] ?? 'the binary')}`;
        default:
          break;
      }
      break;
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
      // `npm test` and `npm run test` are the same intent; `npm run build` is
      // building. Anything else under `npm run` is somebody's script and we do
      // not know what it does.
      if (sub === 'test') return 'running tests';
      if (sub === 'run' && (words[2] === 'build')) return 'building';
      if (sub === 'run' && (words[2] === 'test')) return 'running tests';
      return `running ${prog} scripts`;
    case 'python':
    case 'python3':
      return 'running a script';
    case 'git':
      if (sub === 'status' || sub === 'diff' || sub === 'log' || sub === 'show') return 'checking git';
      if (sub === 'commit') return 'committing';
      if (sub === 'push') return 'pushing';
      return `git ${sub}`.trim();
    case 'grep':
    case 'rg':
    case 'ag':
      return 'searching';
    case 'graft':
      return `navigating the graph`;
    default:
      break;
  }

  // The honest fallback: the command's name, and at most one argument.
  const trimmed = words.slice(0, 2).join(' ');
  return trimmed === '' ? 'running a command' : trimmed;
}

/** Last path segment only. */
export function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

/**
 * `input_preview` is a JSON STRING of the tool parameters, truncated by agy-staff.
 * A truncated JSON string does not parse, so this never throws — a failure just
 * means we have no parameters and the caller falls back to the bare tool name.
 */
export function parseInputPreview(preview: string | null | undefined): Record<string, unknown> {
  if (!preview) return {};
  try {
    const v: unknown = JSON.parse(preview);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The activity phrase for a job, from its most recent activity record.
 * Exported because the band and the pane both call it and must agree.
 */
export function describeActivity(tool: string | null, inputPreview: string | null): string {
  if (!tool) return '';
  return describeTool(tool, parseInputPreview(inputPreview));
}
