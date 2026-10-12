/** Thin terminal adapter for the canonical forge runtime. */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { ForgeService, pipelineRecordPath } from '../forge/service.ts';
import { writeJsonAtomic } from '../forge/atomic.ts';
import { archivedJobsDir, FILES, jobFile, jobsDir } from '../forge/format.ts';
import { startPipeline, cancelPipeline, readPipeline } from '../forge/execute.ts';
import type { PipelineRun, PipelineSpec, Stage } from '../pipeline/types.ts';
import { detectAvailable, missingProviders } from '../providers/registry.ts';
import { allLadders } from './ladders.ts';
import { loadSpec, parseDuration, parseYaml, specFrom } from './spec.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXIT = { ok: 0, usage: 1, failed: 2, notFound: 3, spawnFailed: 4 } as const;

interface RunArgs {
  readonly target: string;
  readonly prompt?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly timeout?: string;
  readonly repo?: string;
  readonly cwd?: string;
  readonly unrestricted?: boolean;
  readonly foreground?: boolean;
  readonly concurrency?: string;
  readonly checks?: readonly string[];
  readonly name?: string;
  readonly workerId?: string;
  readonly conversation?: string;
  readonly routingPinned?: boolean;
}

export function taskTitle(prompt: string): string {
  return (prompt.split('\n').find((line) => line.trim() !== '') ?? '').replace(/^#\s*/, '').slice(0, 200);
}

function rolePrompt(role: string, name: string): string {
  if (role === 'review') return `Review the work of the '${name}' stage. Report defects, missed cases, and unsupported claims. Do not rewrite the work.`;
  if (role === 'moderate') return 'Probe the prior work independently. Report findings only.';
  if (role === 'verify') return 'Run the checks and report what actually happened.';
  return 'Do the work and report what you changed and found.';
}

function singleStageSpec(args: RunArgs, repo: string): PipelineSpec {
  if (args.prompt === undefined || args.prompt.trim() === '') {
    throw new UsageError(`run ${args.target} needs --prompt "…"`);
  }
  if (args.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(args.effort)) {
    throw new UsageError(`--effort must be low, medium, high, xhigh, max, or ultra; got '${args.effort}'`);
  }
  const stage: Record<string, unknown> = {
    name: args.target,
    provider: args.provider ?? 'agy',
    role: args.target,
    prompt: `${rolePrompt(args.target, args.target)}\n\n${args.prompt}`,
    title: taskTitle(args.prompt),
  };
  if (args.name !== undefined) stage['agentName'] = args.name;
  if (args.workerId !== undefined) stage['workerId'] = args.workerId;
  if (args.conversation !== undefined) stage['conversation'] = args.conversation;
  if (args.routingPinned === true) stage['routingPinned'] = true;
  if (args.cwd !== undefined) stage['workDir'] = args.cwd;
  if (args.model !== undefined) stage['model'] = args.model;
  if (args.effort !== undefined) stage['effort'] = args.effort;
  if (args.checks !== undefined && args.checks.length > 0) {
    stage['checks'] = args.checks.map((command) => ({ command, name: command }));
  }
  const timeoutMs = args.timeout === undefined ? undefined : parseCliDuration(args.timeout, '--timeout');
  if (timeoutMs !== undefined) stage['timeoutMs'] = timeoutMs;
  return { name: args.target, workDir: repo, stages: [stage as unknown as Stage] };
}

async function resolveSpec(args: RunArgs, repo: string): Promise<PipelineSpec> {
  let spec: PipelineSpec;
  if (args.target.endsWith('.yaml') || args.target.endsWith('.yml')) {
    const loaded = loadSpec(path.resolve(args.target));
    spec = { ...loaded, workDir: loaded.workDir ?? repo };
  } else {
    spec = singleStageSpec(args, repo);
  }
  if (args.timeout !== undefined && (args.target.endsWith('.yaml') || args.target.endsWith('.yml'))) {
    const timeoutMs = parseCliDuration(args.timeout, '--timeout');
    spec = { ...spec, stages: spec.stages.map((stage) => ({ ...stage, timeoutMs: stage.timeoutMs ?? timeoutMs })) };
  }
  if (args.concurrency !== undefined) {
    const concurrency = Number(args.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new UsageError('--concurrency must be a positive integer');
    spec = { ...spec, concurrency };
  }
  return spec;
}

function parseCliDuration(raw: string, flag: string): number {
  try { return parseDuration(raw); }
  catch (error) { throw new UsageError(`${flag}: ${error instanceof Error ? error.message : String(error)}`); }
}

export function newRunId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'run';
  return `${slug}-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
}

export async function cmdRun(args: RunArgs): Promise<number> {
  const repo = path.resolve(args.repo ?? process.cwd());
  const spec = await resolveSpec(args, repo);
  const required = [...new Set(spec.stages.map((stage) => stage.provider))];
  const unknown = missingProviders(required);
  if (unknown.length > 0) {
    process.stderr.write(`agent-smith: no adapter for provider(s): ${unknown.join(', ')}\n`);
    return EXIT.usage;
  }
  const unavailable = (await detectAvailable()).filter((entry) => required.includes(entry.name) && !entry.available);
  if (unavailable.length > 0) {
    for (const entry of unavailable) process.stderr.write(`agent-smith: provider '${entry.name}' is not installed (looked for '${entry.binary}' on PATH).\n`);
    return EXIT.usage;
  }
  const runId = newRunId(spec.name);
  if (args.foreground === true) {
    process.stdout.write(`${runId}\n`);
    return supervise({ kind: 'supervise', spec, repo, runId, unrestricted: args.unrestricted === true });
  }

  const payload: SupervisePayload = { kind: 'supervise', spec, repo, runId, unrestricted: args.unrestricted === true };
  const recordPath = pipelineRecordPath(repo, runId);
  writeJsonAtomic(recordPath, { runId, pipeline: spec.name, status: 'running', startedAt: Date.now(), finishedAt: null, stageResults: {} });
  const child = spawn(process.execPath, [...process.execArgv, '--experimental-strip-types', path.join(HERE, 'cli.ts'), 'supervise', JSON.stringify(payload)], {
    cwd: repo, stdio: 'ignore', detached: true, env: process.env,
  });
  child.unref();
  if (child.pid === undefined) {
    process.stderr.write('agent-smith: could not start the supervisor. Re-run with --foreground to see the error.\n');
    return EXIT.spawnFailed;
  }
  process.stdout.write(`${runId}\n`);
  process.stderr.write(`agent-smith: ${spec.stages.length} stage(s) started in the background.\n  repo   ${repo}\n  state  ${path.dirname(recordPath)}\n  cancel agent-smith cancel ${runId}\n  status agent-smith status ${runId}\n`);
  if (args.unrestricted === true) process.stderr.write('  safety --unrestricted: worker approval prompts are bypassed.\n');
  return EXIT.ok;
}

interface NamedJobDetail {
  readonly jobId: string;
  readonly status: string;
  readonly provider: string | null;
  readonly mode: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly cwd: string;
  readonly unrestricted: boolean;
  readonly conversation: string | null;
  readonly name: string;
  readonly workerId: string;
  readonly latestSummary: string | null;
  readonly updatedAt: string | null;
}

/** Continue the exact worker conversation and settings captured by the forge. */
export async function cmdResume(identifier: string, args: RunArgs): Promise<number> {
  if (args.prompt === undefined || args.prompt.trim() === '') throw new UsageError('resume needs --prompt "…"');
  const repo = path.resolve(args.repo ?? process.cwd());
  const service = new ForgeService({ repo });
  let selected: NamedJobDetail | undefined;
  try {
    selected = await service.detail(identifier) as unknown as NamedJobDetail;
  } catch {
    const matches = (await service.list({ limit: 1000 })).filter((job) => job.name === identifier)
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    const workerIds = new Set(matches.map((job) => job.workerId));
    if (workerIds.size > 1) throw new UsageError(`worker name '${identifier}' is ambiguous; use a job id: ${matches.map((job) => job.jobId).join(', ')}`);
    const active = matches.find((job) => job.status === 'running');
    if (active !== undefined) throw new UsageError(`worker '${identifier}' is still running; cancel or wait before resuming`);
    if (matches[0] !== undefined) selected = await service.detail(matches[0].jobId) as unknown as NamedJobDetail;
  }
  if (selected === undefined) throw new UsageError(`no worker '${identifier}' in ${repo}/.agent-smith/jobs`);
  if (selected.status === 'running') throw new UsageError(`worker '${identifier}' is still running; cancel or wait before resuming`);
  if (selected.conversation === null || selected.conversation === '') throw new UsageError(`worker '${identifier}' has no conversation id to resume`);
  if (args.provider !== undefined && args.provider !== selected.provider) throw new UsageError(`resume cannot change provider from '${selected.provider ?? 'unknown'}'; conversation handles belong to their provider`);

  const model = args.model ?? selected.model ?? undefined;
  const effort = args.effort ?? selected.effort ?? undefined;
  const target = selected.mode ?? 'resume';
  const workerName = args.name ?? selected.name ?? selected.mode ?? identifier;
  const workerId = selected.workerId || selected.jobId;
  return cmdRun({ ...args, target, repo, cwd: args.cwd ?? selected.cwd ?? repo, provider: selected.provider ?? 'agy', model, effort, name: workerName, workerId, conversation: selected.conversation, routingPinned: true, unrestricted: args.unrestricted === true || selected.unrestricted, prompt: args.prompt });
}

interface SupervisePayload {
  readonly kind: 'supervise';
  readonly spec: PipelineSpec;
  readonly repo: string;
  readonly runId: string;
  readonly unrestricted: boolean;
}

async function supervise(payload: SupervisePayload): Promise<number> {
  const service = new ForgeService({ repo: payload.repo });
  const execution = startPipeline(service, payload.spec, {
    runId: payload.runId,
    unrestricted: payload.unrestricted,
    concurrency: payload.spec.concurrency,
    ladders: allLadders(),
    adoptExisting: true,
  });
  const run = await execution.done;
  printRunSummary(run);
  return run.status === 'passed' ? EXIT.ok : EXIT.failed;
}

function printRunSummary(run: PipelineRun): void {
  process.stdout.write(`\npipeline ${run.status}\n`);
  for (const [name, result] of Object.entries(run.outcomes)) {
    process.stdout.write(`  ${result.status === 'passed' ? '✓' : result.status === 'skipped' ? '·' : '✗'} ${name}: ${result.status} (${Math.round(result.durationMs / 1000)}s)\n`);
    if (result.failure !== undefined) process.stdout.write(`    ${result.failure.code}: ${result.failure.message}\n`);
  }
}

export async function cmdLs(filter: { status?: string; limit?: number; repo?: string } = {}): Promise<number> {
  const service = new ForgeService({ repo: path.resolve(filter.repo ?? process.cwd()) });
  const jobs = await service.list({ ...(filter.status === undefined ? {} : { status: filter.status as never }), limit: filter.limit ?? 50 });
  if (jobs.length === 0) {
    process.stdout.write('No jobs. Start one with `agent-smith run implement --prompt "…"`\n');
    return EXIT.ok;
  }
  process.stdout.write('ID\tSTATUS\tPROVIDER\tSTAGE\tTASK\n');
  for (const job of jobs) {
    const detail = await service.detail(job.jobId) as typeof job & { name?: string; latestSummary?: string | null };
    process.stdout.write(`${job.jobId}\t${job.status}\t${job.provider ?? '-'}\t${detail.name ?? job.mode ?? '-'}\t${(detail.latestSummary ?? job.task ?? '').slice(0, 80)}\n`);
  }
  return EXIT.ok;
}

export async function cmdStatus(jobId: string, repo = process.cwd()): Promise<number> {
  const root = path.resolve(repo);
  const service = new ForgeService({ repo: root });
  try {
    const record = readPipeline(root, jobId);
    if (record === null) throw new Error('missing pipeline record');
    process.stdout.write(`run       ${jobId}\nstatus    ${record.status}\npipeline  ${record.pipeline}\nrepo      ${root}\n`);
    for (const [stage, result] of Object.entries(record.stageResults)) {
      const jobId = (result as typeof result & { jobId?: string }).jobId ?? '-';
      const detail = jobId === '-' ? null : await service.detail(jobId).catch(() => null);
      const name = (detail as (typeof detail & { name?: string }) | null)?.name ?? '-';
      process.stdout.write(`  ${stage}\t${jobId}\t${result.status}\tacceptance=${result.acceptance ?? 'unchecked'}\t${name}\t${result.provider}\n`);
    }
    return EXIT.ok;
  } catch { /* maybe this is a worker job id */ }
  try {
    const detail = await service.detail(jobId);
    process.stdout.write(`id        ${detail.jobId}\nstatus    ${detail.status}\nname      ${detail.name || '-'}\nrole      ${detail.role ?? detail.mode ?? '-'}\ntask      ${detail.task ?? '-'}\nprovider  ${detail.provider ?? '-'}\nmode      ${detail.mode ?? '-'}\nrepo      ${root}\n`);
    if (detail.currentActivity !== null) process.stdout.write(`activity  ${detail.currentActivity.tool} (${detail.currentActivity.status})\n`);
    if (detail.latestSummary !== null && detail.summarySource === 'worker') process.stdout.write(`summary   [worker] ${detail.latestSummary}\n`);
    if (detail.report !== null) process.stdout.write(`\n${detail.report}\n`);
    if (detail.error !== null) process.stdout.write(`error     ${detail.error}\n`);
    return EXIT.ok;
  } catch {
    process.stderr.write(`agent-smith: no run or job '${jobId}' in ${root}/.agent-smith\n`);
    return EXIT.notFound;
  }
}

export async function cmdCancel(id: string, repo = process.cwd()): Promise<number> {
  const root = path.resolve(repo);
  try {
    const result = cancelPipeline(root, id);
    process.stdout.write(`${id}\n`);
    process.stderr.write(`agent-smith: ${result.note}\n`);
    return EXIT.ok;
  } catch { /* try a worker job id */ }
  try {
    const result = new ForgeService({ repo: root }).cancel(id);
    process.stdout.write(`${id}\n`);
    process.stderr.write(`agent-smith: ${result.note}\n`);
    return EXIT.ok;
  } catch (error) {
    process.stderr.write(`agent-smith: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.notFound;
  }
}

