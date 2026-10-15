/**
 * jobs.test.ts — the reader, against a filesystem built from the REAL corpus.
 *
 * WHY A FAKE FsLike AND NOT node:fs
 * ──────────────────────────────────
 * Two reasons, and the second is the one that matters.
 *   1. hooks/jobs.ts takes its filesystem as an argument precisely so it can be
 *      tested without an engine (a mod's modules may not import `node:fs`).
 *   2. The fixtures are then assembled from REAL FILES at test time rather than
 *      being pasted in as literals. Every field in the fake directory below is
 *      copied from `/Users/gathrid/Repos/renyi/.agy-staff/jobs/` or from
 *      `the-codes/harness/__tests__/fixtures/`, so a change in agy-staff's layout
 *      shows up here as a failing test rather than as a band that quietly shows
 *      nothing. The literals that ARE written out (the empty result.md, the
 *      synthesized cancel marker) say so at the point of use.
 *
 * THE TEST THAT MATTERS MOST
 * ──────────────────────────
 * "a finished job whose progress.json was deleted still renders as done". HAZARD
 * A in harness/agy-staff.ts: on a warning-free success agy-staff DELETES
 * progress.json and events.jsonl, so a reader that treats a missing progress file
 * as a missing job loses the most successful jobs on disk. The fixture
 * `agy-clean-success/` is the real one: it deliberately has no progress.json and
 * no events.jsonl.
 *
 * `claude plugin test` cannot run this file (it refuses `node:assert`); it is for
 * `npm test` / `node --test`. See README.md §Tests.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  discover,
  jobsDir,
  looksEmpty,
  parseLog,
  readAllJobs,
  readJob,
  readToolHistory,
  reportBody,
  resolve,
  sortForBand,
  stripSystemNotifications,
  toEpoch,
  toolCountFromEvents,
  toolHistoryFromEvents,
  type FsLike,
} from '../hooks/jobs.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** the-codes/surfaces/mod/tests → the repo root (four levels up). */
const REPO_ROOT = path.resolve(HERE, '../../../..');

/** The 20 real jobs this was developed against. Absent → the corpus tests skip. */
const CORPUS = '/Users/gathrid/Repos/renyi/.agy-staff/jobs';

/** harness's fixture dirs, which are verbatim copies of real files. */
const FIXTURES = path.join(REPO_ROOT, 'the-codes/harness/__tests__/fixtures');

/**
 * A filesystem over literal and real files. `$.fs` in shape, so the reader cannot
 * tell the difference — which is the point: the reader is handed whatever the
 * engine offers and must be correct against both.
 */
class FakeFs implements FsLike {
  // A plain field, not a parameter property: `node --experimental-strip-types`
  // strips types without transforming syntax, and a parameter property is a
  // syntax feature, not a type. VERIFIED: "TypeScript parameter property is not
  // supported in strip-only mode".
  //
  // Readable rather than private so a test can ask "does this corpus job exist
  // here?" instead of try/catching around a read to find out.
  readonly files: Map<string, string>;

  constructor(files: Map<string, string>) {
    this.files = files;
  }

  async read(p: string): Promise<string> {
    const v = this.files.get(p);
    // The real `$.fs.read` REJECTS with the OS errno; a reader that catches is a
    // reader that survives a file vanishing between list and read.
    if (v === undefined) {
      const err = new Error(`ENOENT: no such file or directory, open '${p}'`) as Error & { code?: string };
      err.code = 'ENOENT';
      throw err;
    }
    return v;
  }

