import type { ActivityEvent, RadarAcceptance, RadarJob } from '../types/index.d.ts';
import { continuationLabel, countSummary, effectiveStart, elapsed, elapsedCell, failedChecks, failureWords, fitCell, isTerminal, jobLabel, livenessWords, oneLine, pendingSteersLabel, pickGlyph } from './format.ts';
import { classify } from './progress.ts';
import { compareTurnPriority, type TurnLike } from './turns.ts';

export const ATTENTION_TTL_MS = 24 * 60 * 60 * 1000;

export const PANE_FALLBACK_COLUMNS = 60;
export const PANE_MIN_COLUMNS = 24;

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

export function commandTerminalColumns(presentation: unknown): number | undefined {
  if (typeof presentation !== 'object' || presentation === null) return undefined;
  const columns = (presentation as { readonly columns?: unknown }).columns;
  if (typeof columns !== 'number' || !Number.isFinite(columns) || columns <= 0) return undefined;
  return Math.floor(columns);
}

function expired(job: RadarJob, now?: number): boolean {
  if (now === undefined || !isTerminal(job.status) || job.acceptance?.pending) return false;
  const at = job.endedAt ?? job.startedAt;
  return at !== null && now - at > ATTENTION_TTL_MS;
}
export function needsAttention(job: RadarJob, now?: number): boolean {
  return !expired(job, now) && (job.status === 'attention' || job.status === 'failed' || job.acceptance?.state === 'rejected');
}
export function isLive(job: RadarJob): boolean {
  if ((job.supersededBy || job.followedBy) && isTerminal(job.status)) return false;
  return !isTerminal(job.status) || job.acceptance?.pending === true;
}
export function forgeList(jobs: readonly RadarJob[]): RadarJob[] {
  const workers = groupWorkers(jobs);
  const ended = (job: RadarJob) => job.endedAt ?? job.startedAt ?? 0;
  return [...workers.filter(isLive), ...workers.filter((job) => !isLive(job)).sort((a, b) => ended(b) - ended(a) || a.id.localeCompare(b.id))];
}
export function findWorker(jobs: readonly RadarJob[], query: string): RadarJob | undefined {
  const q = query.trim().toLowerCase();
  return jobs.find((job) => job.id === query.trim()) ??
    forgeList(jobs).find((job) => job.name?.trim().toLowerCase() === q || job.workerId.toLowerCase() === q);
}
export function workerHeading(job: RadarJob): string {
  const role = oneLine(job.role ?? job.provider ?? '');
  return `${jobLabel(job)}${role ? ` · ${role}` : ''}`;
}
export function workerStatus(job: RadarJob): string {
  if (job.supersededBy && isTerminal(job.status)) return 'steered';
  if (job.acceptance?.pending && isTerminal(job.status)) {
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
  if (job.status === 'succeeded' && job.acceptance?.state === 'accepted' && job.acceptance.checks.length > 0) {
    const label = checksLabel(job.acceptance);
    if (label !== '') parts.push(label);
  }
  const cont = continuationLabel(job.continuationKind);
  if (cont !== '') parts.push(cont);
  return parts.join(' · ');
}

export const PANE_QUIET_MS = 2 * 60_000;

export interface WorkerLivenessLine {
  readonly text: string;
  readonly tone: 'dim' | 'yellow' | 'red';
}

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

function changedFilesPhrase(job: RadarJob): string {
  const count = typeof job.changedFileCount === 'number' && job.changedFileCount > 0 ? job.changedFileCount
    : (job.progress && job.progress.editedCount > 0 ? job.progress.editedCount : 0);
  if (count <= 0) return '';
  return `${count} ${count === 1 ? 'file' : 'files'} ${job.changedFileCount === count ? 'changed' : 'edited'}`;
}
export function checksLabel(acceptance?: RadarAcceptance): string {
  if (!acceptance) return '';
  if (acceptance.pending) return 'checking';
  const failed = acceptance.checks.filter((check) => !check.ok);
  if (failed.length > 0) return `✗ ${failed.map((check) => oneLine(check.name)).join(', ')}`;
  if (acceptance.checks.length > 0) return `checks ✓ ${acceptance.checks.length}/${acceptance.checks.length}`;
  return acceptance.state === 'rejected' ? 'checks failed' : '';
}
export function statusLine(job: RadarJob, now: number, width: number): string {
  const start = effectiveStart(job);
  if (start === null) return oneLine(workerStatus(job), Math.max(1, width));
  const clock = elapsedCell((job.endedAt ?? now) - start);
  const room = Math.max(1, width - clock.length - 3);
  const status = isTerminal(job.status) ? `${workerStatus(job)} · started ${clockTime(start)}` : workerStatus(job);
  return `${oneLine(status, room).padEnd(room)}   ${clock}`;
}
function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function turnCount(job: RadarJob, allJobs: readonly RadarJob[]): number {
  const observed = allJobs.filter((other) => other.workerId === job.workerId).length;
  return Math.max(1, job.turn ?? 1, observed);
}

export function priorTurnSummary(
  job: RadarJob,
  fallbackTurn: number,
  now: number,
  options: { readonly width?: number; readonly open?: boolean; readonly prompt?: string | null; readonly messages?: RadarJob['messages'] } = {},
): string {
  const turn = job.turn ?? fallbackTurn;
  const open = options.open === true;
  const prefix = `${open ? '▾' : '▸'} ${turn}  `;
  const messages = options.messages ?? job.messages;
  const msg = oneLine(messages && messages.length > 0 ? messages[0]!.text : (options.prompt ?? job.prompt ?? job.task));
  if (open) {
    const shown = options.width !== undefined ? oneLine(msg, Math.max(1, options.width - prefix.length)) : msg;
    return `${prefix}${shown}`.trimEnd();
  }
  let state: string;
  if (job.supersededBy && isTerminal(job.status)) {
    state = 'steered';
  } else if (job.status === 'succeeded') {
    const checks = checksLabel(job.acceptance);
    state = checks !== '' ? checks : job.acceptance?.state === 'rejected' && !job.acceptance.pending ? 'checks failed' : 'done';
  } else if (job.status === 'failed') {
    const why = failureWords(job);
    state = why === '' ? 'failed' : `failed · ${why}`;
  } else {
    state = job.status;
  }
  const span = job.startedAt === null ? null : (job.endedAt ?? now) - job.startedAt;
  const right = [state, span !== null ? elapsed(span) : ''].filter(Boolean).join(' · ');
  if (options.width !== undefined) {
    const room = options.width - prefix.length - right.length - 2;
    if (room >= 8) return `${prefix}${fitCell(msg, room)}  ${right}`;
    return oneLine(`${prefix}${msg}${right ? ` · ${right}` : ''}`, options.width);
  }
  if (msg === '') return right ? `${prefix}${right}` : prefix.trimEnd();
  return `${prefix}${msg}${right ? ` · ${right}` : ''}`.trimEnd();
}

const BOARD_ROWS = 12;
const BOARD_WIDTH = 120;

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

export type TimelineItem =
  | { readonly kind: 'event'; readonly event: ActivityEvent }
  | { readonly kind: 'group'; readonly key: string; readonly events: readonly ActivityEvent[];
      readonly reads: number; readonly searches: number; readonly commands: number };

const RUN_MIN = 3;

type Condensable = 'read' | 'search' | 'command';

function condensableKind(event: ActivityEvent): Condensable | null {
  if (event.kind !== 'tool' || event.state !== 'done') return null;
  const kind = classify(event.tool, event.input).kind;
  return kind === 'read' || kind === 'search' || kind === 'command' ? kind : null;
}

export function condenseTimeline(events: readonly ActivityEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
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

export function timelineGroupLabel(reads: number, searches: number, commands = 0): string {
  const parts: string[] = [];
  if (reads > 0) parts.push(`read ${reads} ${reads === 1 ? 'file' : 'files'}`);
  if (searches > 0) parts.push(`${searches} ${searches === 1 ? 'search' : 'searches'}`);
  if (commands > 0) parts.push(`${commands} ${commands === 1 ? 'command' : 'commands'}`);
  return parts.join(' · ');
}

export function radarTurn(job: RadarJob): TurnLike {
  return {
    jobId: job.id, status: job.status, turn: job.turn, supersededBy: job.supersededBy, followedBy: job.followedBy,
    startedAt: job.startedAt ?? job.endedAt, acceptancePending: job.acceptance?.pending === true,
    pendingMessages: job.pendingMessages ?? job.pendingSteers,
  };
}

function headOf(jobs: readonly RadarJob[]): RadarJob | undefined {
  let best: RadarJob | undefined;
  for (const job of jobs) if (!best || compareTurnPriority(radarTurn(job), radarTurn(best)) < 0) best = job;
  return best;
}

export function groupWorkers(jobs: readonly RadarJob[]): RadarJob[] {
  const groups = new Map<string, RadarJob>();
  for (const job of jobs) {
    const key = job.workerId || job.id;
    const old = groups.get(key);
    if (!old || compareTurnPriority(radarTurn(job), radarTurn(old)) < 0) groups.set(key, job);
  }
  return [...groups.values()].sort((a, b) =>
    (b.startedAt ?? b.endedAt ?? 0) - (a.startedAt ?? a.endedAt ?? 0) || a.id.localeCompare(b.id));
}

export function workerTurns(jobs: readonly RadarJob[], workerId: string): RadarJob[] {
  return jobs
    .filter((job) => job.workerId === workerId)
    .sort((a, b) =>
      (a.turn ?? 1) - (b.turn ?? 1) ||
      (a.startedAt ?? a.endedAt ?? 0) - (b.startedAt ?? b.endedAt ?? 0) ||
      a.id.localeCompare(b.id));
}

export function workerHead(jobs: readonly RadarJob[], workerId: string): RadarJob | undefined {
  return headOf(jobs.filter((job) => job.workerId === workerId));
}

export interface Launched { readonly jobs: readonly string[]; readonly runs: readonly string[] }
export function recordLaunch(prev: Launched, launch: { readonly kind: 'job' | 'run'; readonly id: string }): Launched {
  const key = launch.kind === 'job' ? 'jobs' : 'runs';
  return prev[key].includes(launch.id) ? prev : { ...prev, [key]: [...prev[key], launch.id] };
}
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
      for (const next of [job.supersededBy, job.followedBy]) {
        if (ownedIds.has(job.id) && next && !ownedIds.has(next)) {
          ownedIds.add(next);
          changed = true;
        }
      }
      if (job.continuedFrom && ownedIds.has(job.continuedFrom) && !ownedIds.has(job.id)) {
        ownedIds.add(job.id);
        changed = true;
      }
    }
  }
  return jobs.filter((job) => ownedIds.has(job.id) || (job.pipeline != null && launched.runs.includes(job.pipeline)));
}
export function countLine(jobs: readonly RadarJob[]): string {
  const c = countSummary(forgeList(jobs));
  return ([['running', c.running], ['failed', c.failed], ['done', c.finished]] as const)
    .filter(([, n]) => n > 0).map(([label, n]) => `${n} ${label}`).join(' · ');
}
export function scopeLine(jobs: readonly RadarJob[], scope: 'session' | 'all'): string {
  const line = countLine(jobs);
  return scope === 'all' ? `repository: ${line || 'no workers yet'}` : line || 'No workers in this session';
}
