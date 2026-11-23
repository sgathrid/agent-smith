/** Pure rules for the Forge sidebar: which workers it lists and how it labels them. */
import type { ActivityEvent, RadarAcceptance, RadarJob } from '../types/index.d.ts';
import { continuationLabel, countSummary, effectiveStart, elapsed, elapsedCell, failedChecks, failureWords, isTerminal, jobLabel, livenessWords, oneLine, pendingSteersLabel, pickGlyph } from './format.ts';
import { classify } from './progress.ts';

/** A settled failure or rejection stops asking for attention this long after it ended. */
export const ATTENTION_TTL_MS = 24 * 60 * 60 * 1000;

/** Before the host measures the terminal, ask for a compact pane width. */
export const PANE_FALLBACK_COLUMNS = 60;
export const PANE_MIN_COLUMNS = 24;

/** A pane request for the rightmost third, respecting the host's 24-column floor. */
export function paneWidthRequest(viewportColumns: number | null): number {
  if (viewportColumns === null || !Number.isFinite(viewportColumns) || viewportColumns <= 0) {
    return PANE_FALLBACK_COLUMNS;
  }
  return Math.max(PANE_MIN_COLUMNS, Math.floor(viewportColumns / 3));
}

/**
 * Reconstruct whole-terminal width from a Pane render event.
 *
 * When `placement === 'dock'`, Claude Code sets `viewport.columns` on the Pane
 * render event to `conversationColumns` (`terminalColumns - (bodyColumns + 1)`),
 * not `terminalColumns`. Treating `viewport.columns` as the full terminal width
 * feeds `conversationColumns` back into `paneWidthRequest` on every Pane render
 * and causes a self-cancelling resize loop.
 */
export function measurePaneTerminalColumns(
  viewport: { readonly columns?: number } | undefined,
  props: { readonly bodyColumns?: number; readonly placement?: string } | undefined,
): number | undefined {
  const viewportColumns = viewport?.columns;
  if (typeof viewportColumns !== 'number' || !Number.isFinite(viewportColumns) || viewportColumns <= 0) {
    return undefined;
  }
  if (props?.placement === 'dock') {
    const bodyColumns = props.bodyColumns;
    if (typeof bodyColumns === 'number' && Number.isFinite(bodyColumns) && bodyColumns > 0) {
      return Math.floor(viewportColumns) + Math.floor(bodyColumns) + 1;
    }
    return undefined;
  }
  return Math.floor(viewportColumns);
}

/**
 * Whole-terminal width from a `command.run` event, when the host stamps it.
 *
 * `presentation.columns` is the terminal's width as the command runs, so a
 * command that opens the dock can size it before any render has measured the
 * terminal. Unknown or absent shapes return undefined, leaving the last render
 * measurement — or the fallback — in place.
 */
export function commandTerminalColumns(presentation: unknown): number | undefined {
  if (typeof presentation !== 'object' || presentation === null) return undefined;
  const columns = (presentation as { readonly columns?: unknown }).columns;
  if (typeof columns !== 'number' || !Number.isFinite(columns) || columns <= 0) return undefined;
  return Math.floor(columns);
}

/**
 * Settled (terminal, checks not pending) work ages out of attention so a stale
 * failure stops being drawn as one. Running, pending and quiet (`attention`)
 * jobs never expire. Without `now` or a timestamp nothing expires.
 */
