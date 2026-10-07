/**
 * format.ts — PURE presentation logic for the /agent-smith pane.
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
 * The rules encoded below come from agent-configs/shared/TERMINAL-UI.md. Where a
 * rule needed interpretation the reasoning is inline.
 */

import type { RadarJob, RadarStatus } from '../types/index.d.ts';

// ── glyphs ──────────────────────────────────────────────────────────────────

/**
 * Status → glyph. Single-width ONLY.
 *
 * TERMINAL-UI.md §Glyphs: `●` `✓` `✗` `·` `…` are safe; emoji are not. The
 * shipped `agent-radar` mod uses exactly these three and aligns; the shipped
 * `review-watch` mod uses `⏳ ✅` and does not, because terminals render emoji
 * double-width and every column after them is silently wrong.
 *
 * TERMINAL-UI.md's state table covers running/done/failed/needs-you. The
 * harness's ObservedStatus has five values, so `canceled` and `unknown` are
 * uncovered by the doc and needed their own rows. `·` and `?` are ASCII and
 * single-width, so they extend the safe set rather than break it.
 *
 * `canceled` is deliberately NOT `✗`. A cancelled job is not a bug — core/types.ts
 * says so explicitly, and adds that alerting on one trains people to ignore
 * alerts. Painting it with the failure glyph would contradict that.
 */