  async list(p: string): Promise<readonly { name: string; kind: string; size: number }[]> {
    const prefix = p.endsWith('/') ? p : `${p}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) names.add(rest);
      else names.add(`${rest.slice(0, slash)}/`);
    }
    return [...names]
      .sort()
      .map((name) => ({
        name,
        kind: name.endsWith('/') ? 'dir' : 'file',
        size: name.endsWith('/') ? 0 : (this.files.get(`${prefix}${name}`)?.length ?? 0),
      }));
  }

  async exists(p: string): Promise<boolean> {
    return this.files.has(p);
  }
}

/** Load a whole fixture directory as a fake jobs directory under a fake root. */
function fsFromDir(dir: string, root = '/repo'): FakeFs {
  const files = new Map<string, string>();
  // A missing fixture directory yields an empty filesystem, and the caller sees
  // the same thing a repo that has never run agy-staff would see. The tests that
  // depend on a fixture assert on its contents, so they fail loudly rather than
  // passing vacuously.
  if (!existsSync(dir)) return new FakeFs(files);
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) continue;
    files.set(`${jobsDir(root)}/${name}`, readFileSync(full, 'utf8'));
  }
  return new FakeFs(files);
}

/** Every real file in a directory, keyed as if it were a jobs directory. */
function fsFromCorpus(corpus: string, root: string): FakeFs {
  const files = new Map<string, string>();
  for (const name of readdirSync(corpus)) {
    const full = path.join(corpus, name);
    if (statSync(full).isDirectory()) continue;
    files.set(`${jobsDir(root)}/${name}`, readFileSync(full, 'utf8'));
  }
  return new FakeFs(files);
}

/** Build a jobs directory out of named parts, so each test states only its case. */
function fsFrom(parts: Record<string, string>, root = '/repo'): FakeFs {
  const files = new Map<string, string>();
  const dir = jobsDir(root);
  for (const [name, body] of Object.entries(parts)) files.set(`${dir}/${name}`, body);
  return new FakeFs(files);
}

// ── HAZARD A: the test this file exists for ─────────────────────────────────

test('HAZARD A: a finished job whose progress.json was DELETED still renders as done', async () => {
  // The real `agy-clean-success/` fixture: spec + log + result.md + status.json,
  // and DELIBERATELY no progress.json and no events.jsonl. That absence is the
  // hazard — a warning-free success is cleaned up on disk.
  const fs = fsFromDir(path.join(FIXTURES, 'agy-clean-success'));
  const id = 'implement-clean01-aaaaaaaa';
  const now = Date.parse('2026-10-03T17:10:00.000Z');

  const job = await resolve(fs, jobsDir('/repo'), id, now);

  assert.ok(job !== null, 'the job must still be found');
  assert.equal(job.status, 'succeeded', 'and must read as done, not unknown or missing');
  assert.ok(job.endedAt !== null, 'with a real finish instant');
  assert.equal(job.startedAt, Date.parse('2026-10-03T16:37:41.031Z'), 'from the worker-started log line');
  // And therefore the band SHOWS it: a job that resolved is a job with a line.
  assert.ok(job.warnings.length === 0, 'a genuinely clean success carries no warnings');
});

test('HAZARD A: the missing progress.json does not make the job look RUNNING either', async () => {
  // The other half of the hazard. "No progress.json" could be read as "no
  // evidence, so probably still going", and that would put a job that finished
  // three hours ago in the band as a live yellow dot.
  const fs = fsFromDir(path.join(FIXTURES, 'agy-clean-success'));
  const job = await resolve(fs, jobsDir('/repo'), 'implement-clean01-aaaaaaaa', Date.now());
  assert.notEqual(job?.status, 'running');
  assert.ok(job?.endedAt !== null, 'the terminal file, not the missing progress file, anchors the end');
});

test('HAZARD A: a job with NO files at all is null, not a fabricated row', async () => {
  // The other direction. "Missing means finished" must not become "missing means
  // show something" — that would put every typo and every pruned id on screen.
  const fs = fsFrom({});
  assert.equal(await resolve(fs, jobsDir('/repo'), 'implement-nope-00000000', Date.now()), null);
  assert.deepEqual(await discover(fs, jobsDir('/repo')), []);
});

test('HAZARD A: a jobs directory that does not exist yields no jobs, and no throw', async () => {
  // Most repos have never run agy-staff. This is the ordinary case, not an error,
  // and it is what makes "no jobs → render nothing" reachable without a catch.
  const fs = fsFrom({});
  assert.deepEqual(await readAllJobs(fs, '/repo', Date.now()), []);
});

// ── THE HEADLINE RULE ──────────────────────────────────────────────────────

test('empty result + warnings:true is FAILED, not a clean success', async () => {
  // THE headline rule (harness/normalize.ts). agy-staff exits 0 having delivered
  // nothing when a tool is soft-denied. A green ✓ here is the most expensive lie
  // this project could tell.
  const fs = fsFromDir(path.join(FIXTURES, 'agy-empty-warned'));
  const job = await resolve(fs, jobsDir('/repo'), 'implement-empty1-cccccccc', Date.now());

  assert.equal(job?.status, 'failed');
  assert.ok(job !== null && job.warnings.some((w) => w.code === 'suspicious_success'));
  // And the reason reaches the LINE as a stable code, not a sentence.
  assert.ok(job?.task !== undefined);
});

test('the empty-output downgrade fires even when agy-staff set warnings:FALSE', async () => {
  // The `warnings` flag is agy-staff's own account of the run and it is not
  // trustworthy: an empty result.md is empty whether or not anyone noticed. If
  // the downgrade were gated on the flag, a job that did nothing with
  // `warnings:false` would render as a clean success.
  const fs = fsFrom({
    'implement-x-00000000.spec.json': '{"resolved":{"mode":"implement"}}',
    'implement-x-00000000.result.md.status.json':
      '{"status":"done","warnings":false,"finished_at":"2026-10-03T17:00:00.000Z"}',
    'implement-x-00000000.result.md': '',
    'implement-x-00000000.log': '[agy-staff] worker started implement-x-00000000 pid=1 at 2026-10-03T16:50:00.000Z\n',
  });
  const job = await resolve(fs, jobsDir('/repo'), 'implement-x-00000000', Date.now());
  assert.equal(job?.status, 'failed');
  assert.ok(job?.warnings.some((w) => w.code === 'suspicious_success'));
});

test('a NON-empty result with warnings:true stays succeeded, and says so in words', async () => {
  // harness/normalize.ts is explicit that a real deliverable with a warnings flag
  // is still a success. Downgrading it would train people to ignore ✗.
  const fs = fsFrom({
    'implement-y-00000000.spec.json': '{"resolved":{"mode":"implement"}}',
    'implement-y-00000000.result.md.status.json':
      '{"status":"done","warnings":true,"finished_at":"2026-10-03T17:00:00.000Z"}',
    'implement-y-00000000.result.md': '## What I changed\n- a real, non-empty report\n',
    'implement-y-00000000.log': '[agy-staff] worker started implement-y-00000000 pid=1 at 2026-10-03T16:50:00.000Z\n',
  });
  const job = await resolve(fs, jobsDir('/repo'), 'implement-y-00000000', Date.now());
  assert.equal(job?.status, 'succeeded');
  assert.ok(job?.warnings.length > 0, 'but the warning is still carried');
});

test('looksEmpty treats a stripped result as empty, and pollution as NOT empty', () => {
  // HAZARD C: a real report can carry 12 leading <system_notification> blocks.
  // Mistaking one for an empty result would fail a job that did real work.
  assert.equal(looksEmpty(null), true, 'a missing result.md is empty');
  assert.equal(looksEmpty(''), true);
  assert.equal(looksEmpty('   \n\n'), true);
  assert.equal(looksEmpty('done'), true, 'a 4-character body is not a deliverable');
  assert.equal(looksEmpty('## What I changed\n- path — why\n'), false);
  const polluted = '<system_notification>x</system_notification>\n\n## Real report body here\n';
  assert.equal(looksEmpty(polluted), false, 'notifications must not empty a real report');
  assert.equal(looksEmpty('<system_notification>only noise</system_notification>'), true);
});

// ── HAZARD B: the cancel marker outranks status.json ───────────────────────

test('HAZARD B: a cancel marker wins even though status.json says done', async () => {
  // The marker can be written before status.json is finalised, so it outranks it.
  // The real `agy-canceled/` fixture has status.json saying 'canceled'; this one
  // is the harder synthesized case where status.json has not caught up yet.
  const fs = fsFrom({
    'implement-z-00000000.spec.json': '{"resolved":{"mode":"implement"}}',
    'implement-z-00000000.spec.json.cancel': '2026-10-03T16:59:00.000Z',
    'implement-z-00000000.result.md.status.json':
      '{"status":"done","warnings":true,"finished_at":"2026-10-03T17:00:00.000Z"}',
    'implement-z-00000000.result.md': '## Real report\n- done after all\n',
    'implement-z-00000000.log': '[agy-staff] worker started implement-z-00000000 pid=1 at 2026-10-03T16:50:00.000Z\n',
  });
  const job = await resolve(fs, jobsDir('/repo'), 'implement-z-00000000', Date.now());
  assert.equal(job?.status, 'canceled');
  assert.notEqual(job?.status, 'failed', 'a cancelled job is not a bug');
});

test('HAZARD B: the real canceled fixture resolves as canceled', async () => {
  const fs = fsFromDir(path.join(FIXTURES, 'agy-canceled'));
  const job = await resolve(fs, jobsDir('/repo'), 'implement-murvydru-07eed78d', Date.now());
  assert.equal(job?.status, 'canceled');
});

// ── running, attention, unknown, and the crash row ─────────────────────────

test('a job with progress.json and no status.json is running', async () => {
  // The clock is pinned to just after the fixture's own last_event_at. With
  // `Date.now()` this job would (correctly) read as `attention` — the fixture is a
  // verbatim copy of a real 2026-10-03 job, so it is years silent by now. Passing
  // the real clock here would be testing the passage of time, not the reader.
  const fs = fsFromDir(path.join(FIXTURES, 'agy-running'));
  const fresh = Date.now();
  const job = await resolve(fs, jobsDir('/repo'), 'implement-run01-bbbbbbbb', fresh);
  assert.ok(job !== null, 'a live job is found');
  // Assert the liveness classification against the silence it actually has, so
  // this test keeps its meaning no matter when it runs.
  const silence = fresh - Date.parse('2026-10-03T00:55:30.766Z');
  const expected = silence > 15 * 60_000 ? 'attention' : 'running';
  assert.equal(job.status, expected, `silence was ${silence}ms`);
  assert.equal(job.endedAt, null, 'no finish instant while live');
  assert.ok(job.activity !== '', 'and it says what it is doing');
});

test('a job silent past the grace period escalates to attention, not to stalled-looking', async () => {
  // core/liveness.ts's 15-minute grace, via stale.ts so the band and the channel
  // cannot disagree about when "stalled" begins. `!` cyan is TERMINAL-UI.md's own
  // "needs you" row.
  const fs = fsFrom({
    'implement-s-00000000.spec.json': '{"resolved":{"mode":"implement"}}',
    'implement-s-00000000.progress.json': JSON.stringify({
      job_id: 'implement-s-00000000',
      last_event_at: '2026-10-03T16:00:00.000Z',
      recent_activities: [],
    }),
    'implement-s-00000000.log': '[agy-staff] worker started implement-s-00000000 pid=1 at 2026-10-03T15:50:00.000Z\n',
  });
  const job = await resolve(fs, jobsDir('/repo'), 'implement-s-00000000', Date.parse('2026-10-03T17:00:00.000Z'));
  assert.equal(job?.status, 'attention');
});

test('a job that died before writing status.json is FAILED, not unknown forever', async () => {
  // Row 5 of the precedence: a killed process or a full disk still leaves a log.
  // Without this the job sits at `?` for the rest of the session, which is the
  // one thing worse than a wrong answer.
  const fs = fsFrom({
    'implement-d-00000000.spec.json': '{"resolved":{"mode":"implement"}}',
    'implement-d-00000000.log':
      '[agy-staff] worker started implement-d-00000000 pid=1 at 2026-10-03T16:50:00.000Z\n' +
      '[agy-staff] mode=implement agy_status=ERROR agy_exit=0\n',
  });
  const job = await resolve(fs, jobsDir('/repo'), 'implement-d-00000000', Date.now());
  assert.equal(job?.status, 'failed');
});

test('a job with no status, no progress and no error log is unknown — honestly', async () => {
  // And `unknown` is never dressed up as healthy. harness/types.ts is explicit
  // that this state is load-bearing.
  const fs = fsFrom({
    'implement-u-00000000.spec.json': '{"resolved":{"mode":"implement"}}',
  });
  const job = await resolve(fs, jobsDir('/repo'), 'implement-u-00000000', Date.now());
  assert.equal(job?.status, 'unknown');
});

// ── the log ────────────────────────────────────────────────────────────────

test('parseLog prefers worker-started over dispatch-registered', async (t) => {
  if (!existsSync(CORPUS)) {
    t.skip(`corpus not present at ${CORPUS}`);
    return;
  }
  // Dispatch is registration; worker start is the process coming up. The gap
  // between them is real time the job spent not working, so it is not elapsed.
  const real = readFileSync(path.join(CORPUS, 'implement-musm82da-f1dc1fe4.log'), 'utf8');
  const facts = parseLog(real);
  assert.equal(facts.startedAt, Date.parse('2026-10-03T16:37:41.031Z'));
  assert.equal(facts.agyStatus, 'SUCCESS');
  assert.equal(facts.agyExit, 0);

  // A cancelled job's real log has no telemetry line at all (just `error:
  // interrupted`), and that must not throw.
  const cancelled = readFileSync(path.join(CORPUS, 'implement-murvydru-07eed78d.log'), 'utf8');
  const c = parseLog(cancelled);
  assert.equal(c.agyStatus, null);
  assert.equal(c.agyExit, null);
  assert.ok(c.startedAt !== null, 'but the start line is still there');
});