interface GcArgs {
  readonly olderThan?: string;
  readonly delete?: boolean;
  readonly dryRun?: boolean;
  readonly repo?: string;
}

const GC_DEFAULT_AGE = '14d';
const GC_SETTLED_STATUSES = new Set(['succeeded', 'failed', 'canceled']);
const GC_UNIT_HOURS: Readonly<Record<'h' | 'd' | 'w', number>> = { h: 1, d: 24, w: 168 };

/** Parses gc ages such as 12h, 14d or 2w. */
function parseGcAge(raw: string): number {
  const match = /^(\d+)([hdw])$/.exec(raw.trim());
  if (match === null) throw new UsageError(`--older-than: '${raw}' is not an age. Use e.g. 12h, 14d or 2w.`);
  return Number(match[1]) * GC_UNIT_HOURS[match[2] as 'h' | 'd' | 'w'] * 3_600_000;
}

function readJobRecord(repo: string, jobId: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(jobFile(repo, jobId, FILES.job), 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

/** finishedAt, else startedAt, else createdAt. Null when none is present; NaN when the chosen one does not parse. */
function settledAtMs(job: Record<string, unknown>): number | null {
  for (const key of ['finishedAt', 'startedAt', 'createdAt']) {
    const value = job[key];
    if (typeof value === 'string') return Date.parse(value);
  }
  return null;
}

/** Delete completion-notice claim markers (.agent-smith/claims) older than the cutoff; they only matter while a job runs. */
function sweepClaims(repo: string, cutoff: number): number {
  const dir = path.join(repo, '.agent-smith', 'claims');
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      try { if (statSync(file).mtimeMs < cutoff) { rmSync(file); removed += 1; } } catch { /* raced or unreadable: leave it */ }
    }
  } catch { /* no claims yet */ }
  return removed;
}