export function pickGlyph(status: RadarStatus): string {
  switch (status) {
    case 'running':
      return '●';
    case 'succeeded':
      return '✓';
    case 'failed':
      return '✗';
    case 'attention':
      return '!';
    case 'canceled':
      return '·';
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
 * `undefined` means "use the default foreground". Nothing secondary is coloured
 * at all: secondary text is `dimColor`, never a colour and never `gray` (which is
 * a fixed value that vanishes on one of light/dark).
 */
export function pickColor(
  status: RadarStatus,
): 'yellow' | 'green' | 'red' | 'cyan' | undefined {
  switch (status) {
    case 'running':
      return 'yellow'; // bold is applied at the call site
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

// ── elapsed ─────────────────────────────────────────────────────────────────

/**
 * Duration in ms → a compact clock string.
 *
 * `48s`, `12m04s`, `1h02m`. The seconds field is `padStart(2,'0')` because
 * TERMINAL-UI.md §Width calls for tabular alignment and notes the terminal
 * equivalent of `font-variant-numeric: tabular-nums` IS fixed-width padding:
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
 * WIDTH IS A CORRECTNESS PROPERTY HERE, NOT COSMETICS. TERMINAL-UI.md §Width says
 * "put the volatile field last — elapsed time ticks every second; if it sits
 * mid-line, everything after it shifts horizontally each tick". The required
 * /agent-smith design puts elapsed BEFORE the activity text, which appears to
 * violate that rule. It does not, once the field is a fixed width: with
 * right-alignment, the second that changes is the last character of a
 * constant-width cell, so nothing to its right moves. `48s`, `12m04s` and
 * `1h02m` are 3, 6 and 5 wide; padStart(6) makes all three occupy 6.
 *
 * This is the reconciliation between the two documents, and it is load-bearing:
 * remove the padding and the design's own line ordering starts to jitter.
 */
export const ELAPSED_WIDTH = 6;

/** elapsed(), right-aligned into ELAPSED_WIDTH. */
export function elapsedCell(ms: number): string {
  return elapsed(ms).padStart(ELAPSED_WIDTH);
}

// ── tool counts ─────────────────────────────────────────────────────────────

/** Column width for the tool count. 3 covers 341 (the largest real corpus job). */
export const TOOL_COUNT_WIDTH = 3;

/** A count right-aligned into TOOL_COUNT_WIDTH, or '' when genuinely unknown. */
export function toolCountCell(count: number | null): string {
  // NOTE: unknown renders as an EMPTY CELL, not as '0'. agy-staff deletes
  // events.jsonl on a warning-free success (hazard A), so for a cleanly finished
  // job there is genuinely no tool count anywhere on disk. Printing '0 tools'
  // would be a fabrication; printing '? tools' would imply we looked and failed.
  return count === null ? '' : String(count).padStart(TOOL_COUNT_WIDTH);
}

// ── the job line ────────────────────────────────────────────────────────────

export interface FormatJobLineOptions {
  /** Column width to left-pad the job id to, so ids line up. */
  idWidth?: number;
  /** Clock. Passed in, never read. */
  now?: number;
}

/**
 * One job → one line of plain text.
 *
 * Pure string building on purpose: the pane's list rows are `<Button label=...>`,
 * which is a single string, and having the band and the pane share this function
 * is what stops the two from drifting apart.
 *
 * Shape (from the required design):
 *   ` ● implement-musm82da   12m04s · 341 tools · cargo test --workspace`
 *
 * Note the elapsed field is NOT last here, contrary to the naive reading of
 * TERMINAL-UI.md — see ELAPSED_WIDTH for why that is safe.
 */
export function formatJobLine(job: RadarJob, options: FormatJobLineOptions = {}): string {
  const { idWidth = 0, now = job.endedAt ?? 0 } = options;
  const span = job.startedAt === null ? null : (job.endedAt ?? now) - job.startedAt;

  // Level 1 identity, always: glyph + short label. Readable in the first 40 cols.
  // The trailing space is the gutter between the id column and the clock column.
  const parts = [` ${pickGlyph(job.status)} ${job.id.padEnd(idWidth)} `];

  // Level 2 liveness. The clock is a fixed-width cell whether or not it has a
  // value, so a job with no known start does not shift the columns after it.
  parts.push(span === null ? ''.padStart(ELAPSED_WIDTH) : elapsedCell(span));

  // Tool count is omitted entirely when unknown, separator included — otherwise a
  // cleanly finished job (whose events.jsonl agy-staff deleted) renders `·  ·`,
  // which reads as a rendering bug rather than as absent data.
  const tools = toolCountCell(job.toolCount);
  if (tools !== '') parts.push(` · ${tools} tools`);

  // Terse activity, truncated at the source. Free text, so it is the one segment
  // allowed to be cut by wrap="truncate-end".
  if (job.activity) parts.push(` · ${job.activity}`);

  return parts.join('');
}

/**
 * The header: ` 2 running · 14 finished`.
 *
 * Counts are padded to a fixed width for the same reason the elapsed cell is:
 * without it the `·` jumps sideways every time a job finishes.
 */
export function formatHeaderLine(running: number, finished: number): string {
  // Width is derived from the counts themselves, not fixed at 2. A fixed width of 2
  // aligns `2` against `14` perfectly and then falls apart the moment a project
  // has 100 jobs — the separator jumps right and the header visibly tears. Deriving
  // it costs one Math.max and is correct at every scale.
  const width = Math.max(2, String(running).length, String(finished).length);
  return `${String(running).padStart(width)} running · ${String(finished).padStart(width)} finished`;
}

/** The literal empty state. No box, no spinner, no second line. */
export const EMPTY_STATE = 'No jobs yet';

// ── activity, from real agy tool shapes ─────────────────────────────────────

/**
 * agy tool name + parameters → a short "what is it doing" phrase.
 *
 * Measured against the real corpus in /Users/gathrid/Repos/renyi/.agy-staff/jobs:
 *   run_command           { CommandLine }
 *   view_file             { AbsolutePath }
 *   write_to_file         { TargetFile }
 *   replace_file_content  { TargetFile }
 *   call_mcp_tool         { ServerName, ToolName, Arguments }
 *   manage_task           { Action, TaskId }
 *   schedule              { DurationSeconds, Prompt }
 *
 * TERMINAL-UI.md §Motion: "terse tool descriptions, never raw output —
 * `cargo test --workspace`, not forty lines of compiler output. Truncate at the
 * source." Every branch here truncates at the source; there is no code path that
 * hands raw tool output to a list row.
 */
export function describeTool(tool: string, params: Record<string, unknown>): string {
  const str = (k: string): string => {
    const v = params[k];
    return typeof v === 'string' ? v : '';
  };

  switch (tool) {
    case 'run_command':
      // The command IS the activity. Not prefixed with "running" — the reader
      // already knows it is running, and the prefix is 8 columns of nothing.
      return ellipsis(str('CommandLine'), 40);
    case 'view_file':
      return `reading ${basename(str('AbsolutePath'))}`;
    case 'write_to_file':
      return `writing ${basename(str('TargetFile'))}`;
    case 'replace_file_content':
      return `editing ${basename(str('TargetFile'))}`;
    case 'grep_search':
      return `searching ${ellipsis(str('Query') || str('Pattern'), 30)}`;
    case 'list_dir':
      return `listing ${basename(str('AbsolutePath'))}`;
    case 'call_mcp_tool':
      return `mcp: ${str('ToolName') || str('ServerName') || 'tool'}`;
    case 'manage_task':
      return `managing ${str('Action') || 'task'} ${basename(str('TaskId'))}`;
    case 'schedule':
      return `waiting ${str('DurationSeconds') || ''}s`;
    default:
      return `using ${tool}`;
  }
}

/** Last path segment only. The required design reads `reading decoded_view.rs`. */
export function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

/** Hard-cap a string at `max` columns, marking the cut. Total stays <= max+1. */
export function ellipsis(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}…`;
}

/** Collapse all whitespace runs to single spaces and cap the length. */
export function oneLine(s: string, max = 400): string {
  return ellipsis(s, max);
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