function expired(job: RadarJob, now?: number): boolean {
  if (now === undefined || !isTerminal(job.status) || job.acceptance?.pending) return false;
  const at = job.endedAt ?? job.startedAt;
  return at !== null && now - at > ATTENTION_TTL_MS;
}
export function needsAttention(job: RadarJob, now?: number): boolean {
  return !expired(job, now) && (job.status === 'attention' || job.status === 'failed' || job.acceptance?.state === 'rejected');
}
/** Still executing, or finished with checks still running (unless superseded by a steered turn). */
export function isLive(job: RadarJob): boolean {
  if (job.supersededBy && isTerminal(job.status)) return false;
  return !isTerminal(job.status) || job.acceptance?.pending === true;
}
/** The sidebar list: one row per worker, running first, then settled work, most recent first. */
export function forgeList(jobs: readonly RadarJob[]): RadarJob[] {
  const workers = groupWorkers(jobs);
  const ended = (job: RadarJob) => job.endedAt ?? job.startedAt ?? 0;
  return [...workers.filter(isLive), ...workers.filter((job) => !isLive(job)).sort((a, b) => ended(b) - ended(a) || a.id.localeCompare(b.id))];
}
/** `/forge <query>`: an exact job id, else a worker name or id (any case), preferring live work. */
export function findWorker(jobs: readonly RadarJob[], query: string): RadarJob | undefined {
  const q = query.trim().toLowerCase();
  return jobs.find((job) => job.id === query.trim()) ??
    forgeList(jobs).find((job) => job.name?.trim().toLowerCase() === q || job.workerId.toLowerCase() === q);
}
export function workerHeading(job: RadarJob): string {
  const role = oneLine(job.role ?? job.provider ?? '');
  return `${jobLabel(job)}${role ? ` · ${role}` : ''}`;
}
/**
 * The one-line status for a worker: liveness while it runs, outcome once it
 * stopped.
 *
 * A terminal job also carries the facts a reader would otherwise have to open
 * the pane for: how much it changed, whether its checks passed, and whether this
 * turn came after a steer or resume. All of it is EVIDENCE the writer recorded —
 * never a prescription, and never a fabricated `0 files` (an absent edit count
 * means "not visible", not zero; see progress.ts).
 */
export function workerStatus(job: RadarJob): string {
  if (job.supersededBy && isTerminal(job.status)) return 'steered';
  if (job.acceptance?.pending && isTerminal(job.status)) {
    // The worker exited; no verdict exists yet, so this must not read as done.
    const running = job.acceptance.running ? `: ${oneLine(job.acceptance.running, 40)}` : '';
    return `${job.status === 'succeeded' ? 'exited' : job.status} · checking${running}`;
  }
  let base: string;
  if (job.status === 'failed') {
    const why = failureWords(job);
    base = why === '' ? 'failed' : `failed · ${why}`;
  } else if (job.status === 'succeeded' && job.acceptance?.state === 'rejected' && job.acceptance.checks.length > 0) {
    base = failedChecks(job);
  } else if (job.acceptance?.state === 'rejected') {
    base = `${job.status} · checks failed`;
  } else if (job.status === 'running') {
    const steers = pendingSteersLabel(job.pendingSteers);
    const act = livenessWords(job) || oneLine(job.activity);
    return ['Running', steers, act].filter(Boolean).join(' · ');
  } else if (job.status === 'attention') {
    const steers = pendingSteersLabel(job.pendingSteers);
    const quiet = livenessWords(job) || 'no output';
    return steers ? `${quiet} · ${steers}` : quiet;
  } else {
    base = job.status === 'succeeded' ? 'done' : job.status;
  }
  if (job.status !== 'succeeded' && job.status !== 'failed') return base;

  const parts = [base];
  const files = changedFilesPhrase(job);
  if (files !== '') parts.push(files);
  // `failedChecks(job)` already names a rejected job's failing checks, so the
  // pass count is only news when every check passed.
  if (job.status === 'succeeded' && job.acceptance?.state === 'accepted' && job.acceptance.checks.length > 0) {
    const label = checksLabel(job.acceptance);
    if (label !== '') parts.push(label);
  }
  const cont = continuationLabel(job.continuationKind);
  if (cont !== '') parts.push(cont);
  return parts.join(' · ');
}

/** Quiet threshold for the worker detail pane before calling out silence. */
export const PANE_QUIET_MS = 2 * 60_000;

export interface WorkerLivenessLine {
  readonly text: string;
  readonly tone: 'dim' | 'yellow' | 'red';
}

/**
 * The detail-pane liveness callout for a live worker, driven solely by
 * `job.liveness` (from `stale.ts` `livenessOf`).
 */
export function workerLivenessLine(job: RadarJob): WorkerLivenessLine | null {
  if (isTerminal(job.status)) return null;
  const l = job.liveness;
  if (!l) return null;
  switch (l.state) {
    case 'in-tool':
      return null;
    case 'active':
      return l.silentForMs >= PANE_QUIET_MS
        ? { text: `No output ${elapsed(l.silentForMs)} · process alive`, tone: 'dim' }
        : null;
    case 'silent':
      return { text: `No output ${elapsed(l.forMs)}`, tone: 'yellow' };
    case 'dead':
      return { text: `Worker process gone ${elapsed(l.forMs)}`, tone: 'red' };
    default:
      return null;
  }
}

