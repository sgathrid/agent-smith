/** Canonical Forge projection shared by the band, pane and native task bridge.
 * Lists never read reports or event logs. Detail reads one bounded writer view.
 * Kept inside the plugin because the mod loader forbids imports from forge/.
 */
import type { RadarJob, RadarStatus, ToolEntry, RadarAcceptance, ActivityEvent } from '../types/index.d.ts';
import { toEpoch, type FsLike } from './jobs.ts';
import type { ProgressDigest } from '../types/index.d.ts';
import { classify, progressPhrase } from './progress.ts';
import { isStalled } from './stale.ts';
import { firstText, record } from './guards.ts';
import { isLiveStatus } from './format.ts';
import { REASONS, STEER_NOT_APPLIED_RE } from './reasons.ts';

type RecordValue = Record<string, unknown>;
const STATUSES = new Set(['running', 'attention', 'succeeded', 'failed', 'canceled']);
function number(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}
function forgeJobDir(repo: string, id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id) || id === '.' || id === '..') throw new Error('Invalid job id');
  return `${repo.replace(/\/+$/, '')}/.agent-smith/jobs/${id}`;
}
async function json(fs: FsLike, path: string): Promise<RecordValue | null> {
  if (!await fs.exists(path)) return null;
  const value = record(JSON.parse(await fs.read(path)));
  if (value === null) throw new Error(`Invalid Forge record: ${path}`);
  return value;
}
function acceptance(value: RecordValue | null): RadarAcceptance {
  if (value === null) return { state: 'unchecked', checks: [] };
  if (!['accepted', 'rejected', 'unchecked'].includes(String(value.state))) throw new Error('Invalid acceptance state');
  return { state: value.state as RadarAcceptance['state'], pending: value.pending === true,
    checks: (Array.isArray(value.checks) ? value.checks : []).flatMap(c => {
      const check = record(c);
      return check && typeof check.name === 'string' ? [{ name: check.name, ok: check.ok === true,
        outputTail: firstText(check.outputTail) ?? '',
        ...(typeof check.reason === 'string' && check.reason.trim() !== '' ? {reason:check.reason} : {}),
        ...(typeof check.timedOut === 'boolean' ? {timedOut:check.timedOut} : {}),
        ...(typeof check.signal === 'string' || check.signal === null ? {signal:check.signal as string|null} : {}),
        ...(typeof check.skipped === 'string' ? {skipped:check.skipped} : {}),
      }] : [];
    }) };
}
export function acceptanceLabel(value?: RadarAcceptance): string {
  return value?.pending ? 'checking' : value?.state ?? 'unchecked';
}

async function readForgeJob(fs: FsLike, repo: string, id: string, now: number): Promise<RadarJob | null> {
  const dir = forgeJobDir(repo, id);
  const m = await json(fs, `${dir}/job.json`);
  if (m === null) return null;
  if (typeof m.schema === 'number' && m.schema > 1) throw new Error('Unsupported Forge job schema');
  if (!STATUSES.has(String(m.status))) throw new Error('Invalid Forge job status');
  const p = await json(fs, `${dir}/progress.json`);
  let a = acceptance(await json(fs, `${dir}/acceptance.json`));
  let status = m.status as RadarStatus;
  const live = isLiveStatus(status);
  const lastSeen = toEpoch(firstText(p?.lastEventAt, m.updatedAt));
  const warnings = (Array.isArray(p?.warnings) ? p.warnings : []).filter((w): w is string => typeof w === 'string')
    .map(message => ({ code: STEER_NOT_APPLIED_RE.test(message) ? 'steer_not_applied' : 'tool_error', message }));
  if (live && await fs.exists(`${dir}/orphaned`) && !await fs.exists(`${dir}/result.json`)) {
    // The marker proves the supervisor is gone, so a cancel request it never
    // confirmed is a cancellation, not a failure (mirrors forge deriveOrphan).
    const canceled = await fs.exists(`${dir}/cancel`);
    status = canceled ? 'canceled' : 'failed';
    // The supervisor is gone; its spawn-time placeholder cannot settle itself.
    a = { ...a, pending: false };
    if (!canceled) warnings.unshift({ code: 'orphaned', message: REASONS.serverStopped });
  } else if (isStalled(status, lastSeen, now)) status = 'attention';
  if (typeof m.error === 'string' && m.error !== '') warnings.unshift({ code: 'tool_error', message: m.error });
  const activities = Array.isArray(p?.recentActivities) ? p.recentActivities.map(record).filter(v => v !== null) : [];
  const recent = activities.reduce<RecordValue | null>((last, row) =>
    last === null || Number(row.stepIndex) >= Number(last.stepIndex) ? row : last, null);
  const latestActivity = record(p?.lastActivity);
  const latest = latestActivity && typeof latestActivity.tool === 'string' ? latestActivity : recent;
  const resolved = record(m.resolved);
  const latestSummary = firstText(p?.latestSummary, m.latestSummary);
  const progress = digest(p?.digest);
  const now0 = latest ? classify(firstText(latest.tool) ?? '', firstText(latest.input)).label : '';
  const staleReads = (Array.isArray(m.staleReads) ? m.staleReads : []).filter((f): f is string => typeof f === 'string' && f.trim() !== '');
  return {
    id, name: firstText(m.name, resolved?.name, p?.name), workerId: firstText(m.workerId, resolved?.workerId, p?.workerId) ?? id,
    role: firstText(m.role, resolved?.role, p?.role, resolved?.mode, m.mode),
    provider: firstText(m.provider), model: firstText(m.modelResolved, m.model),
    lastEventAt: lastSeen, pipeline: firstText(m.pipeline), stage: firstText(m.stage), attempt: number(m.attempt),
    status, startedAt: toEpoch(firstText(m.startedAt, m.createdAt)), endedAt: toEpoch(firstText(m.finishedAt)) ?? (status === 'failed' && live ? lastSeen : null),
    toolCount: number(p?.toolCalls) ?? number(m.toolCalls),
    activity: progress && isLiveStatus(status) ? progressPhrase(progress, now0) : now0,
    progress,
    task: firstText(m.task) ?? '', latestSummary,
    summarySource: (p?.summarySource ?? m.summarySource) === 'worker' && latestSummary !== null ? 'worker' : null,
    changedFileCount: Array.isArray(m.changedFiles) && m.changedFilesTruncated !== true ? m.changedFiles.length : null,
    acceptance: a, failureReason: firstText(m.reason, m.failureReason, m.error, status === 'failed' ? warnings[0]?.message : null),
    failureDetail: firstText(m.error),
    supersededBy: firstText(m.supersededBy), steeredFrom: firstText(m.steeredFrom),
    pendingSteers: number(p?.pendingSteers) ?? number(m.pendingSteers),
    ...(staleReads.length > 0 ? { staleReads } : {}),
    warnings, report: null, reasoning: firstText(p?.latestText), raw: {},
  };
}
/** progress.json `digest`, accepted only when it has the shape the writer produces. */
function digest(v: unknown): ProgressDigest | null {
  const d = record(v);
  if (d === null || typeof d.phase !== 'string' || !Array.isArray(d.edited)) return null;
  const n = (k: string) => number(d[k]) ?? 0;
  const repeat = record(d.repeat);
  return {
    phase: (['starting', 'exploring', 'editing', 'testing', 'running'].includes(d.phase) ? d.phase : 'running') as ProgressDigest['phase'],
    filesRead: n('filesRead'), searches: n('searches'), commands: n('commands'), testRuns: n('testRuns'),
    edited: d.edited.filter((e): e is string => typeof e === 'string'), editedCount: n('editedCount'),
    lastTestFailed: d.lastTestFailed === true,
    repeat: repeat && typeof repeat.label === 'string' && number(repeat.count) !== null ? { label: repeat.label, count: number(repeat.count)! } : null,
  };
}