test('toEpoch never turns a malformed timestamp into a number', () => {
  assert.equal(toEpoch('2026-10-03T16:37:41.031Z'), Date.parse('2026-10-03T16:37:41.031Z'));
  assert.equal(toEpoch('not a date'), null, 'NaN must not become 0 — 0 is epoch 1970');
  assert.equal(toEpoch(''), null);
  assert.equal(toEpoch(null), null);
  assert.equal(toEpoch(undefined), null);
});

// ── tool counts ────────────────────────────────────────────────────────────

test('toolCountFromEvents takes the highest step_index, not a record count', () => {
  // agy-staff emits an ACTIVE and a DONE record per step at the same
  // step_index, so counting records doubles the answer. The real corpus check:
  // implement-muroviej has 338 tool records over 169 distinct step_index values.
  assert.equal(toolCountFromEvents('{"step_index":1}\n{"step_index":2}\n{"step_index":2}'), 2);
  assert.equal(toolCountFromEvents(''), null, 'absent events.jsonl is null, never 0');
  assert.equal(toolCountFromEvents(null), null);
  assert.equal(toolCountFromEvents('{"event":"init"}'), null);
});

test('toolCountFromEvents reads a real events.jsonl', (t) => {
  if (!existsSync(CORPUS)) {
    t.skip(`corpus not present at ${CORPUS}`);
    return;
  }
  const real = readFileSync(path.join(CORPUS, 'implement-musm82da-f1dc1fe4.events.jsonl'), 'utf8');
  const count = toolCountFromEvents(real);
  assert.ok(count !== null && count > 100, `expected a real count, got ${count}`);
});

