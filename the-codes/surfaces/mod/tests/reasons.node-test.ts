/** reasons.ts: every failure in two to four words, from structured facts or from old prose. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { checksReason, deniedReason, exitReason, reasonFromText } from '../hooks/reasons.ts';

test('structured reasons name one thing and count the rest', () => {
  assert.equal(deniedReason(['view_file']), 'denied: view_file');
  assert.equal(deniedReason(['view_file', 'RunCommand', 'view_file', 'Write']), 'denied: view_file +2');
  assert.equal(deniedReason([]), 'denied');
  assert.equal(checksReason(['lint']), 'checks failed: lint');
  assert.equal(checksReason(['lint', 'tests']), 'checks failed: lint +1');
  assert.equal(exitReason(1), 'exit 1');
});

test('old prose maps to the same short reasons', () => {
  const cases: Array<[string, string]> = [
    ['worker soft-denied 1 tool action(s) (view_file) — it exited 0 and reported success while doing nothing. This is NOT a clean success. — agy soft-denied 1 tool action(s) (view_file).', 'denied: view_file'],
    ['supervisor process exited before the job finished (orphaned)', 'server stopped'],
    ['worker reported success but delivered no usable output — treating as failed, not as a clean success.', 'no output'],
    ['exceeded the 2700000 ms budget and was killed', 'timed out'],
    ['Error: 401 Unauthorized', 'not logged in'],
    ['insufficient_quota: You exceeded your current quota', 'out of credits'],
    ['429 Too Many Requests', 'rate limited'],
    ["error: unexpected argument '--effort' found", 'bad flag or model'],
    ['spawn codex ENOENT', "couldn't start"],
    ['fetch failed: ECONNRESET', 'network error'],
    ['agy exited with code 1 without emitting a result event. stderr tail: (empty)', 'crashed'],
    ['Job preparation failed: Error: Task store capacity reached', 'setup failed'],
    ['codex exited with code 2: something odd happened in a long way that is not short', 'exit 2'],
    ['segfault', 'segfault'],
    ['', 'worker error'],
    ['a long unrecognisable paragraph of provider prose that explains nothing useful at a glance', 'worker error'],
  ];
  for (const [text, want] of cases) assert.equal(reasonFromText(text), want, text);
});
