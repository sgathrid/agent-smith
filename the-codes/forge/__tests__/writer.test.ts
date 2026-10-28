/**
 * writer.test.ts — the state writer, and the round trip through our own reader.
 *
 * The round trip is the test that matters here. A writer whose output its own
 * reader cannot read is a system where the pane draws `unknown` forever and
 * nothing errors, so every terminal state is written and then read BACK through
 * harness/agent-smith.ts + normalize.ts and asserted on the normalized verdict.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { AgentSmithReader } from '../../harness/agent-smith.ts';
import { normalize } from '../../harness/normalize.ts';
import { readAllObservedJobs } from './observe.ts';
import { writeAtomic, writeJsonAtomic, appendLine, createMarker } from '../atomic.ts';
import { FILES, SCHEMA_VERSION, jobDir, jobFile, type ForgeManifest } from '../format.ts';
import { JobWriter, appendBounded, summaryTail } from '../writer.ts';
import type { JobResult, ProviderEvent } from '../../providers/types.js';

function repo(): string {
  return mkdtempSync(path.join(tmpdir(), 'agent-smith-writer-'));
}

/** A stamp the writer's flusher will accept: the coalescing window is 0 here, so
 *  what matters is that it is not in the PAST relative to `start()`. */
function now(): string {
  return new Date().toISOString();
}

function start(r: string, jobId = 'implement-smith-abcd1234'): JobWriter {
  const w = new JobWriter({ repo: r, jobId, flushMs: 0 });
  w.start({
    provider: 'agy',
    mode: 'implement',
    model: 'fake-model-1',
    effort: 'low',
    cwd: r,
    prompt: '# Dashboard rework\n\ndo the thing',
    unrestricted: false,
    conversation: null,
    timeoutMs: 1000,
    pipeline: null,
    stage: null,
    attempt: null,
  });
  return w;
}

function result(over: Partial<JobResult> = {}): JobResult {
  return {
    jobId: 'implement-smith-abcd1234',
    provider: 'agy',
    ok: true,
    status: 'success',
    exitCode: 0,
    signal: null,
    response: '# Report\n\nthe deliverable text',
    durationMs: 1000,
    startedAt: '2026-10-06T12:00:00.000Z',
    finishedAt: '2026-10-06T12:00:01.000Z',
    stateDir: '',
    ...over,
  };
}

/* ── the atomic primitives ─────────────────────────────────────────────────── */

test('fragmented assistant output stays coherent and final summary reaches every reader', async () => {
  const r = repo(); const id = 'implement-smith-abcd1234'; const w = start(r);
  w.onEvent({ kind: 'text', at: now(), stream: 'assistant', text: 'Found the ' });
  w.onEvent({ kind: 'text', at: now(), stream: 'assistant', text: 'edge case.' });
  w.onEvent({ kind: 'text', at: now(), stream: 'thinking', text: 'PRIVATE THINKING' });
  let raw = await new AgentSmithReader().read(r, id);
  assert.equal(raw?.payload.latestSummary, 'Found the edge case.');
  w.finish(result({ response: 'Final findings from the worker.' }), 'Final findings from the worker.');
  raw = await new AgentSmithReader().read(r, id);
  assert.equal(raw?.payload.latestSummary, 'Final findings from the worker.');
  assert.equal(raw?.payload.summarySource, 'worker');
});

test('writeAtomic leaves no temp file behind on success', () => {
  const r = repo();
  const at = path.join(r, 'nested', 'deeper', 'f.json');
  writeAtomic(at, 'hello');
  assert.equal(readFileSync(at, 'utf8'), 'hello');
  assert.deepEqual(readdirSync(path.dirname(at)), ['f.json'], 'the temp is renamed, not left');
});

test('writeAtomic replaces the whole body, never splices it', () => {
  // The property the whole single-anchor design rests on: a reader sees either
  // the entire previous file or the entire new one.
  const r = repo();
  const at = path.join(r, 'f.json');
  writeAtomic(at, '{"status":"running","pad":"aaaaaaaaaaaaaaaaaaaa"}');
  writeAtomic(at, '{"status":"succeeded"}');
  assert.deepEqual(JSON.parse(readFileSync(at, 'utf8')), { status: 'succeeded' });
});

test('appendLine creates parents and appends one JSON object per line', () => {
  const r = repo();
  const at = path.join(r, 'x', 'events.jsonl');
  appendLine(at, { a: 1 });
  appendLine(at, { a: 2 });
  const lines = readFileSync(at, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0] ?? ''), { a: 1 });
});

test('createMarker is first-writer-wins', () => {
  const r = repo();
  const at = path.join(r, 'cancel');
  assert.equal(createMarker(at, 'first'), true);
  assert.equal(createMarker(at, 'second'), false);
  assert.equal(readFileSync(at, 'utf8'), 'first');
});

test('writeJsonAtomic round-trips a manifest through disk unchanged', () => {
  const r = repo();
  const at = path.join(r, 'job.json');
  writeJsonAtomic(at, { schema: SCHEMA_VERSION, status: 'running', nested: { a: [1, 2] } });
  assert.deepEqual(JSON.parse(readFileSync(at, 'utf8')), {
    schema: SCHEMA_VERSION,
    status: 'running',
    nested: { a: [1, 2] },
  });
});

/* ── start ─────────────────────────────────────────────────────────────────── */

test('the anchor exists the instant start() returns, before any process runs', () => {
  // A reader that finds nothing has to answer "does this job exist?" with "no",
  // and then the job's whole life is invisible. So the anchor is written FIRST.
  const r = repo();
  const w = start(r);
  const m = JSON.parse(readFileSync(jobFile(r, w.jobId, FILES.job), 'utf8')) as ForgeManifest;
  assert.equal(m.status, 'running');
  assert.equal(m.schema, SCHEMA_VERSION);
  assert.equal(m.task, 'Dashboard rework', 'the task is the first prompt line, not the whole prompt');
  assert.equal(m.provider, 'agy');
  assert.ok(existsSync(jobFile(r, w.jobId, FILES.progress)));
});

test('the manifest records the full prompt LENGTH but never the prompt', () => {
  const r = repo();
  const w = start(r);
  const body = readFileSync(jobFile(r, w.jobId, FILES.job), 'utf8');
  assert.equal(JSON.parse(body).promptChars > 0, true);
  assert.equal(body.includes('do the thing'), false, 'the prompt body is megabytes of the user\'s source code');
});

/* ── events ────────────────────────────────────────────────────────────────── */

