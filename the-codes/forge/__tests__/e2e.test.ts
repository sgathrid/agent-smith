/**
 * e2e.test.ts — a REAL job, end to end, through the real spawn path.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS PROVES, AND WHY IT IS NOT A UNIT TEST
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The acceptance criterion for the whole change is:
 *
 *     a job spawned through our MCP tool appears in the mod's pane,
 *     with no change to the rendering code.
 *
 * Nothing short of running the real thing tests that. So this suite:
 *
 *   1. spawns a real child process — a local script that emits agy-shaped
 *      `stream-json` (testing/fake-agy.mjs), driven through the UNMODIFIED
 *      providers/agy.ts adapter, so the real argv builder and the real
 *      `stream-json` parser are both exercised;
 *   2. waits for a real JobResult;
 *   3. reads the resulting state back through harness/agent-smith.ts;
 *   4. and then calls the mod's OWN `resolve()` — imported, not modified — with a
 *      node:fs-backed `$.fs` shim, and asserts on the `RadarJob` it produces.
 *
 * Step 4 is the load-bearing one. It is the literal statement of "no change to
 * the rendering code": the code that decides what the pane draws is called here
 * exactly as Claude Code calls it, and the only thing under test is what we wrote.
 *
 * WHY A FAKE PROVIDER AND NOT REAL agy: agy is OAuth-bound. A real run would
 * spend the user's quota on a test, and this suite has to run in CI. The fixture
 * emits precisely the dialect providers/agy.ts documents as verified against the
 * real binary, so the adapter is still pinned to that contract — if the parser
 * drifts, these tests fail.
 */

import assert from 'node:assert/strict';
// MUST BE FIRST: it points the agy adapter at the local fixture before
// providers/agy.ts can capture the real binary. See ../testing/shim.ts.
import { assertFakeProviderActive } from '../testing/shim.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));


function repo(): string {
  return mkdtempSync(path.join(tmpdir(), 'agent-smith-e2e-'));
}

/**
 * The fixture binary is installed by a module whose EVALUATION ORDER MATTERS — see
 * the import at the top of this file and ../testing/shim.ts.
 *
 * The assertion here is the second half of that guard: it fails loudly if the real
 * binary was captured, instead of letting every "denial is a failure" assertion
 * pass for the wrong reason after quietly spending the user's model quota.
 */
assertFakeProviderActive();

/**
 * A `$.fs` shim over node:fs — exactly the three calls the mod's reader makes.
 *
 * This is the whole trick behind "no change to the rendering code": the mod
 * cannot import node:fs (its loader forbids it) and so takes an `FsLike` as an
 * argument. We supply the same shape the host supplies, and the mod's own code
 * runs unmodified against it.
 */
