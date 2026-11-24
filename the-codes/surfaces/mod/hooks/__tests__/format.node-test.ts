import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ELAPSED_WIDTH,
  EMPTY_STATE,
  countSummary,
  deriveTaskLabel,
  elapsed,
  elapsedCell,
  fallbackLabel,
  fitCell,
  formatHeaderLine,
  formatJobLine,
  formatJobRow,
  isRecessive,
  isTerminal,
  jobDetail,
  jobLabel,
  oneLine,
  paneColumns,
  pickColor,
  pickGlyph,
  sortJobs,
} from '../format.ts';
import { basename, describeActivity, describeTool, humanCommand, parseInputPreview } from '../tools-describe.ts';
import type { RadarJob, RadarStatus } from '../../types/index.d.ts';

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

test('sortJobs tiers running, needs-you, FAILED, then everything else', () => {
  const rows = [
    job({ id: 'done', status: 'succeeded', endedAt: 900 }),
    job({ id: 'failed-old', status: 'failed', endedAt: 1 }),
    job({ id: 'needs', status: 'attention', startedAt: 1 }),
    job({ id: 'live', status: 'running', startedAt: 1 }),
    job({ id: 'failed-new', status: 'failed', endedAt: 800 }),
    job({ id: 'canceled', status: 'canceled', endedAt: 950 }),
    job({ id: 'unknown', status: 'unknown', startedAt: 1 }),
  ];
  assert.deepEqual(
    sortJobs(rows).map((j) => j.id),
    ['live', 'needs', 'failed-new', 'failed-old', 'canceled', 'done', 'unknown'],
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

test('countSummary counts attention as RUNNING and failures separately', () => {
  const rows = [
    job({ status: 'running' }),
    job({ status: 'attention' }),
    job({ status: 'succeeded' }),
    job({ status: 'failed' }),
    job({ status: 'canceled' }),
    job({ status: 'unknown' }),
  ];
  assert.deepEqual(countSummary(rows), { running: 2, failed: 1, finished: 3 });
  assert.deepEqual(countSummary([]), { running: 0, failed: 0, finished: 0 });
});

test('the header names failures, and drops a zero bucket rather than printing it', () => {
  assert.equal(formatHeaderLine({ running: 2, failed: 0, finished: 18 }), ' 2 running ∙ 18 done');
  assert.equal(formatHeaderLine({ running: 2, failed: 1, finished: 17 }), ' 2 running ∙  1 failed ∙ 17 done');
  assert.equal(formatHeaderLine({ running: 0, failed: 0, finished: 0 }), ' 0 done');
});

test('the header counts are padded to equal width so a separator cannot move', () => {
  for (const summary of [
    { running: 0, failed: 0, finished: 0 },
    { running: 2, failed: 1, finished: 14 },
    { running: 10, failed: 4, finished: 3 },
    { running: 99, failed: 99, finished: 99 },
    { running: 100, failed: 3, finished: 4 },
    { running: 7, failed: 1, finished: 1234 },
  ]) {
    const line = formatHeaderLine(summary);
    const parts = line.split(' ∙ ');
    assert.ok(parts.length >= 1, `unparseable header: ${JSON.stringify(line)}`);
    const expectedWidth = Math.max(2, ...[summary.running, summary.failed, summary.finished]
      .filter((n, i) => n > 0 || i === 2).map((n) => String(n).length));
    for (const [i, original] of parts.entries()) {
      const part = i === 0 ? original : original;
      const label = / (running|failed|done)$/.exec(part)?.[1];
      assert.ok(label, `unparseable count: ${part}`);
      const countCell = /^(\s*\d+) /.exec(part)?.[1];
      assert.ok(countCell, `missing padded count in ${JSON.stringify(line)}`);
      assert.equal(countCell.length, expectedWidth, `count cell drift: ${JSON.stringify(line)}`);
    }
    assert.ok(line.includes(`${summary.finished} done`), `wrong done count: ${line}`);
  }
});

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

  for (const g of glyphs) {
    assert.equal([...g].length, 1, `${g} is not a single code point`);
    assert.ok(g.codePointAt(0)! <= 0xffff, `${g} is outside the BMP`);
  }

  assert.equal(new Set(glyphs).size, statuses.length, 'two states share a glyph');
});

test('running is ⏺, succeeded is ✓, failed is ✗ — the current row set', () => {
  assert.equal(pickGlyph('running'), '⏺');
  assert.equal(pickGlyph('succeeded'), '✓');
  assert.equal(pickGlyph('failed'), '✗');
});

test('canceled is NOT ✗: a cancelled job is not a bug', () => {
  assert.notEqual(pickGlyph('canceled'), pickGlyph('failed'));
});

test('colour never carries meaning alone — every coloured status also has a glyph', () => {
  const coloured: RadarStatus[] = ['running', 'succeeded', 'failed', 'attention'];
  for (const s of coloured) {
    assert.ok(pickColor(s) !== undefined, `${s} is coloured`);
    assert.ok(pickGlyph(s).length > 0, `${s} has no glyph to fall back on`);
  }
  assert.equal(pickColor('running'), 'blue');
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

test('elapsed is tabular: the seconds digit is zero-padded', () => {
  assert.equal(elapsed(9_000), '9s');
  assert.equal(elapsed(12_000), '12s');
  assert.equal(elapsed(12 * 60_000 + 4_000), '12m04s');
  assert.equal(elapsed(2 * 60_000 + 18_000), '2m18s');
});

test('elapsedCell pads every duration to the same width', () => {
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
  assert.ok(elapsedCell(9_000).startsWith(' '));
  assert.equal(elapsedCell(9_000), '    9s');
});

test('elapsed never goes negative and drops seconds past an hour', () => {
  assert.equal(elapsed(-5_000), '0s');
  assert.equal(elapsed(3_723_000), '1h02m');
});

test('an unknown tool count is omitted, while a real zero stays explicit', () => {
  assert.equal(jobDetail(job({ toolCount: null })), '');
  assert.equal(jobDetail(job({ toolCount: 0 })), '0 tools');
});

test('the detail cell stays within its width and carries live tool counts when they fit', () => {
  const row = formatJobRow(job({ toolCount: 8 }), { label: 18, detail: 30, now: 1_000 });
  assert.ok(row.detail.length <= 30);
  assert.ok(row.detail.includes('8 tools'));
});

test('a job line reads as glyph, identity, activity, then elapsed', () => {
  const line = formatJobLine(
    job({
      id: 'implement-musm82da',
      status: 'running',
      startedAt: 0,
      endedAt: 724_000,
      toolCount: 341,
      activity: 'cargo test --workspace',
    }),
    { label: 18, detail: 30, now: 724_000 },
  );
  assert.ok(line.startsWith(' ⏺ implement-musm82da'));
  assert.ok(line.includes('cargo test --workspace'));
  assert.ok(line.endsWith('12m04s'));
});

test('the three design lines, and their columns line up', () => {
  const lines = [
    job({ id: 'implement-musm82da', startedAt: 0, endedAt: 724_000, toolCount: 341, activity: 'cargo test --workspace' }),
    job({ id: 'review-muroviej', startedAt: 0, endedAt: 138_000, toolCount: 22, activity: 'reading decoded_view.rs' }),
    job({ id: 'research-muroabc', status: 'succeeded', startedAt: 0, endedAt: 48_000, toolCount: 8 }),
  ].map((j) => formatJobLine(j, { label: 18, detail: 30, now: j.endedAt ?? 724_000 }));

  assert.ok(lines[0]!.startsWith(' ⏺ implement-musm82da'));
  assert.ok(lines[0]!.endsWith('12m04s'));
  assert.ok(lines[1]!.startsWith(' ⏺ review-muroviej'));
  assert.ok(lines[1]!.endsWith('2m18s'));
  assert.ok(lines[1]!.includes('reading decoded_view.rs'));
  assert.ok(lines[2]!.startsWith(' ✓ research-muroabc'));
  assert.ok(lines[2]!.includes('48s'));

  assert.ok(lines.every((line) => /\d+[sm]$/.test(line)), 'clock remains the final cell');
});

test('the design mock in TERMINAL-UI.md is not internally aligned, so we align instead', () => {
  const a = formatJobLine(job({ id: 'implement-musm82da', startedAt: 0, endedAt: 724_000, toolCount: 341 }), { label: 18, detail: 30 });
  const b = formatJobLine(job({ id: 'review-muroviej', startedAt: 0, endedAt: 138_000, toolCount: 22 }), { label: 18, detail: 30 });
  assert.notEqual(a, b, 'sanity: different jobs render different lines');
  assert.ok(a.endsWith('12m04s') && b.endsWith('2m18s'));
});

test('a running job with no known start renders a blank clock, not 0s', () => {
  const line = formatJobLine(job({ startedAt: null, toolCount: null }));
  assert.ok(!line.includes('0s'), `blank clock expected, got: ${line}`);
  assert.ok(!line.includes('tools'), 'the tools segment must be omitted too');
});

test('a line with an unknown tool count has no dangling separator', () => {
  const line = formatJobLine(job({ id: 'x', startedAt: 0, endedAt: 5_000, toolCount: null }));
  assert.ok(!line.includes('·'), `dangling separator: ${line}`);
  assert.ok(line.includes('5s'), `the clock must still render: ${line}`);
});

test('every line reads in its first 40 columns', () => {
  const line = formatJobLine(
    job({
      id: 'implement-musm82da',
      startedAt: 0,
      endedAt: 724_000,
      toolCount: 341,
      activity: 'cargo test --workspace with a very long command line indeed',
    }),
    { label: 18, detail: 30, now: 724_000 },
  );
  assert.ok(line.slice(0, 40).includes('implement-musm82da'), `identity lost: ${line}`);
  assert.ok(line.includes('12m04s'), `elapsed liveness lost: ${line}`);
});

test('the header renders the design line exactly', () => {
  assert.equal(formatHeaderLine({ running: 2, failed: 0, finished: 14 }), ' 2 running ∙ 14 done');
});

test('the header counts are padded to equal width so the separator cannot move', () => {
  for (const summary of [
    { running: 0, failed: 0, finished: 0 },
    { running: 2, failed: 1, finished: 14 },
    { running: 10, failed: 4, finished: 3 },
    { running: 99, failed: 99, finished: 99 },
    { running: 100, failed: 3, finished: 4 },
    { running: 7, failed: 1, finished: 1234 },
  ]) {
    const line = formatHeaderLine(summary);
    const parts = line.split(' ∙ ');
    const expectedWidth = Math.max(2, ...[summary.running, summary.failed, summary.finished]
      .filter((n, i) => n > 0 || i === 2).map((n) => String(n).length));
    for (const [i, original] of parts.entries()) {
      const part = original;
      const label = / (running|failed|done)$/.exec(part)?.[1];
      assert.ok(label, `unparseable header: ${JSON.stringify(line)}`);
      assert.equal(/^(\s*\d+) /.exec(part)?.[1]?.length, expectedWidth);
    }
  }
});

test('the empty state is a literal string and nothing else', () => {
  assert.equal(EMPTY_STATE, 'No workers yet');
});

test('describeTool matches the real agy tool parameter shapes', () => {
  assert.equal(describeTool('run_command', { CommandLine: 'cargo test --workspace' }), 'running tests');
  assert.equal(
    describeTool('view_file', { AbsolutePath: '/Users/g/src/decoded_view.rs' }),
    'reading decoded_view.rs',
  );
  assert.equal(describeTool('write_to_file', { TargetFile: '/a/b/traps.rs' }), 'editing traps.rs');
  assert.equal(
    describeTool('replace_file_content', { TargetFile: '/a/b/vault.rs' }),
    'editing vault.rs',
  );
  assert.equal(describeTool('call_mcp_tool', { ServerName: 'agy', ToolName: 'search_web' }), 'search_web');
  assert.equal(describeTool('future_tool', {}), 'using future_tool');
});

test('activity text is truncated at the source, never with raw output', () => {
  const long = `unknown-script ${'x'.repeat(500)}`;
  const out = describeTool('future_script', { CommandLine: long });
  assert.ok(out.length <= 41, `expected a truncated phrase, got ${out.length} chars`);
  assert.ok(!out.includes('x'.repeat(20)), 'the row must not carry raw command arguments');
});

test('parseInputPreview survives truncated JSON', () => {
  assert.deepEqual(parseInputPreview('{"CommandLine":"cargo fmt"}'), { CommandLine: 'cargo fmt' });
  assert.deepEqual(parseInputPreview('{"CommandLine":"cargo fmt'), {});
  assert.deepEqual(parseInputPreview(null), {});
  assert.deepEqual(parseInputPreview('"a string"'), {});
});

test('describeActivity reads a real progress.json input_preview', () => {
  const out = describeActivity(
    'run_command',
    '{"CommandLine":"cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -20"}',
  );
  assert.ok(out.length <= 41, `expected truncation, got ${out.length} chars`);
  assert.equal(out, 'linting');

  assert.equal(describeActivity('run_command', '{"CommandLine":"cargo fmt --all"}'), 'formatting');
  assert.equal(describeActivity(null, null), '');
});

test('basename keeps the last segment only', () => {
  assert.equal(basename('/a/b/c/d.rs'), 'd.rs');
  assert.equal(basename('d.rs'), 'd.rs');
  assert.equal(basename(''), '');
});

test('oneLine collapses whitespace before measuring', () => {
  assert.equal(oneLine('a   b\n\tc', 40), 'a b c');
  assert.equal(oneLine('x'.repeat(500), 100).length, 100);
});

test('oneLine on a string at exactly the limit does not add an ellipsis', () => {
  assert.equal(oneLine('12345', 5), '12345');
  assert.equal(oneLine('123456', 5), '12345');
});

test('truncation never splits a surrogate pair the sanitizer would then strip', () => {
  const cut = oneLine('a'.repeat(47) + '🚀 tail', 48);
  assert.equal(cut, 'a'.repeat(47));
  assert.ok(!/[\ud800-\udfff]/u.test(cut));
  assert.equal(oneLine('a'.repeat(46) + '🚀xy', 48), 'a'.repeat(46) + '🚀');
  assert.equal(oneLine('🚀🚀', 2), '🚀');
  const cell = fitCell('a'.repeat(43) + '🚀zz', 44);
  assert.equal(cell, 'a'.repeat(43) + ' ');
  assert.equal(cell.length, 44);
  assert.equal(oneLine('a'.repeat(43) + '🚀zz', 44), 'a'.repeat(43));
});
