import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reportSummary } from '../text.ts';

test('reportSummary cuts at a paragraph, else a line, else raw', () => {
  assert.equal(reportSummary('short', 10), 'short');
  assert.equal(reportSummary('aaaa\n\nbbbb\n\ncc', 9), 'aaaa');
  assert.equal(reportSummary('aaaa\nbbbb', 7), 'aaaa');
  assert.equal(reportSummary('aaaa\nbbbb\ncccc', 9), 'aaaa\nbbbb');
  assert.equal(reportSummary('abcdefghij', 4), 'abcd');
  assert.equal(reportSummary(`Lead.\n\n${'x'.repeat(2_000)}`), 'Lead.');
});

test('reportSummary skips a leading Status line', () => {
  assert.equal(reportSummary('Status: DONE\n\nFixed the bug in parser.ts.', 100), 'Fixed the bug in parser.ts.');
  assert.equal(reportSummary('Status: DONE_WITH_CONCERNS\nPartial fix.', 100), 'Partial fix.');
  assert.equal(reportSummary('Status: BLOCKED', 100), '');
  assert.equal(reportSummary('Report body\nStatus: DONE', 100), 'Report body\nStatus: DONE');
});