/** `3 files changed`, else `2 files edited` from the digest, else '' — never `0 files`. */
function changedFilesPhrase(job: RadarJob): string {
  const count = typeof job.changedFileCount === 'number' && job.changedFileCount > 0 ? job.changedFileCount
    : (job.progress && job.progress.editedCount > 0 ? job.progress.editedCount : 0);
  if (count <= 0) return '';
  return `${count} ${count === 1 ? 'file' : 'files'} ${job.changedFileCount === count ? 'changed' : 'edited'}`;
}
/** `checks ✓ 2/2`, `✗ lint, tests`, `checking`, or '' when no checks ran. */
export function checksLabel(acceptance?: RadarAcceptance): string {
  if (!acceptance) return '';
  if (acceptance.pending) return 'checking';
  const failed = acceptance.checks.filter((check) => !check.ok);
  if (failed.length > 0) return `✗ ${failed.map((check) => oneLine(check.name)).join(', ')}`;
  if (acceptance.checks.length > 0) return `checks ✓ ${acceptance.checks.length}/${acceptance.checks.length}`;
  return acceptance.state === 'rejected' ? 'checks failed' : '';
}
export function statusLine(job: RadarJob, now: number, width: number): string {
  // No start time means no clock: format.ts's clockCell is BLANK, never `0s`,
  // because a confident `0s` about a job that has been working for half an hour
  // is the one lie this surface must not tell.
  const start = effectiveStart(job);
  if (start === null) return oneLine(workerStatus(job), Math.max(1, width));
  const clock = elapsedCell((job.endedAt ?? now) - start);
  const room = Math.max(1, width - clock.length - 3);
  // A settled row also says when it started, so two workers with alike names can be told apart.
  const status = isTerminal(job.status) ? `${workerStatus(job)} · started ${clockTime(start)}` : workerStatus(job);
  return `${oneLine(status, room).padEnd(room)}   ${clock}`;
}
/** Local `HH:MM` of an epoch-ms time. */
function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * How many turns this worker has taken across the jobs on hand: one job per
 * turn, steered and resumed continuations included. At least `job.turn` (and >= 1).
 */
export function turnCount(job: RadarJob, allJobs: readonly RadarJob[]): number {
  const observed = allJobs.filter((other) => other.workerId === job.workerId).length;
  return Math.max(1, job.turn ?? 1, observed);
}

/** Compact clickable summary for a prior turn row inline above the live turn in `/forge`. */
export function priorTurnSummary(job: RadarJob, fallbackTurn: number, now: number): string {
  const turn = job.turn ?? fallbackTurn;
  let state: string;
  if (job.supersededBy && isTerminal(job.status)) {
    state = 'steered';
  } else if (job.status === 'succeeded') {
    if (job.acceptance?.state === 'rejected' && !job.acceptance.pending) {
      state = job.acceptance.checks.length > 0 ? failedChecks(job) : 'checks failed';
    } else {
      state = 'done';
    }
  } else if (job.status === 'failed') {
    const why = failureWords(job);
    state = why === '' ? 'failed' : `failed · ${why}`;
  } else {
    state = job.status;
  }
  const parts: string[] = [`▸ Turn ${turn}`, state];
  if (job.toolCount !== null) parts.push(`${job.toolCount} ${job.toolCount === 1 ? 'tool' : 'tools'}`);
  // Prior-turn rows show each turn's own duration (endedAt - startedAt), not the chain's.
  const span = job.startedAt === null ? null : (job.endedAt ?? now) - job.startedAt;
  if (span !== null) parts.push(elapsed(span));
  return parts.join(' · ');
}

/** How many worker rows the recap board lists before folding the rest. */
const BOARD_ROWS = 12;
/** One board line never runs past this many columns; `wrap` needs a bound. */
const BOARD_WIDTH = 120;

/**
 * `/forge recap`: a multi-line factual board of this session's workers, or the
 * repository's history.
 *
 * Pure, so the same board answers `/forge recap`, `/forge all recap` and
 * `/forge recap all` identically. Every line states what the fleet is doing or
 * what it finished with — glyph, worker, turn, factual status, elapsed — and
 * nothing else. No advice, no next step.
 */
