/** Thin terminal adapter for the canonical forge runtime. */

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { ForgeService, pipelineRecordPath } from '../forge/service.ts';
import { writeJsonAtomic } from '../forge/atomic.ts';
import { archivedJobsDir, FILES, isForgeJobId, jobFile, jobsDir } from '../forge/format.ts';
import { MIRROR_MARKER, mirrorDir } from '../forge/mirror.ts';
import { startPipeline, cancelPipeline, readPipeline } from '../forge/execute.ts';
import type { PipelineRun, PipelineSpec, Stage } from '../pipeline/types.ts';
import { checkCompatibility } from '../providers/compatibility.ts';
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

export interface SetupArgs {
  readonly scope?: string;
  readonly local?: boolean;
  readonly repo?: string;
  readonly marketplace?: string;
}

const CHECKOUT_ROOT = path.resolve(HERE, '..', '..');
const DEFAULT_MARKETPLACE = 'sgathrid/agent-smith';

function configureLocalClaudeSettings(targetRepo: string, marketplaceRoot = CHECKOUT_ROOT): string {
  const pluginManifest = path.join(marketplaceRoot, 'builds', 'local-plugin', 'agent-smith', '.claude-plugin', 'plugin.json');
  const marketplaceManifest = path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json');
  if (!existsSync(pluginManifest)) throw new Error(`Missing built plugin manifest at ${pluginManifest}. Run 'npm run build:plugin' first.`);
  if (!existsSync(marketplaceManifest)) throw new Error(`Missing marketplace manifest at ${marketplaceManifest}.`);
  const directory = path.join(targetRepo, '.claude');
  const settingsFile = path.join(directory, 'settings.local.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsFile)) {
    const parsed: unknown = JSON.parse(readFileSync(settingsFile, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Local Claude settings must be a JSON object.');
    }
    settings = { ...(parsed as Record<string, unknown>) };
  }
  const marketplaces = typeof settings['extraKnownMarketplaces'] === 'object' && settings['extraKnownMarketplaces'] !== null && !Array.isArray(settings['extraKnownMarketplaces'])
    ? { ...(settings['extraKnownMarketplaces'] as Record<string, unknown>) }
    : {};
  delete marketplaces['agent-smith-dev'];
  marketplaces['agent-smith'] = { source: { source: 'directory', path: marketplaceRoot } };
  settings['extraKnownMarketplaces'] = marketplaces;

  const enabled = typeof settings['enabledPlugins'] === 'object' && settings['enabledPlugins'] !== null && !Array.isArray(settings['enabledPlugins'])
    ? { ...(settings['enabledPlugins'] as Record<string, unknown>) }
    : {};
  delete enabled['agent-smith@agent-smith-dev'];
  enabled['agent-smith@agent-smith'] = true;
  settings['enabledPlugins'] = enabled;

  mkdirSync(directory, { recursive: true });
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  return settingsFile;
}

export async function cmdSetup(args: SetupArgs = {}): Promise<number> {
  const scope = args.local === true ? 'local' : (args.scope ?? (args.repo !== undefined ? 'local' : 'user'));
  if (scope !== 'user' && scope !== 'project' && scope !== 'local') {
    throw new UsageError(`--scope must be user, project, or local; got '${scope}'`);
  }
  if (scope === 'local' && args.marketplace === undefined) {
    const targetRepo = path.resolve(args.repo ?? process.cwd());
    if (!existsSync(targetRepo)) throw new UsageError(`repository path does not exist: ${targetRepo}`);
    const settingsFile = configureLocalClaudeSettings(targetRepo);
    process.stdout.write(`Agent Smith enabled in ${settingsFile}\nStart Claude from ${targetRepo} with: claude\n\n`);
    return cmdDoctor();
  }
  const localBuilt = existsSync(path.join(CHECKOUT_ROOT, '.claude-plugin', 'marketplace.json')) &&
    existsSync(path.join(CHECKOUT_ROOT, 'builds', 'local-plugin', 'agent-smith', '.claude-plugin', 'plugin.json'));
  const marketplace = args.marketplace ?? (localBuilt ? CHECKOUT_ROOT : DEFAULT_MARKETPLACE);
  const claudeBin = process.env['AGENT_SMITH_CLAUDE_BIN'] || 'claude';
  const cwd = args.repo === undefined ? process.cwd() : path.resolve(args.repo);
  const result = spawnSync(claudeBin, ['plugin', 'install', 'agent-smith', '--marketplace', marketplace, '--scope', scope], {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error !== undefined) {
    process.stderr.write(`agent-smith: failed to run '${claudeBin} plugin install': ${result.error.message}\n`);
    return EXIT.failed;
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) return EXIT.failed;
  process.stdout.write('\n');
  return cmdDoctor();
}

export interface UninstallArgs {
  readonly local?: boolean;
  readonly repo?: string;
  readonly keepJobs?: boolean;
  readonly homeDir?: string;
}

const MARKETPLACE_KEYS = ['agent-smith', 'agent-smith-dev'] as const;
const PLUGIN_IDS = ['agent-smith@agent-smith', 'agent-smith@agent-smith-dev', 'agent-smith@inline'] as const;
const MIRROR_SUFFIXES = ['.spec.json', '.progress.json', '.result.md.status.json', '.result.md', '.log', '.events.jsonl', '.spec.json.cancel'] as const;

function removeEmptyDirIfPossible(dir: string): void {
  try {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
  } catch { /* non-empty or raced */ }
}

/** Remove Agent Smith entries from a Claude settings JSON file; delete the file if it becomes empty. */
function scrubClaudeSettingsFile(settingsFile: string): boolean {
  if (!existsSync(settingsFile)) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(settingsFile, 'utf8')); } catch { return false; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const settings = { ...(parsed as Record<string, unknown>) };
  let changed = false;

  for (const [sectionKey, targetKeys] of [
    ['extraKnownMarketplaces', MARKETPLACE_KEYS],
    ['enabledPlugins', PLUGIN_IDS],
    ['pluginConfigs', PLUGIN_IDS],
  ] as const) {
    const raw = settings[sectionKey];
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const copy = { ...(raw as Record<string, unknown>) };
      for (const k of targetKeys) {
        if (k in copy) { delete copy[k]; changed = true; }
      }
      if (Object.keys(copy).length === 0) delete settings[sectionKey];
      else settings[sectionKey] = copy;
    }
  }
  if (!changed) return false;
  if (Object.keys(settings).length === 0) {
    try { unlinkSync(settingsFile); } catch { /* ignore */ }
    removeEmptyDirIfPossible(path.dirname(settingsFile));
  } else {
    writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return true;
}

/** Remove only Agent Smith's own mirrored files from `<repo>/.agy-staff/jobs/`, leaving genuine agy-staff jobs untouched. */
function scrubMirrorDir(repo: string): number {
  const dir = mirrorDir(repo);
  if (!existsSync(dir)) return 0;
  let removedJobs = 0;
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return 0; }
  for (const name of entries) {
    if (!name.endsWith('.spec.json')) continue;
    const jobId = name.slice(0, -'.spec.json'.length);
    let ours = isForgeJobId(jobId);
    if (!ours) {
      try {
        const spec = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as Record<string, unknown>;
        ours = spec[MIRROR_MARKER] === true;
      } catch { /* unreadable spec: leave it alone */ }
    }
    if (!ours) continue;
    for (const suffix of MIRROR_SUFFIXES) {
      rmSync(path.join(dir, `${jobId}${suffix}`), { force: true });
    }
    removedJobs += 1;
  }
  removeEmptyDirIfPossible(dir);
  removeEmptyDirIfPossible(path.dirname(dir));
  return removedJobs;
}