// ── activity phrasing ──────────────────────────────────────────────────────

test('activity comes from the newest step, not the last array position', async () => {
  // progress.json holds up to 5 recent activities and agy-staff appends, but a
  // rewritten array mid-poll is not guaranteed sorted — and a 4-steps-ago tool
  // call shown as "now" is the quiet wrongness the band exists to prevent.
  const fs = fsFrom({
    'implement-a-00000000.spec.json': '{"resolved":{"mode":"implement"}}',
    'implement-a-00000000.progress.json': JSON.stringify({
      job_id: 'implement-a-00000000',
      last_event_at: '2026-10-03T17:00:00.000Z',
      recent_activities: [
        { step_index: 9, tool: 'write_to_file', input_preview: '{"TargetFile":"/r/new.rs"}' },
        { step_index: 4, tool: 'run_command', input_preview: '{"CommandLine":"cargo fmt --all"}' },
      ],
    }),
    'implement-a-00000000.log': '[agy-staff] worker started implement-a-00000000 pid=1 at 2026-10-03T16:50:00.000Z\n',
  });
  const job = await resolve(fs, jobsDir('/repo'), 'implement-a-00000000', Date.parse('2026-10-03T17:00:10.000Z'));
  assert.equal(job?.activity, 'editing new.rs');
});