export function sessionBoard(jobs: readonly RadarJob[], scope: 'session' | 'all', now: number): string {
  const workers = forgeList(jobs);
  if (workers.length === 0) return scopeLine(jobs, scope);
  const lines = [`${scope === 'all' ? 'Repository' : 'This session'} · ${countLine(jobs)}`];
  const shown = workers.slice(0, BOARD_ROWS);
  for (const job of shown) {
    const turns = turnCount(job, jobs);
    const start = effectiveStart(job);
    const span = start === null ? null : (job.endedAt ?? now) - start;
    const glyph = job.status === 'succeeded' && job.acceptance?.state === 'rejected' && !job.acceptance.pending
      ? pickGlyph('failed') : pickGlyph(job.status);
    const line = `${glyph} ${workerHeading(job)}${turns > 1 ? ` · turn ${turns}` : ''} — ${workerStatus(job)}${span !== null ? ` · ${elapsed(span)}` : ''}`;
    lines.push(oneLine(line, BOARD_WIDTH));
  }
  if (workers.length > shown.length) lines.push(`…and ${workers.length - shown.length} more`);
  return lines.join('\n');
}

/**
 * One row of the detail timeline: a single event, or a condensed run of
 * completed read/search/command tool calls (see `condenseTimeline`).
 */
export type TimelineItem =
  | { readonly kind: 'event'; readonly event: ActivityEvent }
  | { readonly kind: 'group'; readonly key: string; readonly events: readonly ActivityEvent[];
      readonly reads: number; readonly searches: number; readonly commands: number };

/** A run shorter than this is not worth a group; three rows already read fine. */
const RUN_MIN = 3;

type Condensable = 'read' | 'search' | 'command';

/** The kind of a completed read, search or plain shell call, else null. */
function condensableKind(event: ActivityEvent): Condensable | null {
  if (event.kind !== 'tool' || event.state !== 'done') return null;
  const kind = classify(event.tool, event.input).kind;
  return kind === 'read' || kind === 'search' || kind === 'command' ? kind : null;
}

/**
 * Fold long stretches of finished read/search/command calls into one expandable row.
 *
 * Only runs of three or more CONSECUTIVE completed read/search/command calls fold, and
 * the last event of the timeline never joins a run: it is where an active or
 * errored call lives, and folding it would hide the newest thing that happened.
 * Active and errored calls therefore always break a run. Everything else — edits,
 * tests, assistant prose — is left exactly where it was.
 */
export function condenseTimeline(events: readonly ActivityEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  // The last event is always drawn as itself.
  const limit = Math.max(0, events.length - 1);
  let i = 0;
  while (i < events.length) {
    const start = i;
    const kinds: Condensable[] = [];
    while (i < limit) {
      const kind = condensableKind(events[i]!);
      if (kind === null) break;
      kinds.push(kind);
      i += 1;
    }
    if (kinds.length === 0) {
      items.push({ kind: 'event', event: events[i]! });
      i += 1;
      continue;
    }
    const run = events.slice(start, i);
    if (kinds.length >= RUN_MIN) {
      const count = (k: Condensable) => kinds.filter((kind) => kind === k).length;
      items.push({ kind: 'group', key: `group-${run[0]!.sequence}`, events: run,
        reads: count('read'), searches: count('search'), commands: count('command') });
    } else {
      for (const event of run) items.push({ kind: 'event', event });
    }
  }
  return items;
}

/** `read 5 files · 2 searches · 3 commands` for a condensed run. Every count is real. */
export function timelineGroupLabel(reads: number, searches: number, commands = 0): string {
  const parts: string[] = [];
  if (reads > 0) parts.push(`read ${reads} ${reads === 1 ? 'file' : 'files'}`);
  if (searches > 0) parts.push(`${searches} ${searches === 1 ? 'search' : 'searches'}`);
  if (commands > 0) parts.push(`${commands} ${commands === 1 ? 'command' : 'commands'}`);
  return parts.join(' · ');
}

/**
 * Head-turn selection rule for one worker across turns (matches ForgeService):
 * (1) `!supersededBy` > `Boolean(supersededBy)`
 * (2) `isLive` > terminal
 * (3) higher `turn`
 * (4) newer `startedAt ?? endedAt ?? 0`
 * (5) deterministic `id` tie-breaker
 */