/** Cancel any live pipelines or jobs in `repo` before removing state. */
function cancelLiveWorkInRepo(repo: string): void {
  const pipelinesDir = path.join(repo, '.agent-smith', 'pipelines');
  try {
    for (const name of readdirSync(pipelinesDir)) {
      if (!name.endsWith('.json')) continue;
      const runId = name.slice(0, -'.json'.length);
      try {
        const rec = readPipeline(repo, runId);
        if (rec?.status === 'running') cancelPipeline(repo, runId);
      } catch { /* ignore */ }
    }
  } catch { /* no pipelines dir */ }
  try {
    const service = new ForgeService({ repo });
    for (const entry of readdirSync(jobsDir(repo), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const job = readJobRecord(repo, entry.name);
      if (job?.['status'] === 'running') {
        try { service.cancel(entry.name); } catch { /* ignore */ }
      }
    }
  } catch { /* no jobs dir */ }
}

/** Remove Agent Smith entries and cached directories under `~/.claude/plugins`. */
function scrubClaudePluginsRoot(pluginsRoot: string): string[] {
  const removed: string[] = [];
  for (const rel of [
    path.join('cache', 'agent-smith'),
    path.join('cache', 'agent-smith-dev'),
    path.join('marketplaces', 'agent-smith'),
    path.join('marketplaces', 'agent-smith-dev'),
    path.join('data', 'agent-smith-agent-smith'),
    path.join('data', 'agent-smith-agent-smith-dev'),
    path.join('store', 'agent-smith'),
    path.join('store', 'agent-smith-agent-smith'),
  ]) {
    const target = path.join(pluginsRoot, rel);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      removed.push(target);
    }
  }
  const knownFile = path.join(pluginsRoot, 'known_marketplaces.json');
  if (existsSync(knownFile)) {
    try {
      const parsed = JSON.parse(readFileSync(knownFile, 'utf8')) as Record<string, unknown>;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        let changed = false;
        for (const key of MARKETPLACE_KEYS) {
          if (key in parsed) { delete parsed[key]; changed = true; }
        }
        if (changed) writeFileSync(knownFile, `${JSON.stringify(parsed, null, 2)}\n`);
      }
    } catch { /* leave unreadable file alone */ }
  }
  const installedFile = path.join(pluginsRoot, 'installed_plugins.json');
  if (existsSync(installedFile)) {
    try {
      const parsed = JSON.parse(readFileSync(installedFile, 'utf8')) as Record<string, unknown>;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        let changed = false;
        for (const key of PLUGIN_IDS) {
          if (key in parsed) { delete parsed[key]; changed = true; }
        }
        if (typeof parsed['plugins'] === 'object' && parsed['plugins'] !== null && !Array.isArray(parsed['plugins'])) {
          const pluginsMap = parsed['plugins'] as Record<string, unknown>;
          for (const key of PLUGIN_IDS) {
            if (key in pluginsMap) { delete pluginsMap[key]; changed = true; }
          }
        }
        if (changed) writeFileSync(installedFile, `${JSON.stringify(parsed, null, 2)}\n`);
      }
    } catch { /* leave unreadable file alone */ }
  }
  return removed;
}