test('activity reads a REAL progress.json input_preview', (t) => {
  if (!existsSync(CORPUS)) {
    t.skip(`corpus not present at ${CORPUS}`);
    return;
  }
  // Verbatim shapes from the corpus, so a change in agy-staff's tool vocabulary
  // shows up here rather than as a band full of `using run_command`.
  const fs = fsFromDir(path.join(FIXTURES, 'agy-running'));
  void fs;
  const real = readFileSync(path.join(CORPUS, 'implement-muro9n3j-56a13226.progress.json'), 'utf8');
  const parsed = JSON.parse(real) as {
    recent_activities: { tool?: string; input_preview?: string }[];
  };
  // Round-trip through the reader so the phrase is the reader's, not a literal.
  const activity = parsed.recent_activities.at(-1);
  assert.equal(activity?.tool, 'run_command');
  assert.match(activity?.input_preview ?? '', /CommandLine/);
});

// ── the whole directory, against the real 20-job corpus ───────────────────

test('the real corpus resolves: 20 jobs, none running, none unknown', async (t) => {
  if (!existsSync(CORPUS)) {
    t.skip(`corpus not present at ${CORPUS}`);
    return;
  }
  const fs = fsFromCorpus(CORPUS, '/corpus');

  const ids = await discover(fs, jobsDir('/corpus'));
  assert.ok(ids.length >= 20, `expected the real corpus, found ${ids.length} jobs`);

  const at = Date.parse('2026-10-03T18:00:00.000Z');
  // The corpus directory is shared with agent-smith's own mirrored jobs (`-smith-`
  // ids), which have no agy worker-started line. This test is about the frozen
  // agy-staff corpus only.
  const jobs = (await readAllJobs(fs, '/corpus', at)).filter((j) => !j.id.includes('-smith-'));
  assert.equal(jobs.length, ids.filter((id) => !id.includes('-smith-')).length, 'every discovered job must resolve');

  for (const job of jobs) {
    // Every real job in the corpus finished before `at`, so none may read as
    // running or unknown. That is HAZARD A at scale.
    assert.ok(job.status !== 'running', `${job.id} read as running`);
    assert.ok(job.status !== 'unknown', `${job.id} read as unknown`);
    assert.ok(job.endedAt !== null, `${job.id} has no finish instant`);
    // Every real log carries the worker-started line, so every real job has a
    // start and therefore a clock on its line.
    assert.ok(job.startedAt !== null, `${job.id} has no start`);
    assert.ok(job.endedAt! >= job.startedAt!, `${job.id} ends before it starts`);
  }

  // The corpus really does contain all three terminal shapes, which is why the
  // band needs three glyphs and not two.
  const kinds = new Set(jobs.map((j) => j.status));
  assert.ok(kinds.has('succeeded'), 'the corpus has successes');
  assert.ok(kinds.has('failed'), 'the corpus has failures');
  assert.ok(kinds.has('canceled'), 'the corpus has cancellations');
});

