import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ELAPSED_WIDTH } from '../hooks/format.ts';
import {
  BAND_ROWS,
  LINGER_MS,
  buildLine,
  elapsedCell,
  isShown,
  isTerminal,
  noColor,
  overflowLine,
  pickColor,
  pickGlyph,
  rowBudget,
} from '../hooks/band.ts';
import type { RadarJob, RadarStatus } from '../types/index.d.ts';

let seq = 0;
function job(over: Partial<RadarJob> = {}): RadarJob {
  seq += 1;
  const id = over.id ?? `implement-job${seq}`;
  return {
    id,
    workerId: over.workerId ?? id,
    turn: 1,
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
    // U+23FA is the one deliberate exception: text-presentation by default (not Emoji_Presentation), and the glyph Claude Code itself ships on macOS.
    assert.ok(g === '⏺' || !/\p{Extended_Pictographic}/u.test(g), `${g} is emoji and may be double-width`);
    assert.equal([...g].length, 1, `${g} is not a single code point`);
    assert.ok((g.codePointAt(0) ?? 0) <= 0xffff, `${g} is outside the BMP`);
  }

  assert.equal(new Set(glyphs).size, statuses.length, 'two states share a glyph');
});

test('running/done/failed are ⏺ ✓ ✗ — the current row set', () => {
  assert.equal(pickGlyph('running'), '⏺');
  assert.equal(pickGlyph('succeeded'), '✓');
  assert.equal(pickGlyph('failed'), '✗');
});

test('canceled is NOT ✗: a cancelled job is not a bug', () => {
  assert.notEqual(pickGlyph('canceled'), pickGlyph('failed'));
  assert.equal(pickColor('canceled'), undefined, 'and it must not be red');
});

test('unknown is neither healthy-looking nor failure-looking', () => {
  assert.notEqual(pickGlyph('unknown'), pickGlyph('succeeded'));
  assert.notEqual(pickGlyph('unknown'), pickGlyph('failed'));
  assert.equal(pickColor('unknown'), undefined);
});