/**
 * Leave-zero-trace uninstaller: removes plugin/mod/hooks/MCP registrations,
 * immediate-purges Claude Code's 14-day plugin cache/data/marketplace clones,
 * and cleans `.agent-smith/` + mirrored `.agy-staff/jobs/` entries.
 */
export async function cmdUninstall(args: UninstallArgs = {}): Promise<number> {
  const targetRepo = path.resolve(args.repo ?? process.cwd());
  const localOnly = args.local === true;
  const home = args.homeDir ?? os.homedir();
  const actions: string[] = [];

  cancelLiveWorkInRepo(targetRepo);

  if (!localOnly) {
    const claudeBin = process.env['AGENT_SMITH_CLAUDE_BIN'] || 'claude';
    for (const mkt of MARKETPLACE_KEYS) {
      spawnSync(claudeBin, ['plugin', ' uninstall', `agent-smith@${mkt}`].map((s) => s.trim()), { cwd: targetRepo, encoding: 'utf8', env: process.env });
      spawnSync(claudeBin, ['plugin', 'marketplace', 'remove', mkt], { cwd: targetRepo, encoding: 'utf8', env: process.env });
    }
  }

  for (const settingsFile of [
    path.join(targetRepo, '.claude', 'settings.local.json'),
    path.join(targetRepo, '.claude', 'settings.json'),
    ...(localOnly ? [] : [path.join(home, '.claude', 'settings.json')]),
  ]) {
    if (scrubClaudeSettingsFile(settingsFile)) actions.push(`cleaned ${settingsFile}`);
  }

  if (!localOnly) {
    const pluginsRoot = process.env['CLAUDE_CODE_PLUGIN_CACHE_DIR'] || path.join(home, '.claude', 'plugins');
    for (const dir of scrubClaudePluginsRoot(pluginsRoot)) actions.push(`removed ${dir}`);
  }

  if (args.keepJobs !== true) {
    const repoState = path.join(targetRepo, '.agent-smith');
    if (existsSync(repoState)) {
      rmSync(repoState, { recursive: true, force: true });
      actions.push(`removed ${repoState}`);
    }
    const mirrored = scrubMirrorDir(targetRepo);
    if (mirrored > 0) actions.push(`removed ${mirrored} mirrored job(s) from ${mirrorDir(targetRepo)}`);

    if (!localOnly) {
      const userState = process.env['AGENT_SMITH_STATE_DIR']
        ? path.resolve(process.env['AGENT_SMITH_STATE_DIR'])
        : path.join(home, '.agent-smith');
      if (existsSync(userState)) {
        rmSync(userState, { recursive: true, force: true });
        actions.push(`removed ${userState}`);
      }
    }
  }

  if (actions.length === 0) {
    process.stdout.write('Agent Smith: nothing to remove (already clean).\n');
  } else {
    for (const line of actions) process.stdout.write(`✓ ${line}\n`);
    process.stdout.write('Agent Smith uninstalled cleanly.\n');
  }
  return EXIT.ok;
}