export function isBetterHead(candidate: RadarJob, current: RadarJob): boolean {
  const cSup = Boolean(candidate.supersededBy);
  const oSup = Boolean(current.supersededBy);
  if (cSup !== oSup) return !cSup;
  const cLive = isLive(candidate);
  const oLive = isLive(current);
  if (cLive !== oLive) return cLive;
  const cTurn = candidate.turn ?? 1;
  const oTurn = current.turn ?? 1;
  if (cTurn !== oTurn) return cTurn > oTurn;
  const cAt = candidate.startedAt ?? candidate.endedAt ?? 0;
  const oAt = current.startedAt ?? current.endedAt ?? 0;
  if (cAt !== oAt) return cAt > oAt;
  return candidate.id.localeCompare(current.id) > 0;
}

/** Group turns by `workerId`, keeping each worker's head turn. */
export function groupWorkers(jobs: readonly RadarJob[]): RadarJob[] {
  const groups = new Map<string, RadarJob>();
  for (const job of jobs) {
    const key = job.workerId || job.id;
    const old = groups.get(key);
    if (!old || isBetterHead(job, old)) groups.set(key, job);
  }
  return [...groups.values()].sort((a, b) =>
    (b.startedAt ?? b.endedAt ?? 0) - (a.startedAt ?? a.endedAt ?? 0) || a.id.localeCompare(b.id));
}

/** All turns belonging to one worker, sorted oldest-first (Turn 1, Turn 2, ...). */
export function workerTurns(jobs: readonly RadarJob[], workerId: string): RadarJob[] {
  return jobs
    .filter((job) => job.workerId === workerId)
    .sort((a, b) =>
      (a.turn ?? 1) - (b.turn ?? 1) ||
      (a.startedAt ?? a.endedAt ?? 0) - (b.startedAt ?? b.endedAt ?? 0) ||
      a.id.localeCompare(b.id));
}

/** The head turn for one worker, or undefined when none exist. */
export function workerHead(jobs: readonly RadarJob[], workerId: string): RadarJob | undefined {
  let best: RadarJob | undefined;
  for (const job of jobs) {
    if (job.workerId !== workerId) continue;
    if (!best || isBetterHead(job, best)) best = job;
  }
  return best;
}

/** What this session launched: job ids and pipeline run ids, kept for the whole session. */
export interface Launched { readonly jobs: readonly string[]; readonly runs: readonly string[] }
export function recordLaunch(prev: Launched, launch: { readonly kind: 'job' | 'run'; readonly id: string }): Launched {
  const key = launch.kind === 'job' ? 'jobs' : 'runs';
  return prev[key].includes(launch.id) ? prev : { ...prev, [key]: [...prev[key], launch.id] };
}
/** The jobs this session launched (including steered/resumed turns of those workers), and the stage jobs of its pipeline runs. */
export function sessionJobs(jobs: readonly RadarJob[], launched: Launched): RadarJob[] {
  const ownedIds = new Set(launched.jobs);
  const ownedWorkers = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const job of jobs) {
      if (ownedIds.has(job.id) && !ownedWorkers.has(job.workerId)) {
        ownedWorkers.add(job.workerId);
        changed = true;
      }
      if (ownedWorkers.has(job.workerId) && !ownedIds.has(job.id)) {
        ownedIds.add(job.id);
        changed = true;
      }
      if (ownedIds.has(job.id) && job.supersededBy && !ownedIds.has(job.supersededBy)) {
        ownedIds.add(job.supersededBy);
        changed = true;
      }
      if (job.continuedFrom && ownedIds.has(job.continuedFrom) && !ownedIds.has(job.id)) {
        ownedIds.add(job.id);
        changed = true;
      }
    }
  }
  return jobs.filter((job) => ownedIds.has(job.id) || (job.pipeline != null && launched.runs.includes(job.pipeline)));
}
/** `2 running · 1 failed · 3 finished`: one count per listed worker, zeros left out; '' for none. */
export function countLine(jobs: readonly RadarJob[]): string {
  const c = countSummary(forgeList(jobs));
  return ([['running', c.running], ['failed', c.failed], ['done', c.finished]] as const)
    .filter(([, n]) => n > 0).map(([label, n]) => `${n} ${label}`).join(' · ');
}
/** The /forge reply and list header: this session's counts, or the repository's, labelled. */
export function scopeLine(jobs: readonly RadarJob[], scope: 'session' | 'all'): string {
  const line = countLine(jobs);
  return scope === 'all' ? `repository: ${line || 'no workers yet'}` : line || 'No workers in this session';
}