/** Archives (default), deletes, or dry-runs settled jobs older than a threshold. Running jobs are never touched. */
export async function cmdGc(args: GcArgs = {}): Promise<number> {
  const repo = path.resolve(args.repo ?? process.cwd());
  const ageRaw = args.olderThan ?? GC_DEFAULT_AGE;
  const cutoff = Date.now() - parseGcAge(ageRaw);
  let jobIds: string[] = [];
  try {
    jobIds = readdirSync(jobsDir(repo), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch { /* A missing job store is the ordinary fresh-repo case. */ }
  const action = args.delete === true ? 'delete' : 'archive';
  const label = args.dryRun === true ? `would ${action}` : `${action}d`;
  let acted = 0;
  let kept = 0;
  let skipped = 0;
  for (const jobId of jobIds) {
    const job = readJobRecord(repo, jobId);
    if (job === null) {
      process.stderr.write(`agent-smith: skipped ${jobId}: job.json is missing or unreadable\n`);
      skipped += 1;
      continue;
    }
    if (job['status'] === 'running') { kept += 1; continue; }
    if (typeof job['status'] !== 'string' || !GC_SETTLED_STATUSES.has(job['status'])) {
      process.stderr.write(`agent-smith: skipped ${jobId}: unknown status ${JSON.stringify(job['status'])}\n`);
      skipped += 1;
      continue;
    }
    const settled = settledAtMs(job);
    if (settled === null || Number.isNaN(settled)) {
      process.stderr.write(`agent-smith: skipped ${jobId}: no valid finishedAt, startedAt or createdAt\n`);
      skipped += 1;
      continue;
    }
    if (settled > cutoff) { kept += 1; continue; }
    const source = path.join(jobsDir(repo), jobId);
    const target = path.join(archivedJobsDir(repo), jobId);
    if (args.delete !== true && existsSync(target)) {
      process.stderr.write(`agent-smith: skipped ${jobId}: ${target} already exists\n`);
      skipped += 1;
      continue;
    }
    if (args.dryRun !== true) {
      if (args.delete === true) rmSync(source, { recursive: true });
      else {
        mkdirSync(archivedJobsDir(repo), { recursive: true });
        renameSync(source, target);
      }
    }
    process.stdout.write(`${label} ${jobId}\n`);
    acted += 1;
  }
  const swept = args.dryRun === true ? 0 : sweepClaims(repo, cutoff);
  if (swept > 0) process.stdout.write(`removed ${swept} completion-notice claim marker(s)\n`);
  process.stdout.write(`gc: ${acted} ${args.dryRun === true ? 'would be ' : ''}${action}d, ${kept} kept, ${skipped} skipped (older than ${ageRaw})\n`);
  return EXIT.ok;
}

export async function cmdDoctor(): Promise<number> {
  process.stdout.write('agent-smith doctor\n\n');
  const rows = await detectAvailable();
  const width = Math.max(0, ...rows.map((row) => row.name.length));
  let any = false;
  for (const row of rows) {
    if (row.available) any = true;
    process.stdout.write(` ${row.available ? '●' : '○'} ${row.name.padEnd(width)}  ${row.available ? 'available' : 'not installed'}  (${row.binary})\n`);
  }
  process.stdout.write(`\nstate\n  repo  ${process.cwd()}\n  jobs  ${path.join(process.cwd(), '.agent-smith', 'jobs')}\n`);
  return any ? EXIT.ok : EXIT.failed;
}

export const USAGE = `agent-smith — forge for coding agents\n\n  agent-smith run implement --prompt "…" [--name worker] [--repo path] [--cwd path]\n                            [--provider agy] [--model …] [--effort low] [--check "npm test"]\n  agent-smith run ./pipeline.yaml [--foreground]\n  agent-smith resume <jobId|worker-name> --prompt "…" [--repo path] [--cwd path]\n  agent-smith ls [--status running]\n  agent-smith status <runId|jobId>\n  agent-smith cancel <runId|jobId>\n  agent-smith gc [--older-than 14d] [--delete] [--dry-run] [--repo path]\n  agent-smith doctor\n\nWorkers run on this machine. They are restricted by default; --unrestricted bypasses provider approval prompts.\n`;

class UsageError extends Error {}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: {
      prompt: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
      timeout: { type: 'string' }, repo: { type: 'string' }, cwd: { type: 'string' }, name: { type: 'string' }, unrestricted: { type: 'boolean', default: false },
      foreground: { type: 'boolean', default: false }, concurrency: { type: 'string' }, check: { type: 'string', multiple: true },
      status: { type: 'string' }, limit: { type: 'string' }, help: { type: 'boolean', short: 'h', default: false },
      'older-than': { type: 'string' }, delete: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
    }, allowPositionals: true, strict: true });
  } catch (error) {
    process.stderr.write(`agent-smith: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return EXIT.usage;
  }
  const { values, positionals } = parsed;
  const command = positionals[0];
  if (values.help === true || command === undefined || command === 'help') { process.stdout.write(USAGE); return EXIT.ok; }
  try {
    switch (command) {
      case 'run': return await cmdRun({ target: positionals[1] ?? '', prompt: values.prompt, provider: values.provider, model: values.model, effort: values.effort, timeout: values.timeout, repo: values.repo, cwd: values.cwd, name: values.name, unrestricted: values.unrestricted, foreground: values.foreground, concurrency: values.concurrency, checks: values.check });
      case 'resume': if (positionals[1] === undefined) throw new UsageError('resume needs a job id or worker name'); return await cmdResume(positionals[1], { target: 'resume', prompt: values.prompt, provider: values.provider, model: values.model, effort: values.effort, timeout: values.timeout, repo: values.repo, cwd: values.cwd, name: values.name, unrestricted: values.unrestricted, foreground: values.foreground, concurrency: values.concurrency, checks: values.check });
      case 'ls': return await cmdLs({ status: values.status, limit: values.limit === undefined ? undefined : Number(values.limit), repo: values.repo });
      case 'status': if (positionals[1] === undefined) throw new UsageError('status needs a run or job id'); return await cmdStatus(positionals[1], values.repo);
      case 'cancel': if (positionals[1] === undefined) throw new UsageError('cancel needs a run or job id'); return await cmdCancel(positionals[1], values.repo);
      case 'gc': return await cmdGc({ olderThan: values['older-than'], delete: values.delete, dryRun: values['dry-run'], repo: values.repo });
      case 'doctor': return await cmdDoctor();
      case 'supervise': if (positionals[1] === undefined) throw new UsageError('supervise takes a JSON payload'); return await supervise(JSON.parse(positionals[1]) as SupervisePayload);
      default: process.stderr.write(`agent-smith: unknown command '${command}'\n\n${USAGE}`); return EXIT.usage;
    }
  } catch (error) {
    if (error instanceof UsageError || (error instanceof Error && (error.name === 'SpecParseError' || error.name === 'PipelineSpecError' || error.name === 'CrossFamilyViolation'))) {
      process.stderr.write(`agent-smith: ${error.message}\n`); return EXIT.usage;
    }
    process.stderr.write(`agent-smith: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return EXIT.failed;
  }
}

export { parseYaml, specFrom };

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
  process.stderr.write(`agent-smith: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = EXIT.failed;
});
