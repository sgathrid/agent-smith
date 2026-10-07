/**
 * Tests for the pure half of the mod.
 *
 * Everything here is a pure function with no clock, no filesystem and no import of
 * the `claude-code` module — which is what makes it runnable under the repo's own
 * `node --test --experimental-strip-types`. None of this could be tested from
 * register.tsx, because node's type stripping has no JSX transform.
 *
 * Test names cite the rule being enforced and, where the rule came from measured
 * data, the evidence. A test that asserts a magic string with no provenance is
 * how the next engineer "fixes" a deliberate decision by accident.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ELAPSED_WIDTH,
  EMPTY_STATE,
  TOOL_COUNT_WIDTH,
  basename,
  countSummary,
  describeActivity,
  describeTool,
  elapsed,
  elapsedCell,
  ellipsis,
  formatHeaderLine,
  formatJobLine,
  isTerminal,
  oneLine,
  parseInputPreview,
  pickColor,
  pickGlyph,
  sortJobs,
  toolCountCell,
} from '../format.ts';
import type { RadarJob, RadarStatus } from '../../types/index.d.ts';

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

// ── list ordering and the header counts ─────────────────────────────────────
//
// These two moved here from the deleted ./job-source.ts with the rest of the
// pane's pure presentation. They are pure, so they are testable with no
// filesystem, which is the reason they are in this file and not in jobs.ts.

test('sortJobs tiers running, then needs-you, then everything terminal', () => {
  // THREE tiers, and `attention` is deliberately not grouped with `running`.
  // The band groups them (both live, no room to distinguish); the pane has a
  // header and a footer, so a quiet job sorts directly under the working ones.
  const rows = [
    job({ id: 'done', status: 'succeeded', endedAt: 1 }),
    job({ id: 'needs', status: 'attention', startedAt: 1 }),
    job({ id: 'live', status: 'running', startedAt: 1 }),
  ];
  assert.deepEqual(
    sortJobs(rows).map((j) => j.id),
    ['live', 'needs', 'done'],
  );
});

test('sortJobs is newest-first inside a tier, and does not mutate its input', () => {
  const rows = [
    job({ id: 'old', status: 'succeeded', endedAt: 100 }),
    job({ id: 'new', status: 'succeeded', endedAt: 300 }),
    job({ id: 'mid', status: 'succeeded', endedAt: 200 }),
  ];
  const copy = [...rows];
  assert.deepEqual(
    sortJobs(rows).map((j) => j.id),
    ['new', 'mid', 'old'],
  );
  assert.deepEqual(rows, copy, 'sorting a list must not reorder the caller\'s list');
});

test('countSummary counts attention as RUNNING', () => {
  // The load-bearing assertion. `attention` is a job that is still going and has
  // gone quiet; counting it under finished tells the user a job is over at the
  // exact moment they should be doing something about it.
  const rows = [
    job({ status: 'running' }),
    job({ status: 'attention' }),
    job({ status: 'succeeded' }),
    job({ status: 'failed' }),
    job({ status: 'canceled' }),
    job({ status: 'unknown' }),
  ];
  assert.deepEqual(countSummary(rows), { running: 2, finished: 4 });
  assert.deepEqual(countSummary([]), { running: 0, finished: 0 });
});

// ── glyphs ──────────────────────────────────────────────────────────────────

test('every status has a single-width glyph, and the glyph alone is unambiguous', () => {
  const statuses: RadarStatus[] = [
    'running',
    'succeeded',
    'failed',
    'attention',
    'canceled',
    'unknown',
  ];
  const glyphs = statuses.map(pickGlyph);

  // TERMINAL-UI.md §Glyphs: the failure that motivates the whole rule is that
  // `⏳` and `✅` render DOUBLE-WIDTH and silently break every column after them,
  // which is exactly what the shipped review-watch mod does. Emoji are also the
  // most common way a monospace assumption breaks, so the check is on the code
  // point rather than on a list of characters someone might extend.
  for (const g of glyphs) {
    assert.ok(!/\p{Extended_Pictographic}/u.test(g), `${g} is emoji and may be double-width`);
    // One code point, and in the BMP so no width-table surprise.
    assert.equal([...g].length, 1, `${g} is not a single code point`);
    assert.ok(g.codePointAt(0)! <= 0xffff, `${g} is outside the BMP`);
  }

  // Distinct glyphs per state: colour is never the only channel, so two states
  // sharing a glyph would be two states a monochrome terminal cannot tell apart.
  assert.equal(new Set(glyphs).size, statuses.length, 'two states share a glyph');
});

test('running is ●, succeeded is ✓, failed is ✗ — the shipped reference set', () => {
  assert.equal(pickGlyph('running'), '●');
  assert.equal(pickGlyph('succeeded'), '✓');
  assert.equal(pickGlyph('failed'), '✗');
});

test('canceled is NOT ✗: a cancelled job is not a bug', () => {
  // core/types.ts: "'cancelled' is distinct from 'failed' on purpose: a cancelled
  // job is not a bug, and an alert on one trains people to ignore alerts."
  // Painting it with the failure glyph would contradict the type contract that
  // defines it.
  assert.notEqual(pickGlyph('canceled'), pickGlyph('failed'));
});

test('colour never carries meaning alone — every coloured status also has a glyph', () => {
  const coloured: RadarStatus[] = ['running', 'succeeded', 'failed', 'attention'];
  for (const s of coloured) {
    assert.ok(pickColor(s) !== undefined, `${s} is coloured`);
    assert.ok(pickGlyph(s).length > 0, `${s} has no glyph to fall back on`);
  }
  // Terminal-UI.md §Colour: yellow=running, green=done, red=failed. Do not invent a
  // local convention — git, cargo, pytest and CI all agree on this one.
  assert.equal(pickColor('running'), 'yellow');
  assert.equal(pickColor('succeeded'), 'green');
  assert.equal(pickColor('failed'), 'red');
});

test('canceled and unknown are dim, not coloured — red is reserved', () => {
  assert.equal(pickColor('canceled'), undefined);
  assert.equal(pickColor('unknown'), undefined);
});

test('isTerminal covers exactly the three over states', () => {
  assert.equal(isTerminal('succeeded'), true);
  assert.equal(isTerminal('failed'), true);
  assert.equal(isTerminal('canceled'), true);
  assert.equal(isTerminal('running'), false);
  assert.equal(isTerminal('attention'), false);
  assert.equal(isTerminal('unknown'), false);
});

// ── elapsed ─────────────────────────────────────────────────────────────────

test('elapsed is tabular: the seconds digit is zero-padded', () => {
  // TERMINAL-UI.md §Width: the terminal equivalent of font-variant-numeric
  // tabular-nums IS fixed-width padding. 9s and 12s must not occupy the same
  // column, or the text after them tears every second.
  assert.equal(elapsed(9_000), '9s');
  assert.equal(elapsed(12_000), '12s');
  assert.equal(elapsed(12 * 60_000 + 4_000), '12m04s');
  assert.equal(elapsed(2 * 60_000 + 18_000), '2m18s');
});

test('elapsedCell pads every duration to the same width', () => {
  // This is the load-bearing property, not the cosmetics: the required design puts
  // elapsed BEFORE the activity text, which appears to break TERMINAL-UI.md's
  // "put the volatile field last" rule. Fixed width is what makes that safe.
  const cells = ['9s', '48s', '2m18s', '12m04s', '1h02m'].map((s) => {
    const [, m = 0, sec = 0] = /^(\d+)h(?:(\d+)m)?/.exec(s) ?? [];
    void m;
    void sec;
    return s;
  });
  void cells;

  for (const ms of [0, 9_000, 48_000, 138_000, 724_000, 3_720_000]) {
    assert.equal(
      elapsedCell(ms).length,
      ELAPSED_WIDTH,
      `${elapsed(ms)} is not padded to ${ELAPSED_WIDTH} columns`,
    );
  }
  // And right-aligned, so the digits line up on the right where they change.
  assert.ok(elapsedCell(9_000).startsWith(' '));
  assert.equal(elapsedCell(9_000), '    9s');
});

test('elapsed never goes negative and drops seconds past an hour', () => {
  assert.equal(elapsed(-5_000), '0s');
  // 1h02m03s is 8 columns; a band that needs 8 for a clock cannot afford it.
  assert.equal(elapsed(3_723_000), '1h02m');
});

// ── tool count ──────────────────────────────────────────────────────────────

test('an unknown tool count renders blank, never 0', () => {
  // HAZARD A: agy-staff deletes events.jsonl on a warning-free success, so for a
  // cleanly finished job there is genuinely no count anywhere on disk. Printing
  // "0 tools" would be a confident fabrication about a job that ran hundreds.
  assert.equal(toolCountCell(null), '');
  assert.equal(toolCountCell(0), '  0');
});

test('tool counts are right-aligned so the column does not jitter', () => {
  assert.equal(toolCountCell(341).length, TOOL_COUNT_WIDTH);
  assert.equal(toolCountCell(22).length, TOOL_COUNT_WIDTH);
  assert.equal(toolCountCell(8).length, TOOL_COUNT_WIDTH);
});

// ── the job line ────────────────────────────────────────────────────────────

test('a job line reads as glyph, id, elapsed, tools, activity', () => {
  const line = formatJobLine(
    job({
      id: 'implement-musm82da',
      status: 'running',
      startedAt: 0,
      endedAt: 724_000, // 12m04s
      toolCount: 341,
      activity: 'cargo test --workspace',
    }),
    { idWidth: 18 },
  );
  // `implement-musm82da` is exactly 18 chars, so it fills the column and the single
  // space before the clock is the gutter alone. Accounted for, which is the point.
  assert.equal(line, ' ● implement-musm82da 12m04s · 341 tools · cargo test --workspace');
});

test('the three design lines, and their columns line up', () => {
  // The three lines from the /agent-smith design spec, with ids 17, 15 and 16 chars
  // wide so that a naive join WOULD misalign them.
  const lines = [
    job({ id: 'implement-musm82da', startedAt: 0, endedAt: 724_000, toolCount: 341, activity: 'cargo test --workspace' }),
    job({ id: 'review-muroviej', startedAt: 0, endedAt: 138_000, toolCount: 22, activity: 'reading decoded_view.rs' }),
    job({ id: 'research-muroabc', status: 'succeeded', startedAt: 0, endedAt: 48_000, toolCount: 8 }),
  ].map((j) => formatJobLine(j, { idWidth: 18 }));

  // Content, in the design's order: glyph, id, clock, tool count, activity.
  assert.ok(lines[0]!.startsWith(' ● implement-musm82da'));
  assert.ok(lines[0]!.includes('12m04s · 341 tools · cargo test --workspace'));
  assert.ok(lines[1]!.startsWith(' ● review-muroviej'));
  assert.ok(lines[1]!.includes('2m18s'));
  assert.ok(lines[1]!.includes('22 tools · reading decoded_view.rs'));
  assert.ok(lines[2]!.startsWith(' ✓ research-muroabc'));
  assert.ok(lines[2]!.includes('48s'));

  // THE ASSERTION THAT MATTERS. TERMINAL-UI.md's rule is "every line must be
  // readable in its first 40 columns" and its alignment rule is that a changing
  // field must not move the fields after it. So: the clock's END and the tool
  // count's END must be at identical columns across all three lines, despite
  // '12m04s'/'2m18s'/'48s' being 6/5/3 wide and the ids being 17/15/16.
  const clockEnd = lines.map((l) => l.indexOf('s ·') + 1);
  const toolsEnd = lines.map((l) => l.indexOf(' tools'));
  assert.equal(new Set(clockEnd).size, 1, `clock column drifts: ${clockEnd.join(',')}`);
  assert.equal(new Set(toolsEnd).size, 1, `tools column drifts: ${toolsEnd.join(',')}`);
});

test('the design mock in TERMINAL-UI.md is not internally aligned, so we align instead', () => {
  // Recorded deliberately. The design spec's three sample rows put the clock at
  // column 20 on line 1 and column 21 on line 2 — the mock is hand-drawn and its
  // own rows do not agree. Matching it byte-for-byte would mean shipping a layout
  // that visibly tears as soon as a 3-digit job id shows up, which is the exact
  // failure TERMINAL-UI.md's alignment rule exists to prevent. We implement the
  // RULE (fixed-width, right-aligned, identical columns) rather than the typo.
  // See the pushback note in surfaces/mod/README.md.
  const a = formatJobLine(job({ id: 'implement-musm82da', startedAt: 0, endedAt: 724_000, toolCount: 341 }), { idWidth: 18 });
  const b = formatJobLine(job({ id: 'review-muroviej', startedAt: 0, endedAt: 138_000, toolCount: 22 }), { idWidth: 18 });
  assert.notEqual(a, b, 'sanity: different jobs render different lines');
  assert.equal(a.indexOf(' tools'), b.indexOf(' tools'));
});

test('a running job with no known start renders a blank clock, not 0s', () => {
  const line = formatJobLine(job({ startedAt: null, toolCount: null }));
  // StartedAt null means the elapsed time is UNKNOWN. "0s" would be a lie about a
  // job that has been working for half an hour.
  assert.ok(!line.includes('0s'), `blank clock expected, got: ${line}`);
  assert.ok(!line.includes('tools'), 'the tools segment must be omitted too');
});

test('a line with an unknown tool count has no dangling separator', () => {
  // A naive join produces "·  ·" here, which reads as a rendering bug rather than
  // as absent data. The clock still renders — only the tools segment is dropped.
  const line = formatJobLine(job({ id: 'x', startedAt: 0, endedAt: 5_000, toolCount: null }));
  assert.ok(!line.includes('·'), `dangling separator: ${line}`);
  assert.ok(line.includes('5s'), `the clock must still render: ${line}`);
});

test('every line reads in its first 40 columns', () => {
  // TERMINAL-UI.md: "the single most important rule in this file — a line must be
  // readable in its first 40 columns. Everything past that may be truncated."
  const line = formatJobLine(
    job({
      id: 'implement-musm82da',
      startedAt: 0,
      endedAt: 724_000,
      toolCount: 341,
      activity: 'cargo test --workspace with a very long command line indeed',
    }),
    { idWidth: 18 },
  );
  assert.ok(line.slice(0, 40).includes('implement-musm82da'), `identity lost: ${line}`);
  assert.ok(line.slice(0, 40).includes('12m04s'), `liveness lost: ${line}`);
});

test('the header renders the design line exactly', () => {
  assert.equal(formatHeaderLine(2, 14), ' 2 running · 14 finished');
});

test('the header counts are padded to equal width so the separator cannot move', () => {
  // The property: within one render the two counts occupy the same width, so the
  // `·` sits at a fixed column for that render. (It does move between renders
  // when the count crosses a digit boundary — that is unavoidable and is why the
  // width is derived from the counts rather than hardcoded.)
  for (const [run, fin] of [
    [0, 0],
    [2, 14],
    [10, 4],
    [99, 99],
    [100, 3],
    [7, 1234],
  ] as const) {
    const line = formatHeaderLine(run, fin);
    const m = /^(\s*\d+) running · (\s*\d+) finished$/.exec(line);
    assert.ok(m !== null, `unparseable header: ${JSON.stringify(line)}`);
    // Capture the PADDED groups, not the digits — comparing "2".length to "14".length
    // would test the numbers and miss the alignment, which is the actual rule.
    assert.equal(m[1]!.length, m[2]!.length, `counts differ in width: ${JSON.stringify(line)}`);
    assert.ok(m[1]!.trim() === String(run) && m[2]!.trim() === String(fin), `wrong counts: ${line}`);
  }
});

test('the empty state is a literal string and nothing else', () => {
  // TERMINAL-UI.md §Empty: "No jobs → render nothing. Not 'no jobs', not an empty
  // box." The pane's one concession is this single line, because a pane with
  // genuinely zero content is indistinguishable from a pane that failed to render.
  assert.equal(EMPTY_STATE, 'No jobs yet');
});

// ── activity ────────────────────────────────────────────────────────────────

test('describeTool matches the real agy tool parameter shapes', () => {
  // Parameter names taken from the real corpus at
  // /Users/gathrid/Repos/renyi/.agy-staff/jobs, reading tool_info.parameters out
  // of every step_update record in all 20 jobs. Inventing plausible-looking names
  // here would produce a pane full of `using run_command`.
  assert.equal(
    describeTool('run_command', { CommandLine: 'cargo test --workspace' }),
    'cargo test --workspace',
  );
  assert.equal(
    describeTool('view_file', { AbsolutePath: '/Users/g/src/decoded_view.rs' }),
    'reading decoded_view.rs',
  );
  assert.equal(describeTool('write_to_file', { TargetFile: '/a/b/traps.rs' }), 'writing traps.rs');
  assert.equal(
    describeTool('replace_file_content', { TargetFile: '/a/b/vault.rs' }),
    'editing vault.rs',
  );
  assert.equal(describeTool('call_mcp_tool', { ServerName: 'agy', ToolName: 'search_web' }), 'mcp: search_web');
  // An unknown tool still renders something readable rather than blank.
  assert.equal(describeTool('future_tool', {}), 'using future_tool');
});

test('activity text is truncated at the source, never with raw output', () => {
  // TERMINAL-UI.md §Motion: "terse tool descriptions, never raw output ...
  // truncate at the source."
  const long = `cargo test --workspace ${'x'.repeat(500)}`;
  const out = describeTool('run_command', { CommandLine: long });
  assert.ok(out.length <= 41, `expected a truncated phrase, got ${out.length} chars`);
  assert.ok(out.endsWith('…'));
});

test('parseInputPreview survives the truncated JSON agy-staff actually writes', () => {
  // agy-staff truncates input_preview mid-string, so JSON.parse legitimately fails
  // on real data. This must not throw — a throw here would blank a whole job row.
  assert.deepEqual(parseInputPreview('{"CommandLine":"cargo fmt"}'), { CommandLine: 'cargo fmt' });
  assert.deepEqual(parseInputPreview('{"CommandLine":"cargo fmt'), {});
  assert.deepEqual(parseInputPreview(null), {});
  assert.deepEqual(parseInputPreview('"a string"'), {});
});

test('describeActivity reads a real progress.json input_preview', () => {
  // Verbatim shape from a real recent_activities entry in the corpus. The command
  // is 73 characters, so it comes back truncated to 40 — that is the rule working,
  // not the rule failing: TERMINAL-UI.md wants `cargo test --workspace`, not a
  // 73-column command line with a pipe and a redirect in it.
  const out = describeActivity(
    'run_command',
    '{"CommandLine":"cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -20"}',
  );
  assert.ok(out.length <= 41, `expected truncation, got ${out.length} chars`);
  assert.ok(out.startsWith('cargo clippy --workspace'));
  assert.ok(out.endsWith('…'));

  // A short real command survives intact.
  assert.equal(describeActivity('run_command', '{"CommandLine":"cargo fmt --all"}'), 'cargo fmt --all');
  assert.equal(describeActivity(null, null), '');
});

// ── small helpers ───────────────────────────────────────────────────────────

test('basename keeps the last segment only', () => {
  assert.equal(basename('/a/b/c/d.rs'), 'd.rs');
  assert.equal(basename('d.rs'), 'd.rs');
  assert.equal(basename(''), '');
});

test('ellipsis and oneLine collapse whitespace before measuring', () => {
  assert.equal(ellipsis('a   b\n\tc', 40), 'a b c');
  assert.equal(oneLine('x'.repeat(500), 100).length, 100);
});

test('ellipsis on a string at exactly the limit does not add an ellipsis', () => {
  assert.equal(ellipsis('12345', 5), '12345');
  assert.equal(ellipsis('123456', 5), '1234…');
});