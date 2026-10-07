/**
 * band.test.ts — the BAND's pure logic, under the repo's own test runner.
 *
 * WHY `node --test` AND NOT `claude plugin test`
 * ───────────────────────────────────────────────
 * `claude plugin test` refuses `node:assert` and `node:test` (VERIFIED: "cannot
 * import "node:assert/strict" … a hooks module imports its own files by relative
 * path and "claude-code", nothing else"). The repo's `npm test` runs
 * `node --test --experimental-strip-types`, which is the runner that can see
 * these modules. Both runners are worth having: this one tests the RULES, and
 * `claude plugin test` tests that the module LOADS in the real engine.
 *
 * WHY THESE FUNCTIONS ARE IN A SEPARATE MODULE AT ALL
 * ──────────────────────────────────────────────────
 * Node's type stripping has no JSX transform, so ANY .tsx import is a hard parse
 * error under `node --test`. Logic living in register.tsx would therefore be
 * untestable, which defeats the point of making it pure. hooks/band.ts and
 * hooks/jobs.ts import no `claude-code` and no `node:` builtin, so they load
 * here; register.tsx only lays out what they return.
 *
 * Test names cite the rule being enforced and, where the rule came from measured
 * data, the evidence. A test asserting a magic string with no provenance is how
 * the next engineer "fixes" a deliberate decision by accident.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ELAPSED_WIDTH } from '../hooks/format.ts';
import {
  BAND_ROWS,
  TICK_CUSHION_MS,
  LINGER_MS,
  buildLine,
  elapsedCell,
  isShown,
  isTerminal,
  noColor,
  overflowLine,
  pickColor,
  pickGlyph,
  reconcile,
  rowBudget,
} from '../hooks/band.ts';
import type { RadarJob, RadarStatus } from '../types/index.d.ts';

// ── a job builder, so each test states only what it is about ────────────────

let seq = 0;
function job(over: Partial<RadarJob> = {}): RadarJob {
  seq += 1;
  return {
    id: `implement-job${seq}`,
    status: 'running',
    startedAt: 0,
    endedAt: null,
    toolCount: null,
    activity: '',
    task: '',
    warnings: [],
    report: null,
    reasoning: null,
    raw: {},
    ...over,
  };
}

// ── glyphs: colour is never the only channel ────────────────────────────────

test('every status has a distinct single-width glyph, so colour is never alone', () => {
  const statuses: RadarStatus[] = [
    'running',
    'succeeded',
    'failed',
    'attention',
    'canceled',
    'unknown',
  ];
  const glyphs = statuses.map(pickGlyph);

  for (const g of glyphs) {
    // TERMINAL-UI.md L94-118: the failure that motivates the rule is that `⏳`
    // and `✅` render DOUBLE-WIDTH and silently break every column after them,
    // which is what the shipped review-watch mod does. The check is on the code
    // point rather than on a list someone might extend.
    assert.ok(!/\p{Extended_Pictographic}/u.test(g), `${g} is emoji and may be double-width`);
    assert.equal([...g].length, 1, `${g} is not a single code point`);
    assert.ok((g.codePointAt(0) ?? 0) <= 0xffff, `${g} is outside the BMP`);
  }

  // Two states sharing a glyph would be two states a monochrome terminal cannot
  // tell apart, which is the whole point of drawing one.
  assert.equal(new Set(glyphs).size, statuses.length, 'two states share a glyph');
});

test('running/done/failed are ● ✓ ✗ — the set TERMINAL-UI.md blesses', () => {
  assert.equal(pickGlyph('running'), '●');
  assert.equal(pickGlyph('succeeded'), '✓');
  assert.equal(pickGlyph('failed'), '✗');
});

test('canceled is NOT ✗: a cancelled job is not a bug', () => {
  // core/types.ts: "'cancelled' is distinct from 'failed' on purpose: a
  // cancelled job is not a bug, and an alert on one trains people to ignore
  // alerts." Painting it with the failure glyph contradicts that contract.
  assert.notEqual(pickGlyph('canceled'), pickGlyph('failed'));
  assert.equal(pickColor('canceled'), undefined, 'and it must not be red');
});

test('unknown is neither healthy-looking nor failure-looking', () => {
  // harness/types.ts: "`unknown` is load-bearing, NOT a cop-out… never collapse
  // this." So it gets its own glyph and no colour — never the ✓ of a success and
  // never the ✗ of a failure.
  assert.notEqual(pickGlyph('unknown'), pickGlyph('succeeded'));
  assert.notEqual(pickGlyph('unknown'), pickGlyph('failed'));
  assert.equal(pickColor('unknown'), undefined);
});

test('colours follow the fixed convention: yellow running, green done, red failed', () => {
  // TERMINAL-UI.md L80-82: git, cargo, pytest and CI all agree; do not invent a
  // local convention.
  assert.equal(pickColor('running'), 'yellow');
  assert.equal(pickColor('succeeded'), 'green');
  assert.equal(pickColor('failed'), 'red');
  // Every coloured state also has a glyph, so colour is decoration on a decision
  // already made without it.
  for (const s of ['running', 'succeeded', 'failed', 'attention'] as RadarStatus[]) {
    assert.ok(pickGlyph(s).length > 0);
  }
});

test('isTerminal covers exactly the three over states', () => {
  for (const s of ['succeeded', 'failed', 'canceled'] as RadarStatus[]) {
    assert.equal(isTerminal(s), true, s);
  }
  for (const s of ['running', 'attention', 'unknown'] as RadarStatus[]) {
    assert.equal(isTerminal(s), false, s);
  }
});

// ── the clock: padded, and LAST on the line ────────────────────────────────

test('the clock cell is a fixed width, so nothing tears when the second changes', () => {
  // TERMINAL-UI.md L129-135: the terminal's equivalent of tabular-nums IS
  // fixed-width padding. This is the property that makes the band's line order
  // safe — remove the padding and the design's own ordering starts to jitter.
  for (const ms of [0, 9_000, 48_000, 138_000, 724_000, 3_720_000]) {
    assert.equal(elapsedCell(ms).length, ELAPSED_WIDTH, `${ms}ms is not ${ELAPSED_WIDTH} columns`);
  }
});

test('a job with no known start gets a BLANK clock, never 0s', () => {
  // harness/normalize.ts refuses to invent a start for agy-staff. Printing `0s`
  // about a job that has been working for half an hour is a fabrication.
  const line = buildLine(job({ startedAt: null, toolCount: null }), Date.now());
  assert.ok(!line.plain.includes('0s'), `blank clock expected, got: ${line.plain}`);
  assert.ok(!line.plain.includes('tools'), `tools must be omitted too: ${line.plain}`);
});

// ── the line ────────────────────────────────────────────────────────────────

test('the band line is identity, then liveness, then elapsed LAST', () => {
  const line = buildLine(
    job({
      id: 'implement-musm82da',
      status: 'running',
      startedAt: 0,
      toolCount: 341,
      activity: 'cargo test --workspace',
    }),
    724_000, // 12m04s
  );

  // TERMINAL-UI.md L129-132: the ticking field goes last, so the activity text
  // does not slide sideways once a second. This ordering is the band/pane
  // deviation; see README.md §Deviation.
  assert.equal(line.plain, ' ● implement-musm82da cargo test --workspace · 341 tools · 12m04s');
  assert.ok(line.plain.endsWith('12m04s'), `elapsed must be last: ${line.plain}`);
});

test('the required layout renders: one line per job, readable in its first 40 columns', () => {
  // The /agy-radar design, through the band's own formatter.
  const running = buildLine(
    job({
      id: 'implement-musm82da',
      status: 'running',
      startedAt: 0,
      toolCount: 341,
      activity: 'cargo test --workspace',
    }),
    724_000,
  );
  const review = buildLine(
    job({
      id: 'review-muroviej',
      status: 'attention',
      startedAt: 0,
      toolCount: 22,
      activity: 'reading decoded_view.rs',
    }),
    138_000,
  );
  const done = buildLine(
    job({ id: 'research-muroabc', status: 'succeeded', startedAt: 0, endedAt: 48_000, toolCount: 8 }),
    60_000,
  );

  // TERMINAL-UI.md L48-50: "the single most important rule in this file — a line
  // must be readable in its first 40 columns."
  for (const line of [running, review, done]) {
    assert.ok(line.plain.slice(0, 40).length > 0);
  }
  assert.ok(running.plain.includes('implement-musm82da'));
  assert.ok(review.plain.includes('review-muroviej'));
  assert.ok(done.plain.includes('research-muroabc'));
  assert.ok(done.plain.includes('finished'));
  assert.ok(done.plain.includes('48s'));
});

test('the head carries the glyph and the accent; the tail is everything dim', () => {
  const running = buildLine(job({ status: 'running' }), 1_000);
  const done = buildLine(job({ status: 'succeeded', endedAt: 2_000 }), 2_000);
  const gone = buildLine(job({ status: 'canceled', endedAt: 2_000 }), 2_000);

  assert.equal(running.accent, 'yellow');
  assert.equal(running.bold, true);
  assert.equal(done.accent, 'green');
  assert.equal(gone.accent, undefined, 'canceled is glyph-only');
  assert.equal(gone.bold, false);
  // Every line is exactly head + tail, so the renderer has two segments to draw
  // and nothing can end up coloured that should be dim.
  for (const line of [running, done, gone]) {
    assert.equal(line.plain, `${line.head}${line.tail}`);
    assert.ok(line.head.startsWith(' '), 'head keeps the leading gutter');
    assert.ok(line.head.includes(line.glyph));
  }
});

test('a failed job says WHY in a stable code, not a sentence', () => {
  // harness/types.ts: each warning carries a stable `code` for grouping and a
  // `message` that is display-only. TERMINAL-UI.md L52-54 keeps prose off a band
  // line. So the code goes on the line and the sentence does not.
  const line = buildLine(
    job({
      status: 'failed',
      startedAt: 0,
      endedAt: 2_000,
      warnings: [
        {
          code: 'suspicious_success',
          message: 'agy reported done but produced no usable output — treating as failed.',
        },
      ],
    }),
    2_000,
  );
  assert.ok(line.plain.includes('suspicious success'), line.plain);
  assert.ok(!line.plain.includes('no usable output'), 'the message must stay off the line');
  assert.equal(line.accent, 'red');
});

test('a succeeded job with warnings says so in words, not in colour', () => {
  // harness/normalize.ts is explicit: a NON-EMPTY result with warnings:true stays
  // `succeeded`. A recolour would contradict that, and TERMINAL-UI.md L85-87
  // reserves red for real failures.
  const line = buildLine(
    job({
      status: 'succeeded',
      startedAt: 0,
      endedAt: 2_000,
      warnings: [{ code: 'suspicious_success', message: 'agy-staff set warnings:true' }],
    }),
    2_000,
  );
  assert.equal(line.accent, 'green', 'still a success: the output was real');
  assert.ok(line.plain.includes('finished, warnings'), line.plain);
});

test('an unknown tool count is omitted entirely, with no dangling separator', () => {
  // HAZARD A: agy-staff deletes events.jsonl on a warning-free success, so for a
  // clean finish there is genuinely no count on disk. `0 tools` is a fabrication;
  // `· ·` reads as a rendering bug. And there IS a count to be had from
  // progress.json's step_index, which is why this is omitted rather than zeroed.
  const line = buildLine(job({ status: 'succeeded', startedAt: 0, endedAt: 5_000, toolCount: null }), 5_000);
  // The clock keeps its ELAPSED_WIDTH cell even as the only segment, so the line
  // is the same width whether or not a count was available. That is what stops
  // the band re-flowing when the last running job finishes and loses its count.
  assert.match(line.plain, /^ ✓ implement-job\d+ finished ·\s+5s$/);
  // Dropping the count shortens the tail by exactly that one segment — no
  // leftover separator, and no other field moves.
  const withCount = buildLine(
    job({ status: 'succeeded', startedAt: 0, endedAt: 5_000, toolCount: 8 }),
    5_000,
  );
  assert.equal(line.tail, withCount.tail.replace(' · 8 tools', ''));
  assert.ok(!line.plain.includes('0 tools'));
  assert.ok(!line.plain.includes('· ·'));
});

test('a finished job does not advertise what it was last doing', () => {
  // TERMINAL-UI.md L46: activity is level-2 liveness. What a finished job was
  // doing is not news, and keeping it would push the clock off the line.
  const line = buildLine(
    job({ status: 'succeeded', startedAt: 0, endedAt: 5_000, activity: 'cargo test --workspace' }),
    5_000,
  );
  assert.ok(!line.plain.includes('cargo test'), line.plain);
});

test('activity is truncated at the source, never handed over raw', () => {
  // TERMINAL-UI.md L195-196: "Terse tool descriptions, never raw output…
  // Truncate at the source."
  const line = buildLine(
    job({ status: 'running', startedAt: 0, activity: 'cargo test --workspace ' + 'x'.repeat(400) }),
    1_000,
  );
  const activity = line.tail.slice(0, line.tail.indexOf(' · '));
  assert.ok(activity.length <= 41, `expected a truncated phrase, got ${activity.length}`);
  assert.ok(activity.endsWith('…'));
});

// ── NO_COLOR ────────────────────────────────────────────────────────────────

test('NO_COLOR drops colour but keeps the glyph, so state still reads', () => {
  // The SAME job both ways: buildLine must not vary a single character of text
  // between the two, only the colour prop. (Distinct ids here would hide a real
  // regression behind a diff.)
  const one = job({ status: 'running' });
  const withColour = buildLine(one, 1_000);
  const without = buildLine(one, 1_000, { colour: false });

  assert.equal(withColour.accent, 'yellow');
  assert.equal(without.accent, undefined, 'no colour prop at all');
  // The redundant channel survives — this is the whole point of the glyph.
  assert.equal(without.glyph, '●');
  assert.equal(without.plain, withColour.plain, 'only colour changes, never the text');
});

test('noColor honours NO_COLOR, FORCE_COLOR=0, TERM=dumb — and nothing else', () => {
  // https://no-color.org/: present AND non-empty means no colour. An exported but
  // blank NO_COLOR= is explicitly NOT a request.
  assert.equal(noColor({ NO_COLOR: '1' }), true);
  assert.equal(noColor({ NO_COLOR: 'anything' }), true);
  assert.equal(noColor({ NO_COLOR: '' }), false, 'empty NO_COLOR is not a request');
  assert.equal(noColor({ NO_COLOR: undefined }), false);
  assert.equal(noColor({ FORCE_COLOR: '0' }), true);
  assert.equal(noColor({ FORCE_COLOR: 'false' }), true);
  assert.equal(noColor({ FORCE_COLOR: '1' }), false);
  assert.equal(noColor({ TERM: 'dumb' }), true);
  assert.equal(noColor({ TERM: 'xterm-256color' }), false);
  assert.equal(noColor({}), false);
});

test('bold survives NO_COLOR — it is the contrast affordance, not a colour', () => {
  // TERMINAL-UI.md L208: `prefers-contrast: more` maps to NO_COLOR plus bold.
  const line = buildLine(job({ status: 'running' }), 1_000, { colour: false });
  assert.equal(line.accent, undefined);
  assert.equal(line.bold, true);
});

// ── visibility, linger, and the row cap ─────────────────────────────────────

test('a finished job lingers LINGER_MS and then leaves', () => {
  const done = job({ status: 'succeeded', startedAt: 0, endedAt: 1_000_000 });
  assert.equal(isShown(done, 1_000_000 + LINGER_MS - 1), true, 'still up just before the window');
  assert.equal(isShown(done, 1_000_000 + LINGER_MS), false, 'gone at the boundary');
  assert.equal(isShown(done, 1_000_000 + 600_000), false, 'a result that vanishes instantly is never seen');
});

test('a finished job from hours ago is NOT shown', () => {
  // The real corpus at /Users/gathrid/Repos/renyi/.agy-staff/jobs holds 20 jobs
  // finished hours ago. A band that showed four of them at session start would be
  // asserting work is in flight when it is not. This is why isShown measures from
  // endedAt and NOT from "when we first noticed".
  const hoursOld = job({ status: 'succeeded', startedAt: 0, endedAt: Date.now() - 6 * 3600_000 });
  assert.equal(isShown(hoursOld, Date.now()), false);
});

test('live jobs are always shown, including an unreadable one', () => {
  assert.equal(isShown(job({ status: 'running' }), Date.now()), true);
  assert.equal(isShown(job({ status: 'attention' }), Date.now()), true);
  // `unknown` is not terminal, so it is shown — but its glyph says we do not
  // know, and harness/types.ts is explicit it must never be drawn as healthy.
  assert.equal(isShown(job({ status: 'unknown' }), Date.now()), true);
  assert.ok(buildLine(job({ status: 'unknown' }), Date.now()).plain.includes('?'));
});

test('at most BAND_ROWS rows, then `+N more`', () => {
  // TERMINAL-UI.md L151: a band that grows without bound pushes the prompt off
  // screen. Four is the cap both reference mods use.
  const many = Array.from({ length: 9 }, () => job({ status: 'running' }));
  const budget = rowBudget(many);
  assert.equal(budget.rows.length, BAND_ROWS);
  assert.equal(budget.hidden, 9 - BAND_ROWS);
  assert.equal(overflowLine(budget.hidden), `   +${9 - BAND_ROWS} more · /agy-radar`);
});

test('exactly BAND_ROWS shows no overflow row at all', () => {
  const four = Array.from({ length: BAND_ROWS }, () => job());
  assert.equal(rowBudget(four).hidden, 0);
});

test('the engine\'s own maxRows wins, and leaves us a row for the overflow line', () => {
  // The engine reserves one row of maxRows for its own "n more" line when a tree
  // is taller than the site, so we take maxRows-1 and spend the last on ours.
  const many = Array.from({ length: 20 }, () => job());
  assert.equal(rowBudget(many, 5).rows.length, 4);
  assert.equal(rowBudget(many, 3).rows.length, 2);
  // Clamped to 1: a one-row band that shows one job beats one that shows nothing.
  assert.equal(rowBudget(many, 1).rows.length, 1);
  assert.equal(rowBudget(many, 2).rows.length, 1);
  // A nonsense or absent maxRows falls back to BAND_ROWS.
  assert.equal(rowBudget(many, Number.NaN).rows.length, BAND_ROWS);
  assert.equal(rowBudget(many, undefined).rows.length, BAND_ROWS);
});

// ── not flickering (TERMINAL-UI.md L22-35) ─────────────────────────────────

test('a terminal row never un-finishes on weaker evidence', () => {
  // THE HAZARD. agy-staff deletes progress.json on a warning-free success, so a
  // poll that cannot see the terminal file would otherwise report `running` for a
  // job that finished, and the line would blink back to yellow.
  const done = job({ status: 'succeeded', startedAt: 0, endedAt: 5_000 });
  const stale = job({ status: 'running', startedAt: 0, endedAt: null });
  assert.equal(reconcile(done, stale).status, 'succeeded');
  assert.equal(reconcile(done, stale).endedAt, 5_000);
});

test('a fresh terminal reading DOES move a live row — the stickiness is one-way', () => {
  // Upgrading running → done on new evidence is correct and must happen, or the
  // band would never show anything finishing.
  const running = job({ status: 'running', startedAt: 0 });
  const done = job({ status: 'succeeded', startedAt: 0, endedAt: 5_000 });
  const next = reconcile(running, done);
  assert.equal(next.status, 'succeeded');
  assert.equal(next.endedAt, 5_000);
});

test('a terminal row keeps its finish instant when a tick cannot re-read it', () => {
  // Otherwise the clock restarts from zero mid-linger and the user sees a job
  // visibly rewind.
  const done = job({ status: 'succeeded', startedAt: 0, endedAt: 5_000 });
  const unreadable = job({ status: 'succeeded', startedAt: 99_000, endedAt: null });
  assert.equal(reconcile(done, unreadable).endedAt, 5_000);
  assert.equal(reconcile(done, unreadable).startedAt, 0);
});

test('a missing activity clause is a mid-write read, not an idle job', () => {
  const busy = job({ status: 'running', activity: 'cargo test --workspace' });
  const blank = job({ status: 'running', activity: '' });
  assert.equal(reconcile(busy, blank).activity, 'cargo test --workspace');
});

test('a tool count never walks backwards', () => {
  // events.jsonl can be unreadable for one tick (EBUSY, a half-written tail).
  // A count that dropped from 341 to a stale 22 would read as the job undoing work.
  const many = job({ status: 'running', toolCount: 341 });
  assert.equal(reconcile(many, job({ status: 'running', toolCount: null })).toolCount, 341);
  assert.equal(reconcile(many, job({ status: 'running', toolCount: 22 })).toolCount, 341);
  // And a real decrease (impossible in practice) is not silently hidden upward.
  assert.equal(reconcile(job({ toolCount: 5 }), job({ toolCount: 7 })).toolCount, 7);
});

test('with no previous reading, the fresh one is taken as-is', () => {
  const fresh = job({ status: 'running' });
  assert.equal(reconcile(undefined, fresh), fresh);
});

test('the tick cushion covers the gap that would otherwise leave a row one tick late', () => {
  // isShown flips false between 29_999ms and 30_001ms after the finish, and the
  // tick that notices arrives up to a second later. Without a cushion the row
  // survives one extra tick — a visible blink, which is rule #1 of TERMINAL-UI.md
  // arriving through visibility instead of through row count.
  assert.ok(TICK_CUSHION_MS >= 1000, 'the cushion must cover one clock period');
  const done = job({ status: 'succeeded', startedAt: 0, endedAt: 0 });
  const tickAt = LINGER_MS - 1; // just before the boundary
  assert.equal(isShown(done, tickAt), true);
  assert.equal(
    isShown(done, tickAt + TICK_CUSHION_MS),
    false,
    'the tick that redraws past the boundary must not find it still shown',
  );
});