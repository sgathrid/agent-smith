import { assertFakeProviderActive } from '../../forge/testing/shim.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

assertFakeProviderActive();

const { main, cmdStatus } = await import('../cli.ts');
const { cmdUninstall } = await import('../install.ts');
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

/**
 * Capture the CLI's text output. Only strings are captured: under `node --test`
 * the runner reports results to its parent as binary chunks on this same
 * stdout, and swallowing those silently drops tests from the run.
 */
async function capture(run: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  let out = '';
  let err = '';
  const tap = (stream: NodeJS.WriteStream, original: typeof process.stdout.write, sink: (text: string) => void) =>
    ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === 'string') { sink(chunk); return true; }
      return (original as (...args: unknown[]) => boolean).call(stream, chunk, ...rest);
    }) as typeof process.stdout.write;
  process.stdout.write = tap(process.stdout, stdout, (text) => { out += text; });
  process.stderr.write = tap(process.stderr, stderr, (text) => { err += text; });
  try {
    return { code: await run(), out, err };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

const captureMain = (argv: string[]) => capture(() => main(argv));

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

/** Setup ends with doctor, which needs one compatible worker CLI; CI runners have none. */
function fakeWorkerOnPath(): () => void {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-smith-fake-worker-'));
  const bin = path.join(dir, 'opencode');
  writeFileSync(bin, `#!${process.execPath}\nconsole.log(process.argv[2] === '--version' ? 'opencode 1.0.0' : '--standalone --format --model --auto --session');\n`);
  chmodSync(bin, 0o755);
  const previous = process.env['PATH'];
  process.env['PATH'] = `${dir}${path.delimiter}${previous ?? ''}`;
  return () => { process.env['PATH'] = previous; };
}

test('setup --repo writes local Claude settings, migrates agent-smith-dev, and runs doctor', async () => {
  const restorePath = fakeWorkerOnPath();
  try {
    const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-setup-local-'));
    const claudeDir = path.join(repo, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(path.join(claudeDir, 'settings.local.json'), JSON.stringify({
      extraKnownMarketplaces: { 'agent-smith-dev': { source: { source: 'directory', path: '/old' } } },
      enabledPlugins: { 'agent-smith@agent-smith-dev': true, 'other@mkt': true },
    }));

    const { code, out, err } = await captureMain(['setup', '--repo', repo]);
    assert.equal(code, 0, err);
    assert.match(out, /Agent Smith enabled in /);
    assert.match(out, /agent-smith doctor/);
    const settings = JSON.parse(readFileSync(path.join(claudeDir, 'settings.local.json'), 'utf8'));
    assert.equal('agent-smith-dev' in settings.extraKnownMarketplaces, false);
    assert.equal(settings.extraKnownMarketplaces['agent-smith'].source.source, 'directory');
    assert.equal('agent-smith@agent-smith-dev' in settings.enabledPlugins, false);
    assert.equal(settings.enabledPlugins['agent-smith@agent-smith'], true);
    assert.equal(settings.enabledPlugins['other@mkt'], true);
  } finally {
    restorePath();
  }
});

test('setup installs via claude plugin install at user scope by default and rejects bad scopes', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'agent-smith-setup-user-'));
  const fakeClaude = path.join(scratch, 'fake-claude');
  const argsFile = path.join(scratch, 'args.json');
  writeFileSync(fakeClaude, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\nconsole.log('Successfully installed plugin: agent-smith@agent-smith (scope: user)');\n`);
  chmodSync(fakeClaude, 0o755);
  const prevClaude = process.env['AGENT_SMITH_CLAUDE_BIN'];
  process.env['AGENT_SMITH_CLAUDE_BIN'] = fakeClaude;
  const restorePath = fakeWorkerOnPath();
  try {
    const { code, out, err } = await captureMain(['setup', '--marketplace', 'sgathrid/agent-smith']);
    assert.equal(code, 0, err);
    assert.match(out, /Successfully installed plugin: agent-smith@agent-smith/);
    assert.match(out, /agent-smith doctor/);
    const recorded = JSON.parse(readFileSync(argsFile, 'utf8'));
    assert.deepEqual(recorded, ['plugin', 'install', 'agent-smith', '--marketplace', 'sgathrid/agent-smith', '--scope', 'user']);

    // A clone has a committed build, but the default must stay the published
    // marketplace: a project install would otherwise commit this absolute path.
    const project = await captureMain(['setup', '--scope', 'project']);
    assert.equal(project.code, 0, project.err);
    assert.deepEqual(JSON.parse(readFileSync(argsFile, 'utf8')), ['plugin', 'install', 'agent-smith', '--marketplace', 'sgathrid/agent-smith', '--scope', 'project']);

    const bad = await captureMain(['setup', '--scope', 'bogus']);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /--scope must be user, project, or local/);
  } finally {
    restorePath();
    if (prevClaude === undefined) delete process.env['AGENT_SMITH_CLAUDE_BIN'];
    else process.env['AGENT_SMITH_CLAUDE_BIN'] = prevClaude;
  }
});

test('uninstall leaves zero trace of Agent Smith while preserving unrelated settings and genuine agy-staff jobs', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-uninstall-'));
  const claudeDir = path.join(repo, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(path.join(claudeDir, 'settings.local.json'), JSON.stringify({
    extraKnownMarketplaces: { 'agent-smith': { source: { source: 'directory', path: '/x' } } },
    enabledPlugins: { 'agent-smith@agent-smith': true, 'agent-smith@agent-smith-dev': true },
  }));

  writeJob(repo, 'implement-smith-12345678', { status: 'succeeded', createdAt: daysAgo(1) });
  const mirror = path.join(repo, '.agy-smith-tmp');
  rmSync(mirror, { recursive: true, force: true });
  const agyJobs = path.join(repo, '.agy-staff', 'jobs');
  mkdirSync(agyJobs, { recursive: true });
  writeFileSync(path.join(agyJobs, 'implement-smith-12345678.spec.json'), JSON.stringify({ 'agent-smith': true, job_id: 'implement-smith-12345678' }));
  writeFileSync(path.join(agyJobs, 'implement-smith-12345678.result.md'), 'mirrored');
  writeFileSync(path.join(agyJobs, 'implement-real-aaaa1111.spec.json'), JSON.stringify({ job_id: 'implement-real-aaaa1111' }));

  const { code, out, err } = await captureMain(['uninstall', '--local', '--repo', repo]);
  assert.equal(code, 0, err);
  assert.match(out, /Agent Smith removed/);
  assert.equal(existsSync(path.join(claudeDir, 'settings.local.json')), false, 'empty settings.local.json should be removed');
  assert.equal(existsSync(claudeDir), false, 'empty .claude dir should be removed');
  assert.equal(existsSync(path.join(repo, '.agent-smith')), false, '.agent-smith state should be removed');
  assert.equal(existsSync(path.join(agyJobs, 'implement-smith-12345678.spec.json')), false, 'mirrored spec should be removed');
  assert.equal(existsSync(path.join(agyJobs, 'implement-smith-12345678.result.md')), false, 'mirrored result should be removed');
  assert.equal(existsSync(path.join(agyJobs, 'implement-real-aaaa1111.spec.json')), true, 'genuine agy-staff job must be untouched');

  rmSync(path.join(agyJobs, 'implement-real-aaaa1111.spec.json'));
  writeFileSync(path.join(agyJobs, 'implement-smith-99999999.spec.json'), JSON.stringify({ 'agent-smith': true }));
  await captureMain(['uninstall', '--local', '--repo', repo]);
  assert.equal(existsSync(path.join(repo, '.agy-staff')), false, '.agy-staff should be removed when only Agent Smith mirror files were inside');
});

const captureUninstall = (args: Parameters<typeof cmdUninstall>[0]) => capture(() => cmdUninstall(args));

test('uninstall removes nothing while a cancelled worker is still owned by a live process', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-uninstall-live-'));
  mkdirSync(path.join(repo, '.claude'), { recursive: true });
  const settingsFile = path.join(repo, '.claude', 'settings.local.json');
  writeFileSync(settingsFile, JSON.stringify({ enabledPlugins: { 'agent-smith@agent-smith': true } }));
  writeJob(repo, 'implement-smith-live0001', { status: 'running', ownerPid: process.pid, createdAt: daysAgo(0) });

  const { code, out, err } = await captureUninstall({ local: true, repo, settleMs: 300 });
  assert.equal(code, 2);
  assert.match(err, /still running after cancel: implement-smith-live0001/);
  assert.doesNotMatch(out, /Agent Smith removed/);
  assert.equal(existsSync(jobDir(repo, 'implement-smith-live0001')), true, 'job state, with its cancel marker, is kept for the owner');
  assert.equal(existsSync(settingsFile), true, 'settings are untouched');
});

test('uninstall proceeds past a running job whose owner process is gone', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-uninstall-orphan-'));
  writeJob(repo, 'implement-smith-orphan01', { status: 'running', ownerPid: 2 ** 22 + 12345, createdAt: daysAgo(0) });
  const { code, err } = await captureUninstall({ local: true, repo, settleMs: 300 });
  assert.equal(code, 0, err);
  assert.equal(existsSync(path.join(repo, '.agent-smith')), false);
});

test('uninstall removes only provider folders inside AGENT_SMITH_STATE_DIR and honours the home override', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'agent-smith-uninstall-state-'));
  const repo = path.join(scratch, 'repo');
  const home = path.join(scratch, 'home');
  const shared = path.join(scratch, 'shared');
  mkdirSync(repo, { recursive: true });
  mkdirSync(path.join(home, '.agent-smith'), { recursive: true });
  writeFileSync(path.join(home, '.agent-smith', 'models.json'), '{}');
  mkdirSync(path.join(shared, 'codex', 'job-1'), { recursive: true });
  writeFileSync(path.join(shared, 'unrelated.txt'), 'keep me');

  const saved = { bin: process.env['AGENT_SMITH_CLAUDE_BIN'], state: process.env['AGENT_SMITH_STATE_DIR'], cache: process.env['CLAUDE_CODE_PLUGIN_CACHE_DIR'] };
  process.env['AGENT_SMITH_CLAUDE_BIN'] = 'true';
  process.env['AGENT_SMITH_STATE_DIR'] = shared;
  process.env['CLAUDE_CODE_PLUGIN_CACHE_DIR'] = path.join(scratch, 'plugins');
  try {
    const { code, err } = await captureUninstall({ repo, homeDir: home, settleMs: 0 });
    assert.equal(code, 0, err);
  } finally {
    for (const [key, value] of [['AGENT_SMITH_CLAUDE_BIN', saved.bin], ['AGENT_SMITH_STATE_DIR', saved.state], ['CLAUDE_CODE_PLUGIN_CACHE_DIR', saved.cache]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(existsSync(path.join(home, '.agent-smith')), false, 'the Agent Smith home is removed');
  assert.equal(existsSync(path.join(shared, 'codex')), false, 'provider state is removed');
  assert.equal(readFileSync(path.join(shared, 'unrelated.txt'), 'utf8'), 'keep me', 'unrelated files in the state dir survive');
});