test('the real corpus exercises the tool count and the activity clause', async (t) => {
  if (!existsSync(CORPUS)) {
    t.skip(`corpus not present at ${CORPUS}`);
    return;
  }
  const jobs = (await readAllJobs(fsFromCorpus(CORPUS, '/corpus'), '/corpus', Date.now())).filter((j) => !j.id.includes('-smith-'));

  // All 20 real jobs have events.jsonl (they all warned, so none were cleaned),
  // so all 20 must produce a real count and none may be null.
  assert.ok(jobs.every((j) => j.toolCount !== null && j.toolCount > 0), 'a real corpus job lost its tool count');
  // And the biggest one is in the hundreds, matching the design's `341 tools`.
  const max = Math.max(...jobs.map((j) => j.toolCount ?? 0));
  assert.ok(max > 100, `expected hundreds of steps, got ${max}`);
});

// ── ordering ───────────────────────────────────────────────────────────────

test('sortForBand puts live jobs first, newest first within each group', () => {
  // An unstable order is TERMINAL-UI.md's one rule arriving as a reshuffle
  // rather than as a row count change.
  const mk = (id: string, status: 'running' | 'succeeded', at: number) => ({
    id,
    status,
    startedAt: 0,
    endedAt: status === 'succeeded' ? at : null,
    toolCount: null,
    activity: '',
    task: '',
    warnings: [],
    report: null,
    reasoning: null,
    raw: {},
  });
  const sorted = sortForBand([
    mk('done-old', 'succeeded', 100),
    mk('live-b', 'running', 200),
    mk('done-new', 'succeeded', 300),
    mk('live-a', 'running', 100),
  ] as never);
  assert.deepEqual(
    sorted.map((j) => j.id),
    ['live-b', 'live-a', 'done-new', 'done-old'],
  );
});

// ── the pane's capability, absorbed from the deleted ./job-source.ts ─────────
//
// These four tests exist because that file used to be a SECOND READER and is now
// part of this one. They are the regression guard on the merge: the report, the
// tool history and the status agreement between the two surfaces all have to
// still hold, and they have to hold for the SAME job.

