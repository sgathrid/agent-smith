/** Text sanitising and fixed-width fitting. Dependency-free: everything that puts
 * worker or user prose into a cell goes through here first.
 */

/**
 * Strip complete ANSI escape sequences (CSI, OSC, DCS/PM/APC/SOS, 2-byte ESC,
 * C1 controls) and remaining forbidden control characters, unpaired surrogates,
 * and noncharacters (`U+FDD0..U+FDEF`), while preserving `\n` and valid UTF-16
 * surrogate pairs.
 *
 * Why this exists: Claude Code's JSX element validator rejects any `<Text>`,
 * `<Button label>`, or `<Markdown text>` containing C0/C1 controls (except `\t`
 * and `\n`), lone surrogates, or `U+FDD0..U+FDEF`. Worker tool output, shell
 * commands, check output, and prompt text routinely contain ANSI colour codes or
 * `\r` progress lines; stripping them at the UI boundary keeps the stored job
 * files intact while preventing a single control byte from aborting the pane.
 */
const ANSI_ESCAPE =
  /(?:\x1b\][\s\S]*?(?:\x07|\x1b\\|\x9c)|\x9d[\s\S]*?(?:\x07|\x1b\\|\x9c)|\x1b[PX^_][\s\S]*?(?:\x1b\\|\x9c)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[@-~])/gu;
const FORBIDDEN_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ud800-\udfff\ufdd0-\ufdef]/gu;

export function sanitizeText(s: string): string {
  return s
    .replace(ANSI_ESCAPE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(FORBIDDEN_CONTROLS, '');
}

/**
 * Cut to at most `max` UTF-16 units without splitting a surrogate pair.
 *
 * `slice` can leave a high surrogate with no low half. `sanitizeText` removes
 * such halves, so a cut made AFTER sanitizing must not create one: the host
 * draws an unpaired half as U+FFFD, or refuses the tree a Text's string is
 * checked in. `max` stays in UTF-16 units because every caller sizes cells in
 * terminal columns, where a pair already counts as two.
 */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, Math.max(0, max));
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
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
  const cut = clip(s, width);
  const space = cut.lastIndexOf(' ');
  // Only break on a space in the last third: breaking early would throw away a
  // third of the cell to save two characters of raggedness.
  const body = space >= Math.floor(width * 0.6) ? cut.slice(0, space) : cut;
  return body.padEnd(width);
}

/** Collapse all whitespace runs to single spaces and cap the length. A hard
 * bound on what one string can cost, for prose with no cell to sit in (a report
 * excerpt, a warning message); the renderer's `wrap="truncate-end"` is the
 * mechanism, this is belt and braces. */
export function oneLine(s: string, max = 400): string {
  const t = sanitizeText(s).replace(/\s+/g, ' ').trim();
  return clip(t, Math.max(0, max));
}