export async function cmdDoctor(): Promise<number> {
  process.stdout.write('agent-smith doctor — adapter feature compatibility\n\n');
  const rows = await detectAvailable();
  const compatibility = await Promise.all(rows.map(row => row.available
    ? checkCompatibility(row.name, row.binary) : Promise.resolve(null)));
  const width = Math.max(0, ...rows.map((row) => row.name.length));
  let any = false;
  for (const [index, row] of rows.entries()) {
    const diagnostic = compatibility[index];
    if (diagnostic?.state === 'compatible') any = true;
    process.stdout.write(` ${diagnostic?.state === 'compatible' ? '●' : '○'} ${row.name.padEnd(width)}  ${diagnostic?.state ?? 'not installed'}  (${row.binary})\n`);
    if (diagnostic) process.stdout.write(`   ${diagnostic.version ?? 'version unknown'} — ${diagnostic.reason}\n`);
  }
  process.stdout.write(`\nstate\n  repo  ${process.cwd()}\n  jobs  ${path.join(process.cwd(), '.agent-smith', 'jobs')}\n`);
  return any ? EXIT.ok : EXIT.failed;
}

export const USAGE = `agent-smith — forge for coding agents\n\n  agent-smith setup [--scope user|project|local] [--local] [--repo path]\n  agent-smith uninstall [--local] [--repo path] [--keep-jobs]\n  agent-smith run implement --prompt "…" [--name worker] [--repo path] [--cwd path]\n                            [--provider agy] [--model …] [--effort low] [--check "npm test"]\n  agent-smith run ./pipeline.yaml [--foreground]\n  agent-smith resume <jobId|worker-name> --prompt "…" [--repo path] [--cwd path]\n  agent-smith ls [--status running]\n  agent-smith status <runId|jobId>\n  agent-smith cancel <runId|jobId>\n  agent-smith gc [--older-than 14d] [--delete] [--dry-run] [--repo path]\n  agent-smith doctor\n\nWorkers run on this machine. They are restricted by default; --unrestricted bypasses provider approval prompts.\n`;

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
      scope: { type: 'string' }, local: { type: 'boolean', default: false }, marketplace: { type: 'string' }, 'keep-jobs': { type: 'boolean', default: false },
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
      case 'setup': return await cmdSetup({ scope: values.scope, local: values.local, repo: values.repo, marketplace: values.marketplace });
      case 'uninstall': return await cmdUninstall({ local: values.local, repo: values.repo, keepJobs: values['keep-jobs'] });
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