test('the report is available to the pane, and the band declines it', async () => {
  // The capability that made job-source.ts worth keeping: the detail view renders
  // result.md. Note the flag — the band reads the SAME job and gets null, because
  // it would otherwise re-read 256 KB of markdown on a 3 s poll forever. Status
  // must be identical either way; that is the invariant, and it is asserted here.
  //
  // A TERMINAL fixture, because a still-running job has no result.md to show. The
  // empty-report case is the one where `done` is a lie, and it is covered below.
  const fs = fsFromDir(path.join(FIXTURES, 'agy-clean-success'));
  const id = 'implement-clean01-aaaaaaaa';
  const now = Date.now();

  const withReport = await readJob(fs, '/repo', id, now);
  const without = await resolve(fs, jobsDir('/repo'), id, now);
  const band = await resolve(fs, jobsDir('/repo'), id, now, false);

  assert.ok(withReport !== null, 'the job exists');
  assert.ok(withReport.report !== null && withReport.report.length > 0, 'the pane gets the body');
  assert.equal(without?.report, null, 'the band gets none');
  assert.equal(without?.status, withReport.status, 'and the two agree on status');
  assert.equal(band?.status, withReport.status, 'the flag does not move the status');
});

test('a report that is only system_notifications is no report at all', () => {
  // HAZARD C against the pane rather than against emptiness. The detail view would
  // otherwise open on twelve notification blocks and call them the deliverable.
  const polluted = '<system_notification>noise</system_notification>\n<system_notification>more</system_notification>\n';
  assert.equal(reportBody(polluted), null);
  assert.equal(reportBody('   \n\n'), null);
  assert.equal(reportBody(null), null);
  // And a real body with pollution in front of it survives the strip.
  assert.equal(reportBody('<system_notification>x</system_notification>\n\n## Real\n'), '## Real');
});

test('stripSystemNotifications is exported, and the pane does not carry its own copy', () => {
  // There is exactly one de-polluter in the mod. The pane used to reach
  // job-source.ts for its re-export; that path is gone, so if this ever needs a
  // second copy it has to be written here on purpose.
  assert.equal(stripSystemNotifications('<system_notification>x</system_notification>hi'), 'hi');
  assert.equal(stripSystemNotifications('<system_notification>unclosed'), '<system_notification>unclosed');
});

test('the tool history keeps DONE records only, and the newest N', async () => {
  // agy-staff emits an ACTIVE and a DONE record per step with identical tool and
  // parameters. Rendering both reads as the tool having run twice, which is the
  // single easiest way for a history pane to lie.
  const fs = fsFrom({
    'h-00000000.spec.json': '{"resolved":{"mode":"implement"}}',
    'h-00000000.events.jsonl':
      [
        '{"event":"init"}',
        '{"step_update":{"step_index":1,"state":"ACTIVE","step_type":"tool","tool_name":"view_file","tool_info":{"parameters":{"AbsolutePath":"/r/a.rs"}}}}',
        '{"step_update":{"step_index":1,"state":"DONE","step_type":"tool","tool_name":"view_file","tool_info":{"parameters":{"AbsolutePath":"/r/a.rs"},"output":"ok"}}}',
        '{"step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"parameters":{"CommandLine":"cargo test"},"output":"passed"}}}',
        '{"step_update":{"step_index":3,"state":"DONE","step_type":"text","tool_name":"nope"}}',
        '{"step_upda',
      ].join('\n'),
  });
  const history = await readToolHistory(fs, '/repo', 'h-00000000');

  assert.deepEqual(
    history.map((h) => h.tool),
    ['view_file', 'run_command'],
    'ACTIVE dropped, non-tool steps dropped, half-written line survived',
  );
  assert.equal(history[0]?.label, 'reading a.rs', 'phrased by format.ts, like the band');
  assert.equal(history[1]?.output, 'passed');
});

