export const NETWORK_RE = /network issue|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|connection (?:reset|refused|closed|error)|temporarily unavailable/i;
export const TIMEOUT_RE = /timed? ?out|exceeded the .*budget|\btimeout\b/i;
export const AUTH_RE = /\b(?:unauthorized|unauthenticated)\b|authentication (?:failed|required)|invalid (?:api[ _-]?key|access token)|(?:access |auth |refresh )token (?:has )?expired|not (?:logged|signed) in|please (?:log|sign) in/i;
export const BUSY_RE = /resource[_ ]exhausted|no spare capacity|\b503\b|\bservice unavailable\b|\boverloaded\b|provider busy/i;
export const RATE_LIMIT_RE = /\brate[ _-]?limit(?:ed|ing)?\b|too many requests|\b429\b/i;
export const QUOTA_RE = /insufficient[_ ](?:quota|credits|balance)|quota (?:exceeded|exhausted)|exceeded.{0,30}quota|credit balance.{0,30}(?:low|exhausted)|balance.{0,20}(?:low|exhausted|insufficient|depleted)|billing.{0,30}(?:limit|exhausted|suspended)|suspended.{0,40}(?:balance|billing|payment|credit|quota|unpaid)|please recharge|recharge (?:your )?(?:account|balance|credits)|out of credits|\b402\b|payment required/i;
export const COMPATIBILITY_RE = /unknown (?:option|argument|flag)|unrecognized (?:option|argument|flag|subcommand)|unexpected argument|unsupported (?:option|flag)|invalid value.{0,80}(?:--model|--effort|reasoning_effort)|unknown model|does not support effort|bad flag or model/i;
export const START_RE = /\bENOENT\b|spawn.{0,100}(?:not found|no such file)|couldn't start|could not start/i;
export const ORPHAN_RE = /orphaned|supervisor process exited|server stopped/i;
export const DENIED_RE = /\bdenied\b|soft-denied/i;
export const STEER_NOT_APPLIED_RE = /^\d+ queued (?:steers?|follow-ups?|messages?) (?:not (?:applied|sent)|discarded)\b/i;
export const NO_OUTPUT_RE = /no usable output|empty response|\bno output\b/i;

export const REASONS = {
  serverStopped: 'server stopped',
  noOutput: 'no output',
  timedOut: 'timed out',
  notLoggedIn: 'not logged in',
  providerBusy: 'provider busy',
  outOfCredits: 'out of credits',
  rateLimited: 'rate limited',
  badFlagOrModel: 'bad flag or model',
  couldntStart: "couldn't start",
  networkError: 'network error',
  crashed: 'crashed',
  setupFailed: 'setup failed',
  workerError: 'worker error',
} as const;

function firstPlus(names: readonly string[]): string {
  const clean = [...new Set(names.map((n) => n.trim()).filter((n) => n !== ''))];
  if (clean.length === 0) return '';
  return clean.length === 1 ? clean[0]! : `${clean[0]} +${clean.length - 1}`;
}

export function deniedReason(names: readonly string[]): string {
  const list = firstPlus(names);
  return list === '' ? 'denied' : `denied ${list}`;
}

export function checksReason(failed: readonly string[]): string {
  const list = firstPlus(failed);
  return list === '' ? 'checks failed' : `checks failed: ${list}`;
}

export function exitReason(code: number): string {
  return `exit ${code}`;
}

export function reasonFromText(text: string | null | undefined): string {
  const t = (text ?? '').trim();
  if (t === '') return REASONS.workerError;
  if (ORPHAN_RE.test(t)) return REASONS.serverStopped;
  if (/^denied(?: [^\n·]+)?$/.test(t) && t.length <= 64) return t;
  if (DENIED_RE.test(t)) {
    const named = /\(([^()]{2,})\)/.exec(t)?.[1] ?? /\bdenied:? ([A-Za-z_][^·\n]*)/i.exec(t)?.[1] ?? '';
    return deniedReason(named.split(',').map((n) => n.replace(/\s*\+\d+$/, '')));
  }
  if (NO_OUTPUT_RE.test(t)) return REASONS.noOutput;
  if (TIMEOUT_RE.test(t)) return REASONS.timedOut;
  if (AUTH_RE.test(t)) return REASONS.notLoggedIn;
  if (BUSY_RE.test(t)) return REASONS.providerBusy;
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
  if (t.length <= 32 && !t.includes('\n') && !t.includes(' — ')) return t;
  return REASONS.workerError;
}

export function noticeReason(
  failureReason: string | null | undefined,
  failureDetail?: string | null | undefined,
): string {
  const classified = reasonFromText(failureReason || failureDetail);
  if (classified !== REASONS.workerError) return classified;
  if (failureDetail) {
    const fromDetail = reasonFromText(failureDetail);
    if (fromDetail !== REASONS.workerError) return fromDetail;
    return failureDetail;
  }
  return classified;
}
