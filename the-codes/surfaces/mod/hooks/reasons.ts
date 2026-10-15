/**
 * reasons.ts — every failure, in two to four words.
 *
 * One vocabulary for every surface: the completion notice, the band, the pane,
 * `status`, and the hints Claude reads. The forge stores `reason` (from these
 * helpers) on the job when it fails; readers of older jobs, which have only the
 * long `error` text, derive the same words with `reasonFromText`. The full error
 * always stays one step away (status, the pane), so nothing here needs to
 * explain itself.
 *
 * Lives in the mod for the same reason as progress.ts: the mod loader only
 * admits files inside the plugin folder; the forge imports it from here. Pure:
 * no `claude-code` import, no filesystem.
 */

export const NETWORK_RE = /network issue|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|connection (?:reset|refused|closed|error)|temporarily unavailable|overloaded/i;
export const TIMEOUT_RE = /timed? ?out|exceeded the .*budget|\btimeout\b/i;
export const AUTH_RE = /\b(?:unauthorized|unauthenticated)\b|authentication (?:failed|required)|invalid (?:api[ _-]?key|access token)|(?:access |auth |refresh )token (?:has )?expired|not (?:logged|signed) in|please (?:log|sign) in/i;
export const RATE_LIMIT_RE = /\brate[ _-]?limit(?:ed|ing)?\b|too many requests|\b429\b/i;
export const QUOTA_RE = /insufficient[_ ]quota|quota exceeded|exceeded.{0,30}quota|credit balance.{0,30}(?:low|exhausted)|billing.{0,30}(?:limit|exhausted)|out of credits/i;
export const COMPATIBILITY_RE = /unknown (?:option|argument|flag)|unrecognized (?:option|argument|flag|subcommand)|unexpected argument|unsupported (?:option|flag)|invalid value.{0,80}(?:--model|--effort|reasoning_effort)|unknown model|does not support effort|bad flag or model/i;
export const START_RE = /\bENOENT\b|spawn.{0,100}(?:not found|no such file)|couldn't start|could not start/i;
/** The orphan reason, old and new wording: the process that owned the job is gone. */
export const ORPHAN_RE = /orphaned|supervisor process exited|server stopped/i;
export const DENIED_RE = /\bdenied\b|soft-denied/i;
export const NO_OUTPUT_RE = /no usable output|empty response|\bno output\b/i;

/** The words for the cases the forge decides itself. */
export const REASONS = {
  serverStopped: 'server stopped',
  noOutput: 'no output',
  timedOut: 'timed out',
  notLoggedIn: 'not logged in',
  outOfCredits: 'out of credits',
  rateLimited: 'rate limited',
  badFlagOrModel: 'bad flag or model',
  couldntStart: "couldn't start",
  networkError: 'network error',
  crashed: 'crashed',
  setupFailed: 'setup failed',
  workerError: 'worker error',
} as const;

/** `first +N`: one name and a count, so a long list never widens a line. */
function firstPlus(names: readonly string[]): string {
  const clean = [...new Set(names.map((n) => n.trim()).filter((n) => n !== ''))];
  if (clean.length === 0) return '';
  return clean.length === 1 ? clean[0]! : `${clean[0]} +${clean.length - 1}`;
}

/** `denied view_file`, `denied view_file +2`, or `denied`. */
export function deniedReason(names: readonly string[]): string {
  const list = firstPlus(names);
  return list === '' ? 'denied' : `denied ${list}`;
}

/** `checks failed: lint`, `checks failed: lint +1`, or `checks failed`. */
export function checksReason(failed: readonly string[]): string {
  const list = firstPlus(failed);
  return list === '' ? 'checks failed' : `checks failed: ${list}`;
}

/** `exit 1`. */
export function exitReason(code: number): string {
  return `exit ${code}`;
}

/**
 * Any failure text → the short reason. For jobs recorded before `reason` was
 * stored, and for errors that only exist as prose. Order matters: the most
 * specific cause wins, and an orphan or a denial outranks whatever else the
 * text happens to mention.
 */
export function reasonFromText(text: string | null | undefined): string {
  const t = (text ?? '').trim();
  if (t === '') return REASONS.workerError;
  if (ORPHAN_RE.test(t)) return REASONS.serverStopped;
  // Already a stored reason ("denied view_file +2"): keep it whole, count included.
  if (/^denied(?: [^\n·]+)?$/.test(t) && t.length <= 64) return t;
  if (DENIED_RE.test(t)) {
    // "soft-denied 2 tool action(s) (view_file, RunCommand)", "denied view_file", "denied: view_file"
    const named = /\(([^()]{2,})\)/.exec(t)?.[1] ?? /\bdenied:? ([A-Za-z_][^·\n]*)/i.exec(t)?.[1] ?? '';
    return deniedReason(named.split(',').map((n) => n.replace(/\s*\+\d+$/, '')));
  }
  if (NO_OUTPUT_RE.test(t)) return REASONS.noOutput;
  if (TIMEOUT_RE.test(t)) return REASONS.timedOut;
  if (AUTH_RE.test(t)) return REASONS.notLoggedIn;
  if (QUOTA_RE.test(t)) return REASONS.outOfCredits;
  if (RATE_LIMIT_RE.test(t)) return REASONS.rateLimited;
  if (COMPATIBILITY_RE.test(t)) return REASONS.badFlagOrModel;
  if (START_RE.test(t)) return REASONS.couldntStart;
  if (NETWORK_RE.test(t)) return REASONS.networkError;
  if (/without (?:emitting )?a result|no result event|\bcrashed\b/i.test(t)) return REASONS.crashed;
  if (/preparation failed|setup failed/i.test(t)) return REASONS.setupFailed;
  if (/checks failed/i.test(t)) return t.split('\n')[0]!.slice(0, 48);
  const exit = /\bexit(?:ed)?(?: with)?(?: code)? (\d+)\b/i.exec(t);
  if (exit) return exitReason(Number(exit[1]));
  // Already short and plain: keep it as the worker or provider put it.
  if (t.length <= 32 && !t.includes('\n') && !t.includes(' — ')) return t;
  return REASONS.workerError;
}