test('a tool call is counted and the newest step wins the activity cell', () => {
  const r = repo();
  const w = start(r);
  for (const step of [2, 3, 4]) {
    w.onEvent({
      kind: 'activity-start',
      at: now(),
      activity: { stepIndex: step, tool: `tool_${step}`, input: `cmd ${step}` },
    } satisfies ProviderEvent);
  }
  const p = JSON.parse(readFileSync(jobFile(r, w.jobId, FILES.progress), 'utf8')) as {
    toolCalls: number;
    recentActivities: { stepIndex: number; tool: string }[];
  };
  assert.equal(p.toolCalls, 3, 'count observed calls rather than gaps in provider step indices');
  // Highest step_index, not last-in-array: a rewritten array mid-poll is not
  // guaranteed sorted, and the pane picks by index for exactly that reason.
  assert.equal(p.recentActivities[p.recentActivities.length - 1]?.tool, 'tool_4');
});

test('a DONE record inherits the input from its ACTIVE record', () => {
  // Verified against the corpus: agy splits ACTIVE/DONE at the same step_index and
  // only ACTIVE carries tool_info.parameters. Dropping it would leave every
  // finished job's activity cell blank.
  const r = repo();
  const w = start(r);
  w.onEvent({
    kind: 'activity-start',
    at: now(),
    activity: { stepIndex: 2, tool: 'run_command', input: 'npm test' },
  } satisfies ProviderEvent);
  w.onEvent({
    kind: 'activity-end',
    at: now(),
    activity: { stepIndex: 2, tool: 'run_command', output: '331 passing' },
    status: 'done',
  } satisfies ProviderEvent);
  const p = JSON.parse(readFileSync(jobFile(r, w.jobId, FILES.progress), 'utf8')) as {
    recentActivities: { input?: string; status: string }[];
  };
  assert.equal(p.recentActivities[0]?.input, 'npm test');
  assert.equal(p.recentActivities[0]?.status, 'done');
});

test('an activity UPDATE keeps the call alive, fills in its input and never counts twice', () => {
  // A tool that runs for minutes emits updates, not new calls. Ignoring them
  // left `lastEventAt` frozen (a live job looked stalled), and treating them as
  // starts would inflate the tool count.
  const r = repo();
  const w = start(r);
  const first = new Date(Date.now() + 1_000).toISOString();
  const second = new Date(Date.now() + 60_000).toISOString();
  w.onEvent({ kind: 'activity-start', at: first, activity: { stepIndex: 3, tool: 'bash' } } satisfies ProviderEvent);
  w.onEvent({
    kind: 'activity-update',
    at: second,
    activity: { stepIndex: 3, tool: 'bash', input: '{"command":"cargo test"}', output: 'Compiling' },
  } satisfies ProviderEvent);

  const p = JSON.parse(readFileSync(jobFile(r, w.jobId, FILES.progress), 'utf8')) as {
    lastEventAt: string;
    toolCalls: number;
    digest: { testRuns: number };
    recentActivities: { stepIndex: number; tool: string; status: string; input?: string }[];
  };
  assert.equal(p.lastEventAt, second, 'a long tool call keeps the job visibly alive');
  assert.equal(p.toolCalls, 1, 'an update is the same call, not a new one');
  assert.deepEqual(p.recentActivities[0], {
    stepIndex: 3,
    tool: 'bash',
    status: 'active',
    input: '{"command":"cargo test"}',
  });
  assert.equal(p.digest.testRuns, 1, 'input that arrives on an update still classifies the call');

  const view = JSON.parse(readFileSync(jobFile(r, w.jobId, FILES.view), 'utf8')) as {
    tools: { stepIndex: number; input: string; output: string; state: string }[];
  };
  assert.equal(view.tools.length, 1);
  assert.equal(view.tools[0]?.stepIndex, 3);
  assert.equal(view.tools[0]?.state, 'active', 'an update does not finish the call');
  assert.match(view.tools[0]?.input ?? '', /cargo test/);
  assert.equal(view.tools[0]?.output, 'Compiling');
});

test('only five activities are retained, and they are the newest five', () => {
  const r = repo();
  const w = start(r);
  for (let step = 2; step <= 20; step += 1) {
    w.onEvent({
      kind: 'activity-start',
      at: now(),
      activity: { stepIndex: step, tool: `t${step}` },
    } satisfies ProviderEvent);
  }
  const p = JSON.parse(readFileSync(jobFile(r, w.jobId, FILES.progress), 'utf8')) as {
    recentActivities: { tool: string }[];
  };
  assert.equal(p.recentActivities.length, 5);
  assert.equal(p.recentActivities[0]?.tool, 't16');
});

test('warn and error notices become progress warnings; info ones do not', () => {
  const r = repo();
  const w = start(r);
  w.onEvent({ kind: 'notice', at: now(), level: 'info', message: 'fyi' } satisfies ProviderEvent);
  w.onEvent({
    kind: 'notice',
    at: now(),
    level: 'warn',
    message: 'auto-denied by permission policy',
  } satisfies ProviderEvent);
  const p = JSON.parse(readFileSync(jobFile(r, w.jobId, FILES.progress), 'utf8')) as { warnings: string[] };
  assert.deepEqual(p.warnings, ['auto-denied by permission policy']);
});

test('assistant text accumulates and is bounded, keeping the NEWEST', () => {
  const r = repo();
  const w = start(r);
  for (let i = 0; i < 50; i += 1) {
    w.onEvent({ kind: 'text', at: now(), text: `line ${i} `, stream: 'assistant' } satisfies ProviderEvent);
  }
  const p = JSON.parse(readFileSync(jobFile(r, w.jobId, FILES.progress), 'utf8')) as { latestText: string };
  assert.ok(p.latestText.length <= 4000);
  assert.match(p.latestText, /line 49/, 'the newest text is what the pane shows');
});

test('thinking text is not mixed into the reasoning cell', () => {
  const r = repo();
  const w = start(r);
  w.onEvent({ kind: 'text', at: now(), text: 'internal', stream: 'thinking' } satisfies ProviderEvent);
  const p = JSON.parse(readFileSync(jobFile(r, w.jobId, FILES.progress), 'utf8')) as { latestText: string | null };
  assert.equal(p.latestText, null);
});