async function nodeFs(): Promise<{
  read(p: string): Promise<string>;
  list(p: string): Promise<readonly { name: string; kind: string; size: number }[]>;
  exists(p: string): Promise<boolean>;
}> {
  const { readFile, readdir, stat } = await import('node:fs/promises');
  return {
    async read(p: string): Promise<string> {
      return readFile(p, 'utf8');
    },
    async list(p: string) {
      const entries = await readdir(p, { withFileTypes: true });
      const out: { name: string; kind: string; size: number }[] = [];
      for (const e of entries) {
        out.push({ name: e.name, kind: e.isDirectory() ? 'directory' : 'file', size: 0 });
      }
      return out;
    },
    async exists(p: string): Promise<boolean> {
      try {
        await stat(p);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/* ── the fixture wrapper ───────────────────────────────────────────────────── */

/**
 * The fixture needs an interpreter and a script path, and providers/agy.ts spawns
 * `AGENT_SMITH_AGY_BIN` with `argv` it built itself. So `AGENT_SMITH_AGY_BIN`
 * points at `node` and the script path arrives as the first positional... which
 * agy's own buildArgv never emits.
 *
 * The honest fix is a one-line shell shim, so the adapter sees exactly the argv
 * it would see against real agy:
 *
 *   exec /usr/bin/node <fixture> "$@"
 *
 * Everything downstream — buildArgv, the stream-json pump, the denial logic, the
 * exit handling — runs unmodified.
 */
/** Wait until `predicate` holds, or fail loudly. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

/* ── the acceptance test ───────────────────────────────────────────────────── */

test('ACCEPTANCE: a job spawned through the tool appears in the mod pane, unmodified', async () => {
  const r = repo();

  const { ForgeService } = await import('../service.ts');
  const { readAllObservedJobs } = await import('./observe.ts');
  const mod = await import('../../surfaces/mod/hooks/jobs.ts');

  const service = new ForgeService({ repo: r });

  /* 1. SPAWN. Through the same code path the MCP tool calls. */
  const ack = await service.spawnJob({
    mode: 'implement',
    prompt: '# Dashboard rework\n\nRebuild the pane and prove it renders.',
    provider: 'agy',
    timeoutMs: 30_000,
    // FALSE, as it is in production. The fixture needs no tools, so the run
    // succeeds either way — which is the point: the default has to be safe.
    unrestricted: false,
  });
  assert.match(ack.jobId, /^implement-smith-[0-9a-f]{8}$/);
  assert.equal(ack.unrestricted, false);
  assert.match(ack.note, /^queued · 30s limit · approvals on$/);

  // The ANCHOR exists before the caller has finished reading this response. That
  // is what makes a spawn failure a `failed` job rather than a vanished one.
  assert.ok(existsSync(path.join(ack.dir, 'job.json')), 'job.json exists the moment spawn_job returns');

  /* 2. WAIT for the real child process. */
  // `spawnJob` is fire-and-forget by design; wait for the terminal state the same
  // way the DAG runner does, via the observable filesystem.
  const manifest = await waitForTerminal(r, ack.jobId, 20_000);

  assert.equal(manifest.status, 'succeeded', `expected success, got: ${manifest.error ?? 'no error'}`);
  assert.equal(manifest.provider, 'agy');
  assert.ok(manifest.conversation, 'the provider\'s conversation id was captured for resume');
  assert.ok(manifest.toolCalls >= 2, `tool count from the real stream: ${manifest.toolCalls}`);

  // The provider layer wrote its own four files into OUR job directory, because we
  // handed it `stateDir` rather than copying them across.
  for (const f of ['events.jsonl', 'argv.json', 'stderr.log', 'result.json']) {
    assert.ok(existsSync(path.join(ack.dir, f)), `${f} is in our job dir, written by providers/ndjson.ts`);
  }

  /* 3. READ IT BACK through our own reader, via the registry sweep. */
  const observed = await readAllObservedJobs(r);
  assert.equal(observed.length, 1, 'exactly ONE job — the mirror must not double-count it');
  assert.equal(observed[0]?.provider, 'agent-smith');
  assert.equal(observed[0]?.status, 'succeeded');
  assert.match(observed[0]?.output ?? '', /Fixture report/);

  /* 4. THE MOD'S OWN READER, UNMODIFIED. This is the acceptance criterion. */
  const fs = await nodeFs();
  const ids = await mod.discover(fs, mod.jobsDir(r));
  assert.deepEqual(ids, [ack.jobId], "the pane discovers our job in the directory it already reads");

  const now = Date.now();
  const radar = await mod.resolve(fs, mod.jobsDir(r), ack.jobId, now, true);
  assert.ok(radar, 'the pane resolved our job');
  assert.equal(radar?.id, ack.jobId);
  assert.equal(radar?.status, 'succeeded');
  assert.equal(radar?.task, 'Dashboard rework', 'the pane shows our task');
  // toolCount is the pane's documented PROXY — the highest step_index that
  // carried a tool — not a tool tally. Measured over the real corpus the first
  // tool always sits at step_index 2, so a 2-tool job reads as 3 here exactly as
  // it would for agy-staff. The EXACT quantity is the DONE-entry count below.
  assert.equal(radar?.toolCount, 3, "the pane's step-ordinal proxy, computed by the pane's own reader");
  assert.equal(radar?.endedAt !== null, true, 'the pane has an end time');

  // The band draws "what it is doing" from recent_activities. Ours is populated.
  assert.ok((radar?.activity ?? '').length > 0, `activity phrase: ${radar?.activity}`);

  // The detail view renders result.md, which the pane reads through
  // reportBody(). Non-empty means it will draw the report.
  assert.match(radar?.report ?? '', /Fixture report/);

  // And the tool history, which comes from the mirrored events.jsonl.
  const history = mod.toolHistoryFromEvents(
    readFileSync(path.join(r, '.agy-staff', 'jobs', `${ack.jobId}.events.jsonl`), 'utf8'),
  );
  assert.equal(history.length, 2, 'the pane renders two DONE tool entries, not four');
  assert.deepEqual(
    history.map((h) => h.tool).sort(),
    ['read_file', 'run_command'],
  );

  // The band's own ordering function accepts our jobs.
  const sorted = mod.sortForBand([radar!]);
  assert.equal(sorted.length, 1);
});

/* ── the safety rule, through the same real path ───────────────────────────── */

test('SAFETY: a soft-denied tool is recorded FAILED, never a clean success', async () => {
  const r = repo();
  const { ForgeService } = await import('../service.ts');
  const service = new ForgeService({ repo: r });

  const ack = await service.spawnJob({
    mode: 'implement',
    // The fixture keys on this word, so the test chooses its own outcome with the
    // prompt it already had.
    // The word "deny" is how the test asks the fixture for the soft-denial shape.
    prompt: 'Run the shell command: echo hi — deny nothing that matters',
    provider: 'agy',
    timeoutMs: 30_000,
  });

  const manifest = await waitForTerminal(r, ack.jobId, 20_000);

  // This is THE assertion. agy exits 0. `result.status` is the string "SUCCESS".
  // `response` is "". The worker did nothing. Recording it as `succeeded` is the
  // quiet failure this project exists to eliminate.
  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.jobStatus, 'denied');
  assert.ok((manifest.deniedActions ?? []).length > 0, 'the denials survived into the state file');
  assert.match(manifest.reason ?? '', /^denied /);
  // …and the adapter's specific evidence rides underneath it.
  assert.match(manifest.error ?? '', /^denied /);

  // And the pane draws it as failed, from the mirrored anchor — not as a green
  // check. The mirror only ever writes `done` for a real success, so the pane's
  // own headline rule is a second line of defence rather than the only one.
  const mod = await import('../../surfaces/mod/hooks/jobs.ts');
  const fs = await nodeFs();
  const radar = await mod.resolve(fs, mod.jobsDir(r), ack.jobId, Date.now(), true);
  assert.equal(radar?.status, 'failed');
  assert.ok(
    (radar?.warnings ?? []).some((w) => w.code === 'suspicious_success'),
    `expected a suspicious_success warning, got ${JSON.stringify(radar?.warnings)}`,
  );

});

test('a provider that reports no denials and returns nothing is ALSO failed', async () => {
  // The paranoid net, for a provider with no `denied_actions` to report. Emptiness
  // is the only evidence left, so emptiness has to be enough.
  const r = repo();
  const { ForgeService } = await import('../service.ts');
  const service = new ForgeService({ repo: r });
  const ack = await service.spawnJob({ mode: 'review', prompt: 'say nothing and stay silent', provider: 'agy' });
  const manifest = await waitForTerminal(r, ack.jobId, 20_000);

  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.reason, 'no output');
});

test('a worker that dies without a result event is not a success', async () => {
  const r = repo();
  const { ForgeService } = await import('../service.ts');
  const service = new ForgeService({ repo: r });
  const ack = await service.spawnJob({ mode: 'implement', prompt: 'crash it', provider: 'agy' });
  const manifest = await waitForTerminal(r, ack.jobId, 20_000);

  assert.equal(manifest.status, 'failed');
  // The adapter distinguishes two ways of ending without a result event:
  //   'malformed' — the process exited 0 and we never saw the event
  //   'error'     — the process exited non-zero
  // Our fixture exits 3, so this is the second, and the distinction is the
  // adapter's: it is the difference between "the CLI changed its output format"
  // and "the CLI died".
  assert.equal(manifest.jobStatus, 'error');
  assert.match(manifest.error ?? '', /no result/);
});

test('CANCEL: the marker is written first and the pane sees it as canceled', async () => {
  const r = repo();
  const { ForgeService } = await import('../service.ts');
  const service = new ForgeService({ repo: r });
  const ack = await service.spawnJob({
    mode: 'implement',
    prompt: 'take your time, slow down',
    provider: 'agy',
    timeoutMs: 30_000,
  });

  // Let the job actually start, so this is a cancellation mid-flight rather than a
  // cancellation of something that never ran.
  await waitFor(() => existsSync(path.join(ack.dir, 'progress.json')), 5_000);

  const result = service.cancel(ack.jobId);
  assert.equal(result.requested, true);
  assert.equal(result.signalled, true, 'this process holds the handle, so it can actually signal');

  // The marker exists IMMEDIATELY, before the worker has been reaped. That is the
  // whole point of the marker: a cancellation caught mid-flight is still a
  // cancellation, and the worker may never get to write its own terminal state.
  assert.ok(existsSync(path.join(ack.dir, 'cancel')));

  const manifest = await waitForTerminal(r, ack.jobId, 15_000);
  assert.equal(manifest.status, 'canceled');

  const mod = await import('../../surfaces/mod/hooks/jobs.ts');
  const radar = await mod.resolve(await nodeFs(), mod.jobsDir(r), ack.jobId, Date.now(), true);
  assert.equal(radar?.status, 'canceled');

});

test('CANCEL: a second ForgeService marker is observed by the running owner', async () => {
  const r = repo();
  const { ForgeService } = await import('../service.ts');
  const owner = new ForgeService({ repo: r });
  const requester = new ForgeService({ repo: r });
  const ack = await owner.spawnJob({ mode: 'implement', name: 'long-worker', workerId: 'stable-worker', prompt: 'slow cross-service cancellation', provider: 'agy', timeoutMs: 30_000 });
  await waitFor(() => existsSync(path.join(ack.dir, 'progress.json')), 5_000);
  await assert.rejects(
    owner.spawnJob({ mode: 'review', name: 'follow-up', workerId: 'stable-worker', prompt: 'overlapping follow-up', provider: 'agy' }),
    /is busy/,
  );

  const request = requester.cancel(ack.jobId);
  assert.equal(request.requested, true);
  assert.equal(request.signalled, false, 'only the service holding the worker handle can signal it');
  const manifest = await waitForTerminal(r, ack.jobId, 15_000);
  assert.equal(manifest.status, 'canceled', 'the owner observed the marker and confirmed process cancellation');
});

test('a cancel for a job this process never started is recorded and admitted, not faked', async () => {
  const r = repo();
  const { ForgeService } = await import('../service.ts');
  const service = new ForgeService({ repo: r });

  // Nothing at all: the honest answer is "no such job".
  // cancel() throws synchronously for a job that is not there: there is no job to
  // record anything about, so there is nothing to await.
  assert.throws(() => service.cancel('implement-smith-deadbeef'), /no job/);

  // Now create one that is finished, and try to cancel it. The marker is written;
  // `signalled` is false because there is no pid to signal, and saying otherwise
  // would be claiming a kill that did not happen.
  const ack = await service.spawnJob({ mode: 'implement', prompt: 'quick one', provider: 'agy' });
  await waitForTerminal(r, ack.jobId, 20_000);

  const fresh = new ForgeService({ repo: r }); // a "restarted" server: no live handles
  const outcome = fresh.cancel(ack.jobId);
  assert.equal(outcome.requested, true);
  assert.equal(outcome.signalled, false);
  assert.match(outcome.note, /no live worker here/);
});

test('list: spawnedIds tracks this process; ids and sinceMs filter', async () => {
  const r = repo();
  const { ForgeService } = await import('../service.ts');
  const service = new ForgeService({ repo: r });
  const ack = await service.spawnJob({ mode: 'implement', prompt: 'quick one', provider: 'agy' });
  await waitForTerminal(r, ack.jobId, 20_000);
  assert.deepEqual([...service.spawnedIds], [ack.jobId]);
  assert.equal((await service.list({ ids: service.spawnedIds })).length, 1);
  assert.equal((await service.list({ ids: new ForgeService({ repo: r }).spawnedIds })).length, 0, 'a restarted server has spawned nothing');
  assert.equal((await service.list({ sinceMs: Date.now() - 60_000 })).length, 1);
  assert.equal((await service.list({ sinceMs: Date.now() + 60_000 })).length, 0);
});

test('an unknown provider is rejected with a list, not a stack trace', async () => {
  const r = repo();
  const { ForgeService } = await import('../service.ts');
  const service = new ForgeService({ repo: r });
  await assert.rejects(
    () => service.spawnJob({ mode: 'implement', prompt: 'x', provider: 'cdoe' }),
    /unknown provider "cdoe"\. Known providers: agy, codex, opencode, claude, kimi/,
  );
  // And NOTHING was written: a rejected request leaves no half-created job behind.
  assert.deepEqual(readdirSync(r), []);
});

test('a missing binary produces a FAILED job, not a rejected promise', async () => {
  // A CHILD PROCESS, and that is the point rather than a workaround.
  //
  // providers/agy.ts reads `AGENT_SMITH_AGY_BIN` into a module-level const at load
  // time, so once this suite has imported the adapter the variable is fixed for
  // the rest of the process. Proving "the binary is missing" therefore requires a
  // fresh interpreter — and the fact that it does is itself worth stating, since
  // it is why the env override has to be set before the import in every test here.
  const r = repo();
  const child = path.resolve(HERE, '..', '..', '..', 'the-codes');
  const script = `
    const { ForgeService } = await import(${JSON.stringify(path.join(child, 'forge', 'service.ts'))});
    const fs = await import('node:fs');
    const path = await import('node:path');
    const repo = ${JSON.stringify(r)};
    const svc = new ForgeService({ repo });
    const ack = await svc.spawnJob({ mode: 'implement', prompt: 'x', provider: 'agy' });
    const at = path.join(repo, '.agent-smith', 'jobs', ack.jobId, 'job.json');
    const deadline = Date.now() + 10000;
    for (;;) {
      if (fs.existsSync(at)) {
        const m = JSON.parse(fs.readFileSync(at, 'utf8'));
        if (m.status !== 'running') { console.log(JSON.stringify({ status: m.status, jobStatus: m.jobStatus, error: m.error })); break; }
      }
      if (Date.now() > deadline) { console.log(JSON.stringify({ status: 'TIMEOUT' })); break; }
      await new Promise((res) => setTimeout(res, 25));
    }
  `;
  const out = execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
    env: { ...process.env, AGENT_SMITH_AGY_BIN: path.join(r, 'definitely-not-here') },
    encoding: 'utf8',
  });
  const got = JSON.parse(out.trim().split('\n').pop() ?? '{}') as { status: string; jobStatus?: string; error?: string };

  // The KEY property: spawn_job resolved, so the caller has a job id it can show,
  // and the job itself carries the failure. A rejected promise would have given
  // the caller nothing to draw and nothing to retry.
  assert.equal(got.status, 'failed');
  assert.equal(got.jobStatus, 'spawn-failed');
  // The adapter's own evidence is preserved verbatim BENEATH our verdict, which is
  // the whole reason the writer joins the two strings. Without it the error is the
  // useless half-sentence "worker reported failure (error)"; with it the cause is
  // on the page.
  assert.match(got.error ?? '', /no result|spawn/);
});

/* ── helpers ───────────────────────────────────────────────────────────────── */

async function waitForTerminal(repoRoot: string, jobId: string, timeoutMs: number): Promise<any> {
  await waitFor(
    () => {
      const at = path.join(repoRoot, '.agent-smith', 'jobs', jobId, 'job.json');
      if (!existsSync(at)) return false;
      const m = JSON.parse(readFileSync(at, 'utf8')) as { status: string };
      return m.status !== 'running';
    },
    timeoutMs,
  );
  return JSON.parse(
    readFileSync(path.join(repoRoot, '.agent-smith', 'jobs', jobId, 'job.json'), 'utf8'),
  );
}

test('humanDuration reads at a glance', async () => {
  const { humanDuration } = await import('../../providers/failure-text.ts');
  assert.equal(humanDuration(30_000), '30s');
  assert.equal(humanDuration(45 * 60_000), '45m');
  assert.equal(humanDuration(65 * 60_000), '1h05m');
  assert.equal(humanDuration(2 * 3_600_000), '2h');
});