export async function readForgeJobs(fs: FsLike, repo: string, now: number): Promise<RadarJob[]> {
  const dir = `${repo.replace(/\/+$/, '')}/.agent-smith/jobs`;
  if (!await fs.exists(dir)) return [];
  const jobs: RadarJob[] = [];
  for (const entry of await fs.list(dir)) {
    if (entry.kind !== 'dir' || entry.name.startsWith('.')) continue;
    const job = await readForgeJob(fs, repo, entry.name, now);
    if (job) jobs.push(job);
  }
  return jobs;
}
export interface ForgeDetail { job: RadarJob; history: ToolEntry[]; transcript: string[]; timeline: ActivityEvent[] | null;
  /** The writer bounded this snapshot, so the timeline is a preview, not the whole run. */
  truncated?: boolean; }
export async function readForgeDetail(fs: FsLike, repo: string, id: string, now: number): Promise<ForgeDetail | null> {
  const job = await readForgeJob(fs, repo, id, now);
  if (!job) return null;
  const dir = forgeJobDir(repo, id);
  const view = await json(fs, `${dir}/view.json`);
  if (view && view.schema !== 1) throw new Error('Unsupported Forge detail schema');
  let report: string | null = null;
  if (await fs.exists(`${dir}/result.md`)) report = await fs.read(`${dir}/result.md`);
  const history: ToolEntry[] = (Array.isArray(view?.tools) ? view.tools : []).flatMap(t => {
    const tool = record(t);
    if (!tool || typeof tool.tool !== 'string') return [];
    return [{ at: toEpoch(firstText(tool.at)), tool: tool.tool, label: firstText(tool.input) ?? '',
      output: firstText(tool.output) ?? '', state: firstText(tool.state) ?? 'done' }];
  });
  const transcript = (Array.isArray(view?.transcript) ? view.transcript : []).filter((t): t is string => typeof t === 'string');
  const timeline: ActivityEvent[] | null = Array.isArray(view?.timeline) ? view.timeline.flatMap(value => {
    const item = record(value);
    if (!item || typeof item.sequence !== 'number' || typeof item.at !== 'string') return [];
    if (item.kind === 'assistant' && typeof item.text === 'string') return [item as ActivityEvent];
    if (item.kind === 'tool' && typeof item.tool === 'string' && typeof item.stepIndex === 'number' &&
      typeof item.input === 'string' && typeof item.output === 'string' && typeof item.state === 'string') return [item as ActivityEvent];
    return [];
  }) : null;
  return { job: { ...job, report, prompt: firstText(view?.prompt), preamble: firstText(view?.preamble),
    // A bounded preview is normal for a long job, not a warning.
    warnings: [...job.warnings, ...(view === null ? [{code:'detail_unavailable',message:'This older job has no detail snapshot; summary and report are shown.'}] : [])] }, history, transcript, timeline,
    truncated: view?.truncated === true };
}
