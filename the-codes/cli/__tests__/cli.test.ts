import { assertFakeProviderActive } from '../../forge/testing/shim.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

assertFakeProviderActive();

const { main, cmdStatus } = await import('../cli.ts');
const { cancelPipeline, readPipeline } = await import('../../forge/execute.ts');
const { ForgeService } = await import('../../forge/service.ts');
const { archivedJobsDir, jobDir } = await import('../../forge/format.ts');

const DAY_MS = 86_400_000;
const daysAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();

function writeJobFile(repo: string, jobId: string, contents: string): void {
  mkdirSync(jobDir(repo, jobId), { recursive: true });
  writeFileSync(path.join(jobDir(repo, jobId), 'job.json'), contents);
}

function writeJob(repo: string, jobId: string, job: Record<string, unknown>): void {
  writeJobFile(repo, jobId, JSON.stringify({ jobId, ...job }));
}

async function captureMain(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  let out = '';
  let err = '';
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { err += chunk; return true; }) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, out, err };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

test('CLI run uses the canonical forge, records a pipeline, and resumes a named worker', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-cli-'));
  const workerCwd = path.join(repo, 'worktree');
  mkdirSync(workerCwd);
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  let out = '';
  let err = '';
  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    if (typeof chunk === 'string') { out += chunk; return true; }
    return (stdout as (...values: unknown[]) => boolean).call(process.stdout, chunk, ...args);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    if (typeof chunk === 'string') { err += chunk; return true; }
    return (stderr as (...values: unknown[]) => boolean).call(process.stderr, chunk, ...args);
  }) as typeof process.stderr.write;
  try {
    const code = await main(['run', 'implement', '--prompt', 'Make a small change', '--name', 'Ada', '--repo', repo, '--cwd', workerCwd, '--effort', 'high', '--foreground']);
    assert.equal(code, 0, err);
    const runId = out.split('\n')[0] ?? '';
    assert.match(runId, /^implement-/);
    assert.equal(readPipeline(repo, runId)?.status, 'passed');
    const service = new ForgeService({ repo });
    const jobs = await service.list({ limit: 10 });
    assert.equal(jobs.length, 1);
    const first = await service.detail(jobs[0]!.jobId) as unknown as { name: string; workerId: string; conversation: string | null; cwd: string; effort: string | null };
    assert.equal(first.name, 'Ada');
    assert.ok(first.workerId);
    assert.ok(first.conversation);
    assert.equal(first.cwd, workerCwd);
    assert.equal(first.effort, 'high');

    out = '';
    err = '';
    const resumed = await main(['resume', 'Ada', '--prompt', 'Continue the same task', '--repo', repo, '--foreground']);
    assert.equal(resumed, 0, err);
    assert.match(out, /pipeline passed/);
    const allJobs = await service.list({ limit: 10 });
    assert.equal(allJobs.length, 2);
    const second = await service.detail(allJobs[0]!.jobId) as unknown as { name: string; workerId: string; conversation: string | null; cwd: string };
    assert.equal(second.name, 'Ada');
    assert.equal(second.workerId, first.workerId);
    assert.equal(second.conversation, first.conversation, 'the follow-up must continue the original provider conversation');
    assert.equal(second.cwd, workerCwd, 'the follow-up must preserve worker cwd while staying under the same repo state root');

    out = '';
    const statusCode = await cmdStatus(readPipeline(repo, runId)!.runId, repo);
    assert.equal(statusCode, 0);
    assert.match(out, /implement/);
    assert.match(out, /acceptance=unchecked/, 'execution success without checks must not imply verified acceptance');

    out = '';
    const workerStatusCode = await cmdStatus(jobs[0]!.jobId, repo);
    assert.equal(workerStatusCode, 0);
    assert.match(out, /name\s+Ada/);
    assert.match(out, /role\s+implement/);
    assert.match(out, /task\s+Make a small change/);
    assert.match(out, /summary\s+\[worker\]/);
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
});

test('background CLI returns a statusable run id, exposes the canonical job, and cancels it', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-cli-background-'));
  const oldScenario = process.env['FAKE_AGY_SCENARIO'];
  const oldDelay = process.env['FAKE_AGY_SLEEP_MS'];
  process.env['FAKE_AGY_SCENARIO'] = 'slow';
  process.env['FAKE_AGY_SLEEP_MS'] = '8000';
  try {
    const cliPath = new URL('../cli.ts', import.meta.url).pathname;
    const stdout = execFileSync(process.execPath, ['--experimental-strip-types', cliPath, 'run', 'implement', '--prompt', 'slow fake task', '--repo', repo], {
      encoding: 'utf8',
      env: process.env,
      timeout: 10_000,
    });
    const runId = stdout.split('\n')[0] ?? '';
    assert.match(runId, /^implement-/);
    assert.equal(readPipeline(repo, runId)?.status, 'running');

    const service = new ForgeService({ repo });
    let jobs = await service.list({ limit: 10 });
    const jobsDeadline = Date.now() + 8_000;
    while (jobs.length === 0 && Date.now() < jobsDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      jobs = await service.list({ limit: 10 });
    }
    assert.equal(jobs.length, 1, 'the worker must be visible in canonical .agent-smith state');
    assert.equal(jobs[0]?.status, 'running');

    const canceled = cancelPipeline(repo, runId);
    assert.equal(canceled.requested, true);
    const settleDeadline = Date.now() + 8_000;
    while (readPipeline(repo, runId)?.status === 'running' && Date.now() < settleDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.notEqual(readPipeline(repo, runId)?.status, 'running', 'the detached supervisor must settle the run after cancellation');
    const detail = await service.detail(jobs[0]!.jobId);
    assert.equal(detail.status, 'canceled');
  } finally {
    if (oldScenario === undefined) delete process.env['FAKE_AGY_SCENARIO'];
    else process.env['FAKE_AGY_SCENARIO'] = oldScenario;
    if (oldDelay === undefined) delete process.env['FAKE_AGY_SLEEP_MS'];
    else process.env['FAKE_AGY_SLEEP_MS'] = oldDelay;
  }
});