test('the conversation id from the started event is captured for resume', () => {
  // This is what makes an escalation a CONTINUATION rather than a restart: the
  // runner passes it back as `--conversation <id>` on attempt 2.
  const r = repo();
  const w = start(r);
  w.onEvent({ kind: 'started', at: now(), conversationId: 'conv-xyz' } satisfies ProviderEvent);
  assert.equal(JSON.parse(readFileSync(jobFile(r, w.jobId, FILES.job), 'utf8')).conversation, 'conv-xyz',
    'resume identity is durable before finish');
  w.finish(result({}), '# Report\n\ntext');
  const m = JSON.parse(readFileSync(jobFile(r, w.jobId, FILES.job), 'utf8')) as ForgeManifest;
  assert.equal(m.conversation, 'conv-xyz');
});

/* ── finish, and the round trip ────────────────────────────────────────────── */

test('a successful job round-trips through our own reader as succeeded', async () => {
  const r = repo();
  const w = start(r);
  w.finish(result(), '# Report\n\nthe deliverable text');

  const raw = await new AgentSmithReader().read(r, w.jobId);
  assert.ok(raw);
  const observed = normalize(raw!);
  assert.equal(observed.provider, 'agent-smith');
  assert.equal(observed.status, 'succeeded');
  assert.match(observed.output ?? '', /deliverable text/);
  assert.equal(observed.mode, 'implement');
  assert.equal(observed.model, 'fake-model-1');
  assert.equal(observed.label, 'agy', 'label falls back to the provider when approvals were enforced');
  assert.deepEqual(observed.warnings, []);
});

test('THE TRAP round-trips as FAILED, and the warning survives', async () => {
  const r = repo();
  const w = start(r);
  w.finish(
    result({
      ok: false,
      status: 'denied',
      response: '',
      deniedActions: [{ action: 'command', displayName: 'RunCommand' }],
      error: 'agy soft-denied 1 tool action(s)',
    }),
    null,
  );

  const raw = await new AgentSmithReader().read(r, w.jobId);
  const observed = normalize(raw!);
  assert.equal(observed.status, 'failed');
  assert.equal(
    observed.warnings.some((x) => x.code === 'suspicious_success'),
    true,
    'the reader keeps the warning even though it did no verdict of its own',
  );
});

test('an unrestricted job says so in its label, because the band has to show it', async () => {
  const r = repo();
  const w = new JobWriter({ repo: r, jobId: 'implement-smith-11111111' });
  w.start({
    provider: 'agy',
    mode: 'implement',
    model: null,
    effort: null,
    cwd: r,
    prompt: 'x',
    unrestricted: true,
    conversation: null,
    timeoutMs: 1,
    pipeline: null,
    stage: null,
    attempt: null,
  });
  w.finish({ ...result({ jobId: 'implement-smith-11111111' }) }, '# Report\n\ntext');
  const raw = await new AgentSmithReader().read(r, 'implement-smith-11111111');
  assert.equal(normalize(raw!).label, 'unrestricted');
});

test('a running job reads as running, and a started job is discoverable', async () => {
  const r = repo();
  const w = start(r);
  const ids = await new AgentSmithReader().discover(r);
  assert.deepEqual(ids, [w.jobId]);
  const raw = await new AgentSmithReader().read(r, w.jobId);
  assert.equal(normalize(raw!).status, 'running');
});

test('a FINISHED job whose anchor is lost reads as unknown, never as succeeded', async () => {
  // "We cannot tell" and "it succeeded" are different claims, and a band that
  // draws one as the other is lying. This is the single most load-bearing rule in
  // harness/types.ts, and it is why the writer never deletes the anchor: the
  // report is still on disk, so the job is visible, but we refuse to assert a
  // verdict we cannot point at a source for.
  const r = repo();
  const w = start(r);
  w.finish(result(), '# Report\n\nthe deliverable text');
  unlinkSync(jobFile(r, w.jobId, FILES.job));
  const raw = await new AgentSmithReader().read(r, w.jobId);
  assert.ok(raw, 'the report is evidence the job exists');
  assert.equal(raw?.partial, true);
  const observed = normalize(raw!);
  assert.equal(observed.status, 'unknown');
  assert.notEqual(observed.status, 'succeeded');
  assert.match(observed.output ?? '', /deliverable text/, 'what we can see, we still report');
});

test('a RUNNING job with no anchor at all is not a job we will invent', async () => {
  // Identity requires evidence of a job, not just a directory: a half-created
  // directory (crash between mkdir and the first write) must not draw as `unknown`
  // forever next to the jobs that are real.
  const r = repo();
  const w = start(r);
  unlinkSync(jobFile(r, w.jobId, FILES.job));
  unlinkSync(jobFile(r, w.jobId, FILES.progress));
  assert.equal(await new AgentSmithReader().read(r, w.jobId), null);
});

test('a manifest from a NEWER writer is refused, not half-understood', async () => {
  // Reading a v2 file with v1 rules produces exactly the confident wrong answers
  // this project exists to prevent.
  const r = repo();
  const w = start(r);
  writeJsonAtomic(jobFile(r, w.jobId, FILES.job), {
    schema: SCHEMA_VERSION + 1,
    jobId: w.jobId,
    status: 'succeeded',
  });
  const raw = await new AgentSmithReader().read(r, w.jobId);
  assert.equal(raw?.payload['schema'], SCHEMA_VERSION + 1);
  const observed = normalize(raw!);
  assert.equal(observed.status, 'unknown');
  assert.match(observed.warnings.map((x) => x.message).join(' '), /newer than this reader/);
});

test('a stray directory in the jobs root is not reported as a job', async () => {
  // A band that draws `unknown` for a folder a human dropped here is drawing a
  // lie. Identity requires evidence of a job.
  const r = repo();
  start(r);
  mkdirSync(jobDir(r, 'notes'), { recursive: true });
  const ids = await new AgentSmithReader().discover(r);
  assert.ok(ids.includes('notes'), 'it is listed as a candidate');
  assert.equal(await new AgentSmithReader().read(r, 'notes'), null, 'but it is not a job');
});

test('an unknown job is null, not a throw', async () => {
  const r = repo();
  assert.equal(await new AgentSmithReader().read(r, 'implement-smith-99999999'), null);
  assert.deepEqual(await new AgentSmithReader().discover(r), []);
});

test('an absent jobs directory yields [], which is the ordinary case', async () => {
  assert.deepEqual(await new AgentSmithReader().discover(repo()), []);
});

/* ── cancel ────────────────────────────────────────────────────────────────── */

