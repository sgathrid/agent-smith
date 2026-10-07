import { assertFakeProviderActive } from '../../forge/testing/shim.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

assertFakeProviderActive();

const { main, cmdStatus } = await import('../cli.ts');
const { cancelPipeline, readPipeline } = await import('../../forge/execute.ts');
const { ForgeService } = await import('../../forge/service.ts');

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