test('gc archives settled jobs older than the threshold and keeps recent ones', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-gc-'));
  writeJob(repo, 'old-job', { status: 'succeeded', createdAt: daysAgo(40), startedAt: daysAgo(40), finishedAt: daysAgo(30) });
  writeJob(repo, 'fallback-job', { status: 'failed', createdAt: daysAgo(40), startedAt: daysAgo(35), finishedAt: null });
  writeJob(repo, 'recent-job', { status: 'canceled', createdAt: daysAgo(2), startedAt: daysAgo(2), finishedAt: daysAgo(1) });

  const { code, out, err } = await captureMain(['gc', '--repo', repo]);
  assert.equal(code, 0, err);
  assert.match(out, /archived old-job/);
  assert.match(out, /archived fallback-job/, 'without finishedAt the settle time falls back to startedAt');
  assert.match(out, /gc: 2 archived, 1 kept, 0 skipped/);
  assert.equal(existsSync(jobDir(repo, 'old-job')), false);
  assert.equal(existsSync(jobDir(repo, 'recent-job')), true);
  const archived = path.join(archivedJobsDir(repo), 'old-job', 'job.json');
  assert.equal(JSON.parse(readFileSync(archived, 'utf8')).status, 'succeeded', 'archiving moves job.json intact');
});

test('gc sweeps claim markers older than the threshold and keeps fresh ones', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-gc-claims-'));
  const claims = path.join(repo, '.agent-smith', 'claims');
  mkdirSync(claims, { recursive: true });
  writeFileSync(path.join(claims, 'job-old'), 'x'); writeFileSync(path.join(claims, 'job-new'), 'x');
  const old = new Date(Date.now() - 30 * 86_400_000);
  utimesSync(path.join(claims, 'job-old'), old, old);
  const dry = await captureMain(['gc', '--repo', repo, '--dry-run']);
  assert.equal(existsSync(path.join(claims, 'job-old')), true, 'dry run removes nothing');
  assert.doesNotMatch(dry.out, /claim marker/);
  const { out } = await captureMain(['gc', '--repo', repo]);
  assert.match(out, /removed 1 completion-notice claim marker/);
  assert.equal(existsSync(path.join(claims, 'job-old')), false);
  assert.equal(existsSync(path.join(claims, 'job-new')), true);
});

test('gc never touches running jobs, whatever their age', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-gc-running-'));
  writeJob(repo, 'stuck-job', { status: 'running', createdAt: daysAgo(400), startedAt: daysAgo(400), finishedAt: null });

  const { code, out } = await captureMain(['gc', '--repo', repo, '--older-than', '1h', '--delete']);
  assert.equal(code, 0);
  assert.match(out, /gc: 0 deleted, 1 kept, 0 skipped/);
  assert.equal(existsSync(jobDir(repo, 'stuck-job')), true);
});

test('gc --dry-run reports what it would do and changes nothing', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-gc-dry-'));
  writeJob(repo, 'old-job', { status: 'failed', createdAt: daysAgo(40), startedAt: daysAgo(40), finishedAt: daysAgo(30) });

  const archive = await captureMain(['gc', '--repo', repo, '--dry-run']);
  assert.equal(archive.code, 0, archive.err);
  assert.match(archive.out, /would archive old-job/);
  assert.match(archive.out, /gc: 1 would be archived, 0 kept, 0 skipped/);

  const deletion = await captureMain(['gc', '--repo', repo, '--dry-run', '--delete']);
  assert.equal(deletion.code, 0, deletion.err);
  assert.match(deletion.out, /would delete old-job/);

  assert.equal(existsSync(jobDir(repo, 'old-job')), true);
  assert.equal(existsSync(archivedJobsDir(repo)), false);
});

test('gc --delete removes settled jobs instead of archiving them', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-gc-delete-'));
  writeJob(repo, 'old-job', { status: 'succeeded', createdAt: daysAgo(40), startedAt: daysAgo(40), finishedAt: daysAgo(30) });

  const { code, out, err } = await captureMain(['gc', '--repo', repo, '--delete']);
  assert.equal(code, 0, err);
  assert.match(out, /deleted old-job/);
  assert.equal(existsSync(jobDir(repo, 'old-job')), false);
  assert.equal(existsSync(archivedJobsDir(repo)), false);
});

test('gc skips job directories whose job.json is broken or missing', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-gc-broken-'));
  writeJobFile(repo, 'broken-job', '{not json');
  mkdirSync(jobDir(repo, 'empty-job'), { recursive: true });
  writeJob(repo, 'old-job', { status: 'succeeded', createdAt: daysAgo(40), startedAt: daysAgo(40), finishedAt: daysAgo(30) });

  const { code, out, err } = await captureMain(['gc', '--repo', repo]);
  assert.equal(code, 0, err);
  assert.match(err, /skipped broken-job/);
  assert.match(err, /skipped empty-job/);
  assert.match(out, /gc: 1 archived, 0 kept, 2 skipped/);
  assert.equal(existsSync(jobDir(repo, 'broken-job')), true, 'an unreadable job must never be deleted or moved');
  assert.equal(existsSync(jobDir(repo, 'empty-job')), true);
});

test('gc rejects an --older-than value that is not an age', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-gc-usage-'));
  const { code, err } = await captureMain(['gc', '--repo', repo, '--older-than', '2 weeks']);
  assert.equal(code, 1);
  assert.match(err, /--older-than: '2 weeks' is not an age/);
});