test('cancel writes a request marker without claiming the worker has stopped', async () => {
  const r = repo();
  const w = start(r);
  w.requestCancel('2026-10-06T12:00:03.000Z');
  assert.equal(readFileSync(jobFile(r, w.jobId, FILES.cancel), 'utf8'), '2026-10-06T12:00:03.000Z');

  const raw = await new AgentSmithReader().read(r, w.jobId);
  assert.equal(normalize(raw!).status, 'running');
});

test('a second cancel request does not move the cancellation instant', async () => {
  const r = repo();
  const w = start(r);
  w.requestCancel('2026-10-06T12:00:03.000Z');
  w.requestCancel('2026-10-06T12:09:00.000Z');
  assert.equal(readFileSync(jobFile(r, w.jobId, FILES.cancel), 'utf8'), '2026-10-06T12:00:03.000Z');
});

test('a cancel request does not rewrite a successful worker completion as canceled', async () => {
  const r = repo();
  const w = start(r);
  w.requestCancel();
  const m = w.finish(result(), '# Report\n\nit raced the kill');
  assert.equal(m.status, 'succeeded');
  const jobs = await readAllObservedJobs(r);
  assert.equal(jobs[0]?.status, 'succeeded');
});

/* ── idempotence and abort ─────────────────────────────────────────────────── */

test('a second terminal write does not rewrite history', async () => {
  const r = repo();
  const w = start(r);
  w.finish(result(), '# Report\n\nfirst');
  const before = readFileSync(jobFile(r, w.jobId, FILES.job), 'utf8');
  w.finish(result(), '# Report\n\nsecond');
  assert.equal(readFileSync(jobFile(r, w.jobId, FILES.job), 'utf8'), before);
  assert.equal(readFileSync(jobFile(r, w.jobId, FILES.report), 'utf8'), '# Report\n\nfirst');
});

test('abort with no result event still terminates the job', async () => {
  // A job that never gets a terminal write stays `running` forever, which is a
  // lie with a very long fuse.
  const r = repo();
  const w = start(r);
  const m = w.abort('failed', 'the adapter threw before it returned');
  assert.equal(m?.status, 'failed');
  const raw = await new AgentSmithReader().read(r, w.jobId);
  assert.equal(normalize(raw!).status, 'failed');
});

test('events after the terminal state are ignored', async () => {
  const r = repo();
  const w = start(r);
  w.finish(result(), '# Report\n\ndone');
  w.onEvent({ kind: 'text', at: now(), text: 'late', stream: 'assistant' } satisfies ProviderEvent);
  const p = JSON.parse(readFileSync(jobFile(r, w.jobId, FILES.progress), 'utf8')) as { latestText: string | null };
  assert.equal(p.latestText, null);
});

/* ── the registry sweep ────────────────────────────────────────────────────── */