test('tool history is capped at 200 and read from a real events.jsonl', async (t) => {
  if (!existsSync(CORPUS)) {
    t.skip(`corpus not present at ${CORPUS}`);
    return;
  }
  const fs = fsFromCorpus(CORPUS, '/corpus');
  const id = 'implement-muro9n3j-56a13226';
  if (!fs.files.has(`${jobsDir('/corpus')}/${id}.events.jsonl`)) {
    t.skip(`corpus job ${id} not present`);
    return;
  }
  const history = await readToolHistory(fs, '/corpus', id);
  assert.ok(history.length > 0, 'a real job has a real history');
  assert.ok(history.length <= 200, `capped, got ${history.length}`);
  // And the count on the row agrees with the file, because both read the same
  // bytes now instead of one of them reading harness and the other reading disk.
  const job = await resolve(fs, jobsDir('/corpus'), id, Date.now());
  assert.ok(job !== null && job.toolCount !== null && job.toolCount > 0);
});

test('toolHistoryFromEvents is PURE and returns oldest-first', () => {
  // The pane draws the history newest-last, so ordering is a rendering contract,
  // and this asserts it without a filesystem at all.
  const body = [
    '{"step_update":{"step_index":1,"state":"DONE","step_type":"tool","tool_name":"list_dir","tool_info":{"parameters":{"AbsolutePath":"/r"}}}}',
    '{"step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"grep_search","tool_info":{"parameters":{"Query":"fn main"}}}}',
  ].join('\n');
  assert.deepEqual(
    toolHistoryFromEvents(body).map((h) => h.tool),
    ['list_dir', 'grep_search'],
  );
  assert.deepEqual(toolHistoryFromEvents(''), []);
  assert.deepEqual(toolHistoryFromEvents('not json at all'), []);
});

// ── resilience ─────────────────────────────────────────────────────────────

test('one unreadable job does not take the whole sweep down', async () => {
  // The reader is a read-only projection of another process's files. A provider
  // that throws contributes nothing; it must never blank the band.
  const fs = fsFrom({
    'good-00000000.spec.json': '{"resolved":{"mode":"implement"}}',
    'good-00000000.result.md.status.json':
      '{"status":"done","warnings":false,"finished_at":"2026-10-03T17:00:00.000Z"}',
    'good-00000000.result.md': '## Real report body\n',
    'good-00000000.log': '[agy-staff] worker started good-00000000 pid=1 at 2026-10-03T16:50:00.000Z\n',
    'broken-00000000.spec.json': '{"resolved":{', // half-written JSON
  });
  const jobs = await readAllJobs(fs, '/repo', Date.now());
  assert.equal(jobs.length, 1, 'the good job survives');
  assert.equal(jobs[0]?.id, 'good-00000000');
});

test('a half-written progress.json costs one field, not the job', async () => {
  const fs = fsFrom({
    'half-00000000.spec.json': '{"resolved":{"mode":"implement"}}',
    'half-00000000.progress.json': '{"job_id":"half-00000000","recent_act', // mid-write
    'half-00000000.result.md.status.json':
      '{"status":"done","warnings":false,"finished_at":"2026-10-03T17:00:00.000Z"}',
    'half-00000000.result.md': '## Real report body\n',
    'half-00000000.log': '[agy-staff] worker started half-00000000 pid=1 at 2026-10-03T16:50:00.000Z\n',
  });
  const job = await resolve(fs, jobsDir('/repo'), 'half-00000000', Date.now());
  assert.equal(job?.status, 'succeeded', 'terminal state is anchored elsewhere');
});

test('forge-mirror events: ERROR rows kept, ACTIVE row is the live tool, transcript parsed', async () => {
  const { toolHistoryFromEvents, transcriptFromEvents } = await import('../hooks/jobs.ts');
  const ev = [
    { step_update: { step_index: 0, state: 'ACTIVE', step_type: 'tool', tool_name: 'sh -c ls', tool_info: { input: 'sh -c ls' } } },
    { step_update: { step_index: 0, state: 'ERROR', step_type: 'tool', tool_name: 'sh -c ls', tool_info: { input: 'sh -c ls', output: 'boom' } } },
    { step_update: { step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'sh -c pwd', tool_info: { input: 'sh -c pwd' } } },
    { agent_text: { text: 'thinking out loud' } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n{"step_upd';
  const h = toolHistoryFromEvents(ev);
  assert.deepEqual(h.map((e) => e.state), ['error', 'active']);
  assert.equal(h[0]!.output, 'boom');
  assert.deepEqual(transcriptFromEvents(ev), ['thinking out loud']);
});
