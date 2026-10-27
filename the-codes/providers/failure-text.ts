/**
 * failure-text.ts — the short error strings the adapters share.
 *
 * One spelling per case, so every provider fails in the same words. Detail that
 * only a developer needs (event-shape gaps, flag advice) belongs in code
 * comments; advice for the orchestrator is nextActionFor's job (forge/format.ts).
 */

const STDERR_TAIL_CHARS = 300;

/** `45m`, `1h05m`, `30s`, `2m10s`. Whole units, never raw milliseconds. */
export function humanDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return s === 0 ? `${m}m` : `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function timedOutText(durationMs: number): string {
  return `timed out after ${humanDuration(durationMs)}`;
}

/** ` · stderr: <tail>`, or '' when stderr is empty. The last bounded part: errors come last. */
export function stderrClause(stderr: string): string {
  const t = stderr.trim();
  if (t === '') return '';
  return ` · stderr: ${t.length > STDERR_TAIL_CHARS ? `…${t.slice(-STDERR_TAIL_CHARS)}` : t}`;
}

/** `exited 1, no result` or `exited on SIGTERM, no result`, plus the stderr clause. */
export function noResultText(
  exit: { readonly code: number | null; readonly signal: string | null; readonly stderr: string },
): string {
  const how = exit.code === null ? `on ${exit.signal ?? 'a signal'}` : String(exit.code);
  return `exited ${how}, no result${stderrClause(exit.stderr)}`;
}

/** `denied view_file, RunCommand · stderr: …` */
export function deniedText(names: readonly string[], stderr: string): string {
  const list = [...new Set(names.filter((n) => n !== ''))].join(', ');
  return `${list === '' ? 'denied' : `denied ${list}`}${stderrClause(stderr)}`;
}

/**
 * `recovered from a provider connection error at 21:11 UTC: ECONNRESET …`.
 * The warning a job carries when a worker hit an error, kept working and still
 * delivered its report. `at` is an ISO timestamp; `label` names the kind of error.
 */
export function recoveredErrorText(label: string, message: string, at: string): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  const detail = flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
  const clock = /^\d{4}-\d\d-\d\dT(\d\d:\d\d)/.exec(at)?.[1];
  return `recovered from ${label}${clock === undefined ? '' : ` at ${clock} UTC`}${detail === '' ? '' : `: ${detail}`}`;
}