test('colours follow the fixed convention: yellow running, green done, red failed', () => {
  assert.equal(pickColor('running'), 'blue');
  assert.equal(pickColor('succeeded'), 'green');
  assert.equal(pickColor('failed'), 'red');
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

test('the clock cell is a fixed width, so nothing tears when the second changes', () => {
  for (const ms of [0, 9_000, 48_000, 138_000, 724_000, 3_720_000]) {
    assert.equal(elapsedCell(ms).length, ELAPSED_WIDTH, `${ms}ms is not ${ELAPSED_WIDTH} columns`);
  }
});

test('a job with no known start gets a BLANK clock, never 0s', () => {
  const line = buildLine(job({ startedAt: null, toolCount: null }), Date.now());
  assert.ok(!line.plain.includes('0s'), `blank clock expected, got: ${line.plain}`);
  assert.ok(!line.plain.includes('tools'), `tools must be omitted too: ${line.plain}`);
});

test('the band line is identity, then liveness, then elapsed LAST', () => {
  const line = buildLine(
    job({
      id: 'implement-musm82da',
      status: 'running',
      startedAt: 0,
      toolCount: 341,
      activity: 'cargo test --workspace',
    }),
    724_000,
  );

  assert.equal(line.plain, ' ⏺ implement-musm82da                           cargo test --workspace 12m04s');
  assert.ok(line.plain.endsWith('12m04s'), `elapsed must be last: ${line.plain}`);
});

test('the required layout renders: one line per job, readable in its first 40 columns', () => {
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

  for (const line of [running, review, done]) {
    assert.ok(line.plain.slice(0, 40).length > 0);
  }
  assert.ok(running.plain.includes('implement-musm82da'));
  assert.ok(review.plain.includes('review-muroviej'));
  assert.ok(done.plain.includes('research-muroabc'));
  assert.ok(done.plain.includes('done'));
  assert.ok(done.plain.includes('48s'));
});

test('the head carries the glyph and the accent; the tail is everything dim', () => {
  const running = buildLine(job({ status: 'running' }), 1_000);
  const done = buildLine(job({ status: 'succeeded', endedAt: 2_000 }), 2_000);
  const gone = buildLine(job({ status: 'canceled', endedAt: 2_000 }), 2_000);

  assert.equal(running.accent, 'blue');
  assert.equal(running.bold, true);
  assert.equal(done.accent, 'green');
  assert.equal(gone.accent, undefined, 'canceled is glyph-only');
  assert.equal(gone.bold, false);
  for (const line of [running, done, gone]) {
    assert.ok(line.plain.startsWith(` ${line.glyph} `), 'glyph stays in the first cell');
    assert.ok(line.plain.includes(line.label.trim()));
    assert.ok(line.plain.endsWith(line.clock.trim()));
  }
});

test('a failed job says WHY in a stable code, not a sentence', () => {
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
  assert.ok(line.plain.includes('failed ∙ no output'), line.plain);
  assert.ok(!line.plain.includes('no usable output'), 'the message stays off the line');
  assert.equal(line.accent, 'red');
});

test('a denial shows what was denied, not "no output"', () => {
  const line = buildLine(
    job({
      status: 'failed', startedAt: 0, endedAt: 2_000,
      failureReason: 'worker soft-denied 1 tool action(s) (view_file) — it exited 0 and reported success while doing nothing.',
      warnings: [{ code: 'suspicious_success', message: 'x' }],
    }),
    2_000,
 { width: 100 });
  assert.ok(line.plain.includes('failed ∙ denied view_file'), line.plain);
});

test('checks that failed after a clean run say which, and are not "done"', () => {
  const line = buildLine(
    job({
      status: 'succeeded', startedAt: 0, endedAt: 2_000,
      acceptance: { state: 'rejected', checks: [{ name: 'lint', ok: false, outputTail: '' }] },
    }),
    2_000,
  );
  assert.ok(line.plain.includes('checks failed: lint'), line.plain);
  assert.ok(!line.plain.includes('done'), line.plain);
});

test('a succeeded job with warnings says so in words, not in colour', () => {
  const line = buildLine(
    job({
      status: 'succeeded',
      startedAt: 0,
      endedAt: 2_000,
      warnings: [{ code: 'suspicious_success', message: 'worker reported warnings' }],
    }),
    2_000,
  );
  assert.equal(line.accent, 'green', 'still a success: the output was real');
  assert.ok(line.plain.includes('done ∙ warnings'), line.plain);
});

test('an unknown tool count is omitted entirely, with no dangling separator', () => {
  const line = buildLine(job({ status: 'succeeded', startedAt: 0, endedAt: 5_000, toolCount: null }), 5_000);
  assert.ok(line.plain.includes('done'));
  assert.ok(line.plain.endsWith('5s'));
  const withCount = buildLine(
    job({ status: 'succeeded', startedAt: 0, endedAt: 5_000, toolCount: 8 }),
    5_000,
  );
  assert.ok(!line.detail.includes('tools'));
  assert.ok(!withCount.detail.includes(' · ·'));
  assert.ok(!line.plain.includes('0 tools'));
  assert.ok(!line.plain.includes('· ·'));
});

test('a finished job does not advertise what it was last doing', () => {
  const line = buildLine(
    job({ status: 'succeeded', startedAt: 0, endedAt: 5_000, activity: 'cargo test --workspace' }),
    5_000,
  );
  assert.ok(!line.plain.includes('cargo test'), line.plain);
});

test('activity is truncated at the source, never handed over raw', () => {
  const line = buildLine(
    job({ status: 'running', startedAt: 0, activity: 'cargo test --workspace ' + 'x'.repeat(400) }),
    1_000,
  );
  assert.ok(line.detail.length <= 22, `detail exceeded its cell: ${line.detail.length}`);
  assert.ok(!line.detail.includes('x'.repeat(20)), 'the row does not carry raw command output');
});

test('NO_COLOR drops colour but keeps the glyph, so state still reads', () => {
  const one = job({ status: 'running' });
  const withColour = buildLine(one, 1_000);
  const without = buildLine(one, 1_000, { colour: false });

  assert.equal(withColour.accent, 'blue');
  assert.equal(without.accent, undefined, 'no colour prop at all');
  assert.equal(without.glyph, '⏺');
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
  const line = buildLine(job({ status: 'running' }), 1_000, { colour: false });
  assert.equal(line.accent, undefined);
  assert.equal(line.bold, true);
});

test('a finished job lingers LINGER_MS and then leaves', () => {
  const done = job({ status: 'succeeded', startedAt: 0, endedAt: 1_000_000 });
  assert.equal(isShown(done, 1_000_000 + LINGER_MS - 1), true, 'still up just before the window');
  assert.equal(isShown(done, 1_000_000 + LINGER_MS), false, 'gone at the boundary');
  assert.equal(isShown(done, 1_000_000 + 600_000), false, 'a result that vanishes instantly is never seen');
});

test('a finished job from hours ago is NOT shown', () => {
  const hoursOld = job({ status: 'succeeded', startedAt: 0, endedAt: Date.now() - 6 * 3600_000 });
  assert.equal(isShown(hoursOld, Date.now()), false);
});

test('live jobs are always shown, including an unreadable one', () => {
  assert.equal(isShown(job({ status: 'running' }), Date.now()), true);
  assert.equal(isShown(job({ status: 'attention' }), Date.now()), true);
  assert.equal(isShown(job({ status: 'unknown' }), Date.now()), true);
  assert.ok(buildLine(job({ status: 'unknown' }), Date.now()).plain.includes('?'));
});

test('at most BAND_ROWS rows, then `+N more`', () => {
  const many = Array.from({ length: 9 }, () => job({ status: 'running' }));
  const budget = rowBudget(many);
  assert.equal(budget.rows.length, BAND_ROWS);
  assert.equal(budget.hidden, 9 - BAND_ROWS);
  assert.equal(overflowLine(budget.hidden), `   +${9 - BAND_ROWS} more ∙ /forge`);
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
  assert.equal(rowBudget(many, 1).rows.length, 1);
  assert.equal(rowBudget(many, 2).rows.length, 1);
  assert.equal(rowBudget(many, Number.NaN).rows.length, BAND_ROWS);
  assert.equal(rowBudget(many, undefined).rows.length, BAND_ROWS);
});

test('band renders pendingSteers immediately, turn N when turn > 1, and chainStartedAt continuously across steers', () => {
  const queuedOne = buildLine(
    job({ name: 'Ada', workerId: 'ada', turn: 1, status: 'running', startedAt: 0, pendingSteers: 1, activity: 'editing a.ts' }),
    15_000,
    { width: 100, longestLabel: 3 },
  );
  assert.match(queuedOne.plain, /1 queued ∙ editing a\.ts/);

  const queuedTwo = buildLine(
    job({ name: 'Ada', workerId: 'ada', turn: 2, status: 'running', startedAt: 60_000, chainStartedAt: 0, pendingSteers: 2, activity: 'running tests' }),
    72_000,
    { width: 100, longestLabel: 3 },
  );
  assert.match(queuedTwo.plain, /2 queued ∙ turn 2 ∙ running tests/);
  assert.ok(queuedTwo.plain.endsWith('1m12s'), `expected continuous chainStartedAt elapsed 1m12s, got: ${queuedTwo.plain}`);

  const resumed = buildLine(
    job({ name: 'Ada', workerId: 'ada', turn: 2, status: 'running', startedAt: 300_000, chainStartedAt: 300_000, continuationKind: 'follow-up', activity: 'editing b.ts' }),
    312_000,
    { width: 100, longestLabel: 3 },
  );
  assert.match(resumed.plain, /turn 2 ∙ editing b\.ts/);
  assert.ok(resumed.plain.endsWith('12s'), `expected fresh elapsed 12s on resume, got: ${resumed.plain}`);

  const afterSteer = buildLine(
    job({ name: 'Ada', workerId: 'ada', turn: 2, status: 'succeeded', startedAt: 60_000, chainStartedAt: 0, endedAt: 90_000, continuationKind: 'steer' }),
    95_000,
    { width: 100, longestLabel: 3 },
  );
  assert.match(afterSteer.plain, /done ∙ turn 2 ∙ steered/);

  const afterResume = buildLine(
    job({ name: 'Ada', workerId: 'ada', turn: 2, status: 'succeeded', startedAt: 300_000, chainStartedAt: 300_000, endedAt: 320_000, continuationKind: 'follow-up' }),
    325_000,
    { width: 100, longestLabel: 3 },
  );
  assert.match(afterResume.plain, /done ∙ turn 2 ∙ follow-up/);
});
