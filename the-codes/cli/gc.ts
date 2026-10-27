/** `agent-smith gc`: archive or delete settled jobs older than a threshold. */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { archivedJobsDir, isTerminalForgeStatus, jobsDir, readManifest } from '../forge/format.ts';
import { EXIT, UsageError } from './common.ts';

export interface GcArgs {
  readonly olderThan?: string;
  readonly delete?: boolean;
  readonly dryRun?: boolean;
  readonly repo?: string;
}

const GC_DEFAULT_AGE = '14d';
const GC_UNIT_HOURS: Readonly<Record<'h' | 'd' | 'w', number>> = { h: 1, d: 24, w: 168 };

/** Parses gc ages such as 12h, 14d or 2w. */
function parseGcAge(raw: string): number {
  const match = /^(\d+)([hdw])$/.exec(raw.trim());
  if (match === null) throw new UsageError(`--older-than: '${raw}' is not an age. Use e.g. 12h, 14d or 2w.`);
  return Number(match[1]) * GC_UNIT_HOURS[match[2] as 'h' | 'd' | 'w'] * 3_600_000;
}

export function readJobRecord(repo: string, jobId: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = readManifest(repo, jobId);
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
    if (!isTerminalForgeStatus(job['status'])) {
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