test('one job, one verdict — a mirrored copy left by an older version is not counted twice', async () => {
  const r = repo();
  const w = start(r);
  w.finish(result(), '# Report\n\nthe deliverable text');
  // Older versions mirrored the job into .agy-staff/jobs; the primary reader
  // must claim the id or the job is reported twice.
  const dir = path.join(r, '.agy-staff', 'jobs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${w.jobId}.spec.json`), JSON.stringify({ prompt_source: { task: 'mirrored' } }));
  const all = await readAllObservedJobs(r);
  assert.equal(all.length, 1);
  assert.equal(all[0]?.provider, 'agent-smith');
});

test('an interop job from another harness is still visible, and still once', async () => {
  const r = repo();
  // Pre-populate as if agy-staff wrote it.
  const id = 'implement-musm82da-f1dc1fe4';
  const dir = path.join(r, '.agy-staff', 'jobs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.spec.json`), JSON.stringify({ prompt_source: { task: 'a real job' } }));
  writeFileSync(
    path.join(dir, `${id}.result.md.status.json`),
    JSON.stringify({ status: 'done', finished_at: '2026-10-03T17:05:00.000Z' }),
  );
  writeFileSync(path.join(dir, `${id}.result.md`), '# the real report\n\nwith words in it');

  const all = await readAllObservedJobs(r);
  assert.equal(all.length, 1);
  assert.equal(all[0]?.provider, 'agy-staff');
  assert.equal(all[0]?.status, 'succeeded');
});

/* ── helpers ───────────────────────────────────────────────────────────────── */

/** appendBounded cuts from the FRONT, because the newest text is what is shown. */
test('appendBounded keeps the tail, not the head', () => {
  assert.equal(appendBounded('aaa', 'bbb', 10), 'aaabbb');
  assert.equal(appendBounded('', 'bbb', 10), 'bbb');
  const long = appendBounded('x'.repeat(100), 'TAIL', 10);
  assert.equal(long, 'xxxxxxTAIL');
  assert.equal(long.length, 10, 'the bound is a bound, not a suggestion');
});

/** Node's fs, reached once so the suite stays a single import surface. */
function require$fs(): typeof import('node:fs') {
  return fsModule;
}
import * as fsModule from 'node:fs';

test('bounded canonical detail round-trips text fragments, tool identity and actual tool count', async () => {
  const { readForgeDetail } = await import('../../surfaces/mod/hooks/canonical.ts');
  const r = repo(); const id = 'implement-smith-abcd1234'; const w = start(r);
  const at = now();
  w.onEvent({ kind: 'activity-start', at, activity: { stepIndex: 40, tool: 'Read', input: 'source.ts' } });
  w.onEvent({ kind: 'activity-end', at, activity: { stepIndex: 40, tool: 'tool_result', output: 'file content' }, status: 'done' });
  w.onEvent({ kind: 'text', at, stream: 'assistant', text: 'Found the', delta: true });
  w.onEvent({ kind: 'text', at, stream: 'assistant', text: ' ', delta: true });
  w.onEvent({ kind: 'text', at, stream: 'assistant', text: 'edge case.', delta: true });
  w.onEvent({ kind: 'text', at, stream: 'thinking', text: 'PRIVATE THINKING' });
  w.finish(result(), 'Final findings from the worker.');
  const fs = {
    async read(p: string) { return readFileSync(p, 'utf8'); },
    async exists(p: string) { return existsSync(p); },
    async list(p: string) { return readdirSync(p, { withFileTypes: true }).map(e => ({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file', size: 0 })); },
  };
  const detail = await readForgeDetail(fs, r, id, Date.now());
  assert.equal(detail?.job.toolCount, 1, 'a high provider step index is not a tool count');
  assert.deepEqual(detail?.transcript, ['Found the edge case.']);
  assert.deepEqual(detail?.timeline?.map(e=>e.kind), ['tool','assistant']);
  assert.deepEqual(detail?.timeline?.map(e=>e.sequence), [0,1]);
  assert.equal(detail?.timeline?.[0]?.kind==='tool' ? detail.timeline[0].state : null, 'done');
  assert.equal(detail?.timeline?.[1]?.kind==='assistant' ? detail.timeline[1].text : null, 'Found the edge case.');
  assert.equal(JSON.parse(readFileSync(jobFile(r,id,FILES.progress),'utf8')).recentActivities[0].tool, 'Read');
  assert.equal(detail?.history[0]?.tool, 'Read', 'completion must retain the original tool name');
  assert.equal(detail?.history[0]?.label, 'source.ts');
  assert.equal(detail?.history[0]?.state, 'done');
  assert.match(detail?.job.prompt ?? '', /Dashboard rework/);
});

test('detail snapshot stays under the mod file limit and marks truncation', () => {
  const r = repo(); const id = 'implement-smith-abcd1234'; const w = start(r);
  for (let i = 0; i < 70; i++) {
    w.onEvent({ kind: 'activity-start', at: now(), activity: { stepIndex: i, tool: 'Read', input: '\\'.repeat(4000) } });
    w.onEvent({ kind: 'text', at: now(), stream: 'assistant', text: '\\'.repeat(80_000), delta: true });
  }
  w.finish(result(), 'Report');
  const snapshot = readFileSync(path.join(r, '.agent-smith/jobs', id, 'view.json'), 'utf8');
  assert.ok(Buffer.byteLength(snapshot) < 4 * 1024 * 1024);
  const parsed = JSON.parse(snapshot);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.tools.length, 60);
  assert.ok(parsed.transcript.join('').length <= 64_000);
});

test('ordered activity preserves assistant/tool interleaving while a completed tool updates in place', () => {
  const r=repo();const w=start(r);const at=now();
  w.onEvent({kind:'activity-start',at,activity:{stepIndex:0,tool:'Read',input:'one.ts'}});
  w.onEvent({kind:'text',at,stream:'assistant',text:'Explaining the first finding.'});
  w.onEvent({kind:'activity-end',at,activity:{stepIndex:0,tool:'tool_result',output:'source'},status:'done'});
  w.onEvent({kind:'activity-start',at,activity:{stepIndex:1,tool:'Bash',input:'npm test'}});
  w.onEvent({kind:'text',at,stream:'assistant',text:'Tests are running.'});
  w.finish(result(),'Report');
  const view=JSON.parse(readFileSync(jobFile(r,w.jobId,FILES.view),'utf8'));
  assert.deepEqual(view.timeline.map((e:{kind:string})=>e.kind),['tool','assistant','tool','assistant']);
  assert.deepEqual(view.timeline.map((e:{sequence:number})=>e.sequence),[0,1,2,3]);
  assert.equal(view.timeline[0].tool,'Read');assert.equal(view.timeline[0].state,'done');
});

test('running start time and tool count reach the reader before completion', async () => {
  const r = repo(); const w = start(r);
  const m = JSON.parse(readFileSync(jobFile(r, w.jobId, FILES.job), 'utf8'));
  assert.equal(m.startedAt, m.createdAt);
  w.onEvent({ kind: 'activity-start', at: now(), activity: { stepIndex: 7, tool: 'Read' } });
  w.onEvent({ kind: 'activity-end', at: now(), activity: { stepIndex: 7, tool: 'Read' }, status: 'done' });
  const raw = await new AgentSmithReader().read(r, w.jobId);
  assert.equal(raw?.payload.tool_calls, 1);
  assert.deepEqual(raw?.payload.last_activity, { stepIndex: 7, tool: 'Read', status: 'done' });
});

test('last activity follows the newest event even when an earlier concurrent tool finishes', async () => {
  const r = repo(); const w = start(r);
  w.onEvent({ kind: 'activity-start', at: now(), activity: { stepIndex: 1, tool: 'Read' } });
  w.onEvent({ kind: 'activity-start', at: now(), activity: { stepIndex: 2, tool: 'Bash' } });
  w.onEvent({ kind: 'activity-end', at: now(), activity: { stepIndex: 1, tool: 'Read' }, status: 'done' });
  const raw = await new AgentSmithReader().read(r, w.jobId);
  assert.deepEqual(raw?.payload.last_activity, { stepIndex: 1, tool: 'Read', status: 'done' });
});

test('successful report with denied tools keeps a factual nonfatal warning', async () => {
  const r = repo(); const w = start(r);
  w.finish(result({ deniedActions: [{ action: 'tool', displayName: 'Bash' }] }), '# Review\n\nThe implementation handles the edge case correctly.');
  const raw = await new AgentSmithReader().read(r, w.jobId);
  const observed = normalize(raw!);
  assert.equal(observed.status, 'succeeded');
  assert.ok(observed.warnings.some(w => /denied/i.test(w.message)));
  assert.ok(observed.warnings.every(w => w.code !== 'suspicious_success'));
  assert.doesNotMatch(observed.warnings.map(w => w.message).join(' '), /recorded FAILED|doing nothing/);
});

test('changed file counts are available only from complete recorded evidence', async () => {
  const r = repo(); const w = start(r);
  const file = jobFile(r, w.jobId, FILES.job);
  const m = JSON.parse(readFileSync(file, 'utf8'));
  const read = async () => (await new AgentSmithReader().read(r, w.jobId))?.payload;
  assert.equal((await read())?.changed_files, undefined);
  writeFileSync(file, JSON.stringify({ ...m, changedFiles: [] }));
  assert.deepEqual((await read())?.changed_files, []);
  writeFileSync(file, JSON.stringify({ ...m, changedFiles: ['source.ts'] }));
  assert.deepEqual((await read())?.changed_files, ['source.ts']);
  writeFileSync(file, JSON.stringify({ ...m, changedFiles: ['source.ts'], changedFilesTruncated: true }));
  assert.equal((await read())?.changed_files, undefined);
});

test('started conversation survives inside the progress coalescing window', () => {
  const r = repo();
  const w = new JobWriter({ repo: r, jobId: 'implement-smith-abcd1234', flushMs: 60_000 });
  w.start({ provider: 'agy', mode: 'implement', model: null, effort: null,
    cwd: r, prompt: 'work', timeoutMs: 1000, unrestricted: false, conversation: null,
    pipeline: null, stage: null, attempt: null });
  w.onEvent({ kind: 'started', at: now(), conversationId: 'durable-conversation' });
  assert.equal(JSON.parse(readFileSync(jobFile(r, w.jobId, FILES.job), 'utf8')).conversation, 'durable-conversation');
});

test('progress.json carries a digest of what the worker has done', () => {
  const r = repo();
  const w = start(r);
  const call = (step: number, tool: string, input: string, status: 'done' | 'error' = 'done') => {
    w.onEvent({ kind: 'activity-start', at: now(), activity: { stepIndex: step, tool, input } } satisfies ProviderEvent);
    w.onEvent({ kind: 'activity-end', at: now(), activity: { stepIndex: step, tool }, status } satisfies ProviderEvent);
  };
  call(1, 'view_file', JSON.stringify({ AbsolutePath: path.join(r, 'src', 'a.py') }));
  call(2, 'replace_file_content', JSON.stringify({ TargetFile: path.join(r, 'src', 'a.py') }));
  call(3, 'run_command', JSON.stringify({ CommandLine: 'pytest -q' }), 'error');
  w.finish({ jobId: w.jobId, provider: 'fake', ok: true, status: 'success', exitCode: 0, signal: null, response: 'done',
    durationMs: 1, startedAt: now(), finishedAt: now(), stateDir: r } as JobResult, 'done');
  const p = JSON.parse(readFileSync(jobFile(r, w.jobId, FILES.progress), 'utf8')) as { digest: Record<string, unknown> };
  assert.equal(p.digest.filesRead, 1);
  assert.deepEqual(p.digest.edited, ['src/a.py'], 'paths are relative to the job cwd');
  assert.equal(p.digest.testRuns, 1);
  assert.equal(p.digest.lastTestFailed, true);
});

/* ── failure reason ────────────────────────────────────────────────────────── */

function failedManifest(over: Partial<JobResult>, report = ''): ForgeManifest {
  const r = repo();
  const w = start(r, 'implement-smith-abcd1234');
  w.finish(result(over), report);
  return JSON.parse(readFileSync(jobFile(r, 'implement-smith-abcd1234', FILES.job), 'utf8')) as ForgeManifest;
}

test('a fatal denial stores the short reason and keeps the adapter error as is', () => {
  const m = failedManifest({
    ok: false, status: 'denied', response: '', error: 'denied view_file · stderr: nope',
    deniedActions: [{ action: 'view', displayName: 'view_file' }],
  });
  assert.equal(m.status, 'failed');
  assert.equal(m.reason, 'denied view_file');
  assert.equal(m.error, 'denied view_file · stderr: nope', 'no verdict prefix, no repetition');
});

test('timeout, empty report and success set reason from the cause', () => {
  assert.equal(failedManifest({ ok: false, status: 'timeout', error: 'timed out after 45m' }).reason, 'timed out');
  const empty = failedManifest({ ok: true, response: '' }, '');
  assert.equal(empty.reason, 'no output');
  assert.equal(empty.error, 'no output');
  const ok = failedManifest({}, 'delivered');
  assert.equal(ok.reason, null);
});

test('abort stores the short reason before the detail', () => {
  const r = repo();
  const w = start(r, 'implement-smith-abcd1234');
  w.abort('failed', "couldn't start · ENOENT");
  const m = JSON.parse(readFileSync(jobFile(r, 'implement-smith-abcd1234', FILES.job), 'utf8')) as ForgeManifest;
  assert.equal(m.reason, "couldn't start");
  assert.equal(m.error, "couldn't start · ENOENT");
});

test('a long error keeps its cause and its stderr tail', async () => {
  const { failureFields } = await import('../format.ts');
  const error = `denied view_file · stderr: ${'x'.repeat(2_000)}THE-END`;
  const { error: kept, reason } = failureFields({ status: 'failed', suspicious: true, reason: 'denied view_file' },
    { status: 'denied', error, deniedActions: [{ action: 'view_file' }] });
  assert.equal(reason, 'denied view_file');
  assert.ok(kept!.length <= 1_200);
  assert.ok(kept!.startsWith('denied view_file'));
  assert.ok(kept!.endsWith('THE-END'));
});

test('an unrelated error still shows beside a denial warning', async () => {
  const r = repo(); const w = start(r);
  w.finish(result({ ok: false, status: 'error', error: 'exited 3, no result', deniedActions: [{ action: 'command', displayName: 'RunCommand' }] }), '');
  const observed = normalize((await new AgentSmithReader().read(r, w.jobId))!);
  const messages = observed.warnings.map((x) => x.message);
  assert.ok(messages.some((m) => /denied/.test(m)), messages.join(' | '));
  assert.ok(messages.includes('exited 3, no result'), messages.join(' | '));
});

/* ── honest state: cwd gone, tool errors, summary, early failure ───────────── */

function startIn(r: string, cwd: string, mode: string, jobId = `${mode}-smith-abcd1234`): JobWriter {
  const w = new JobWriter({ repo: r, jobId, flushMs: 0 });
  w.start({
    provider: 'opencode', mode, model: 'm', effort: null, cwd, prompt: 'do it', unrestricted: false,
    conversation: null, timeoutMs: 1000, pipeline: null, stage: null, attempt: null,
  });
  return w;
}

function readManifest(r: string, jobId: string): ForgeManifest {
  return JSON.parse(readFileSync(jobFile(r, jobId, FILES.job), 'utf8')) as ForgeManifest;
}

function readProgressWarnings(r: string, jobId: string): string[] {
  return (JSON.parse(readFileSync(jobFile(r, jobId, FILES.progress), 'utf8')) as { warnings: string[] }).warnings;
}

test('an implement job whose cwd vanished before finish fails as unverifiable', async () => {
  const r = repo();
  const cwd = mkdtempSync(path.join(tmpdir(), 'agent-smith-cwd-'));
  const w = startIn(r, cwd, 'implement');
  rmSync(cwd, { recursive: true, force: true });
  await w.prepareFinish();
  const m = w.finish(result({ durationMs: 120_000 }), '# Report\n\nall done');
  assert.equal(m.status, 'failed');
  assert.equal(m.cwdMissingAtFinish, true);
  assert.equal(m.changedFilesUnknown, true);
  assert.equal(m.changedFiles, undefined, 'no silent "no edits"');
  assert.equal(m.reason, 'working directory gone');
  assert.match(m.error ?? '', /working directory gone; nothing could be verified/);
  assert.equal(m.failedEarly, undefined, 'the provider succeeded; this is not a route failure');
  assert.deepEqual(readManifest(r, w.jobId).cwdMissingAtFinish, true);
});

test('a cwd-gone implement job reads back as failed through the reader', async () => {
  const r = repo();
  const cwd = mkdtempSync(path.join(tmpdir(), 'agent-smith-cwd-'));
  const w = new JobWriter({ repo: r, jobId: 'implement-smith-cwdgone1', flushMs: 0 });
  w.start({
    provider: 'opencode', mode: 'implement', model: 'm', effort: null, cwd, prompt: 'do it', unrestricted: false,
    conversation: null, timeoutMs: 1000, pipeline: null, stage: null, attempt: null,
  });
  rmSync(cwd, { recursive: true, force: true });
  await w.prepareFinish();
  w.finish(result({ durationMs: 120_000 }), '# Report\n\nall done');
  const observed = normalize((await new AgentSmithReader().read(r, w.jobId))!);
  assert.equal(observed.status, 'failed');
  assert.ok(observed.warnings.some((x) => /working directory gone/.test(x.message)), observed.warnings.map((x) => x.message).join(' | '));
});

test('a review whose worktree was cleaned after it reported still succeeds, with a warning', async () => {
  const r = repo();
  const cwd = mkdtempSync(path.join(tmpdir(), 'agent-smith-cwd-'));
  const w = startIn(r, cwd, 'review');
  rmSync(cwd, { recursive: true, force: true });
  await w.prepareFinish();
  const m = w.finish(result(), '# Review\n\nfindings');
  assert.equal(m.status, 'succeeded');
  assert.equal(m.cwdMissingAtFinish, true);
  assert.equal(m.changedFilesUnknown, true);
  assert.ok(readProgressWarnings(r, w.jobId).some((x) => /was gone at finish/.test(x)));
});

test('a review whose events show edits is a writing job: cwd gone fails it', async () => {
  const r = repo();
  const cwd = mkdtempSync(path.join(tmpdir(), 'agent-smith-cwd-'));
  const w = startIn(r, cwd, 'review');
  w.onEvent({ kind: 'activity-start', at: now(), activity: { stepIndex: 0, tool: 'edit', input: JSON.stringify({ filePath: `${cwd}/a.ts` }) } });
  w.onEvent({ kind: 'activity-end', at: now(), activity: { stepIndex: 0, tool: 'edit' }, status: 'done' });
  rmSync(cwd, { recursive: true, force: true });
  await w.prepareFinish();
  assert.equal(w.finish(result({ durationMs: 60_000 }), '# Review\n\nfixed it').status, 'failed');
  const p = JSON.parse(readFileSync(jobFile(r, w.jobId, FILES.progress), 'utf8')) as { editsCompleted?: number };
  assert.equal(p.editsCompleted, 1);
});

test('a review whose edit attempt failed, was denied or never ended is not a writing job', async () => {
  for (const [i, end] of (['error', 'denied', null] as const).entries()) {
    const r = repo();
    const cwd = mkdtempSync(path.join(tmpdir(), 'agent-smith-cwd-'));
    const w = startIn(r, cwd, 'review', `review-smith-edit000${i}`);
    w.onEvent({ kind: 'activity-start', at: now(), activity: { stepIndex: 0, tool: 'edit', input: JSON.stringify({ filePath: `${cwd}/a.ts` }) } });
    if (end !== null) w.onEvent({ kind: 'activity-end', at: now(), activity: { stepIndex: 0, tool: 'edit' }, status: end });
    assert.equal(w.verdictFacts().writing, false, String(end));
    rmSync(cwd, { recursive: true, force: true });
    await w.prepareFinish();
    const m = w.finish(result({ durationMs: 60_000 }), '# Review\n\nfull findings');
    assert.equal(m.status, 'succeeded', String(end));
    assert.equal(m.cwdMissingAtFinish, true);
    assert.ok(readProgressWarnings(r, w.jobId).some((x) => /was gone at finish/.test(x)), String(end));
    const p = JSON.parse(readFileSync(jobFile(r, w.jobId, FILES.progress), 'utf8')) as { editsCompleted?: number };
    assert.equal(p.editsCompleted, 0, 'written even when 0');
  }
});

test('an implement job with a completed edit whose cwd vanished fails', async () => {
  const r = repo();
  const cwd = mkdtempSync(path.join(tmpdir(), 'agent-smith-cwd-'));
  const w = startIn(r, cwd, 'implement');
  w.onEvent({ kind: 'activity-start', at: now(), activity: { stepIndex: 0, tool: 'edit', input: JSON.stringify({ filePath: `${cwd}/a.ts` }) } });
  w.onEvent({ kind: 'activity-end', at: now(), activity: { stepIndex: 0, tool: 'edit' }, status: 'done' });
  rmSync(cwd, { recursive: true, force: true });
  await w.prepareFinish();
  const m = w.finish(result({ durationMs: 60_000 }), 'Implemented change.');
  assert.equal(m.status, 'failed');
  assert.equal(m.reason, 'working directory gone');
});

test('a cwd that is not a git repo marks changedFiles unknown rather than absent', async () => {
  const r = repo();
  const w = startIn(r, r, 'implement');
  await w.prepareFinish();
  const m = w.finish(result(), 'done');
  assert.equal(m.status, 'succeeded');
  assert.equal(m.changedFilesUnknown, true);
  assert.equal(m.cwdMissingAtFinish, undefined);
});

test('tool errors are counted in progress and the manifest, and do not fail the job', () => {
  const r = repo();
  const w = startIn(r, r, 'review');
  for (const step of [0, 1]) {
    w.onEvent({ kind: 'activity-start', at: now(), activity: { stepIndex: step, tool: 'read', input: '{"path":"missing"}' } });
    w.onEvent({ kind: 'activity-end', at: now(), activity: { stepIndex: step, tool: 'read' }, status: 'error' });
  }
  w.onEvent({ kind: 'activity-start', at: now(), activity: { stepIndex: 2, tool: 'read' } });
  w.onEvent({ kind: 'activity-end', at: now(), activity: { stepIndex: 2, tool: 'read' }, status: 'done' });
  const progress = JSON.parse(readFileSync(jobFile(r, w.jobId, FILES.progress), 'utf8')) as { toolErrors?: number };
  assert.equal(progress.toolErrors, 2);
  const m = w.finish(result({ durationMs: 60_000 }), '# Review\n\nfindings');
  assert.equal(m.status, 'succeeded');
  assert.equal(m.toolErrors, 2);
  assert.equal(m.toolCalls, 3);
});

test('latestSummary shows only the current message while running, and the END of the final response', () => {
  const r = repo();
  const w = startIn(r, r, 'review');
  w.onEvent({ kind: 'text', at: now(), stream: 'assistant', text: 'I am waiting for npm test to finish.' });
  w.onEvent({ kind: 'activity-start', at: now(), activity: { stepIndex: 0, tool: 'bash', input: 'npm test' } });
  w.onEvent({ kind: 'activity-end', at: now(), activity: { stepIndex: 0, tool: 'bash' }, status: 'done' });
  w.onEvent({ kind: 'text', at: now(), stream: 'assistant', text: 'Tests pass. ' });
  w.onEvent({ kind: 'text', at: now(), stream: 'assistant', text: 'Writing the report.' });
  assert.equal(w.snapshot()?.latestSummary, 'Tests pass. Writing the report.');

  const response = `# Findings\n\n${'Preamble sentence. '.repeat(80)}\n\n## Verdict\n\nShip it: no defects found.`;
  const m = w.finish(result({ response }), response);
  assert.ok((m.latestSummary ?? '').length <= 1_000);
  assert.equal(m.latestSummary, '## Verdict\n\nShip it: no defects found.');
  assert.equal(m.summarySource, 'worker');
});

test('summaryTail cuts at a paragraph, else a line, else raw', () => {
  assert.equal(summaryTail('short', 10), 'short');
  assert.equal(summaryTail('aaaa\n\nbbbb\n\ncc', 9), 'cc');
  assert.equal(summaryTail('aaaa\nbbbb', 7), 'bbbb');
  assert.equal(summaryTail('abcdefghij', 4), 'ghij');
});

test('a fast failure with no tool calls is marked failedEarly; a slow or busy one is not', () => {
  const r = repo();
  const early = startIn(r, r, 'review', 'review-smith-early001');
  early.onEvent({ kind: 'started', at: now(), conversationId: 'ses_1' });
  early.onEvent({ kind: 'notice', at: now(), level: 'error', message: 'Selected model is not supported in the selected location' });
  const m = early.finish(result({ ok: false, status: 'error', error: 'Selected model is not supported in the selected location', durationMs: 3_000, response: '' }), '');
  assert.equal(m.status, 'failed');
  assert.equal(m.failedEarly, true);
  assert.equal(m.error, 'Selected model is not supported in the selected location', 'provider text kept verbatim');

  // Slow, but the first thing it ever said was an error: still a route failure.
  const slow = startIn(r, r, 'review', 'review-smith-early002');
  slow.onEvent({ kind: 'notice', at: now(), level: 'error', message: 'HTTP 402: Insufficient account funds' });
  assert.equal(slow.finish(result({ ok: false, status: 'error', error: 'HTTP 402: Insufficient account funds', durationMs: 90_000, response: '' }), '').failedEarly, true);

  const worked = startIn(r, r, 'review', 'review-smith-early003');
  worked.onEvent({ kind: 'activity-start', at: now(), activity: { stepIndex: 0, tool: 'read' } });
  assert.equal(worked.finish(result({ ok: false, status: 'error', error: 'exited 1', durationMs: 3_000, response: '' }), '').failedEarly, undefined);

  const late = startIn(r, r, 'review', 'review-smith-early004');
  late.onEvent({ kind: 'text', at: now(), stream: 'assistant', text: 'thinking about it' });
  assert.equal(late.finish(result({ ok: false, status: 'error', error: 'exited 1', durationMs: 90_000, response: '' }), '').failedEarly, undefined);

  const timedOut = startIn(r, r, 'review', 'review-smith-early005');
  assert.equal(timedOut.finish(result({ ok: false, status: 'timeout', error: 'timed out', durationMs: 1_000, response: '' }), '').failedEarly, undefined);
});

/* ── liveness: the process owner's heartbeat ───────────────────────────────── */

test('a heartbeat records lastAliveAt and workerPid without moving lastEventAt, updatedAt or the timeline', async () => {
  const r = repo();
  const w = start(r);
  const t0 = new Date(Date.now() + 1_000).toISOString();
  w.onEvent({ kind: 'activity-start', at: t0, activity: { stepIndex: 1, tool: 'run_command', input: 'cargo test' } });
  const before = readManifest(r, w.jobId);
  const view = readFileSync(jobFile(r, w.jobId, FILES.view), 'utf8');
  const beat = new Date(Date.now() + 60_000).toISOString();
  w.onEvent({ kind: 'heartbeat', at: beat, pid: 4242 });
  const p = JSON.parse(readFileSync(jobFile(r, w.jobId, FILES.progress), 'utf8')) as Record<string, unknown>;
  assert.equal(p['lastAliveAt'], beat);
  assert.equal(p['workerPid'], 4242);
  assert.equal(p['lastEventAt'], t0, 'a heartbeat is not activity');
  assert.equal(readManifest(r, w.jobId).updatedAt, before.updatedAt);
  assert.equal(readFileSync(jobFile(r, w.jobId, FILES.view), 'utf8'), view, 'not in the timeline');
  // The next event keeps the heartbeat; the reader exposes it.
  const t1 = new Date(Date.now() + 90_000).toISOString();
  w.onEvent({ kind: 'activity-end', at: t1, activity: { stepIndex: 1, tool: 'run_command' }, status: 'done' });
  const after = JSON.parse(readFileSync(jobFile(r, w.jobId, FILES.progress), 'utf8')) as Record<string, unknown>;
  assert.equal(after['lastAliveAt'], beat);
  assert.equal(after['lastEventAt'], t1);
  const raw = await new AgentSmithReader().read(r, w.jobId);
  assert.equal(raw?.payload['last_alive_at'], beat);
  assert.equal(raw?.payload['workerPid'], 4242);
});

test('verdictFacts: the steer chain and finish read the same cwd rule', () => {
  const r = repo();
  const cwd = mkdtempSync(path.join(tmpdir(), 'agent-smith-cwd-'));
  const impl = startIn(r, cwd, 'implement');
  const review = startIn(r, cwd, 'review', 'review-smith-abcd1234');
  assert.deepEqual(impl.verdictFacts(), { cwdMissing: false, writing: true });
  assert.deepEqual(review.verdictFacts(), { cwdMissing: false, writing: false });
  rmSync(cwd, { recursive: true, force: true });
  assert.deepEqual(impl.verdictFacts(), { cwdMissing: true, writing: true });
  assert.deepEqual(review.verdictFacts(), { cwdMissing: true, writing: false });
});
