/** The update check: which versions count as newer, and the one line it shows. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isNewer, manifestVersion, updateLine } from '../hooks/update.ts';

test('isNewer compares dotted versions numerically', () => {
  assert.equal(isNewer('0.2.10', '0.2.9'), true);
  assert.equal(isNewer('0.3.0', '0.2.9'), true);
  assert.equal(isNewer('0.2.1', '0.2.1'), false);
  assert.equal(isNewer('0.2.1', '0.2.2'), false);
  assert.equal(isNewer('1.0', '0.9.9'), true);
});

test('manifestVersion reads a stated dotted version and nothing else', () => {
  assert.equal(manifestVersion('{"name":"agent-smith","version":"0.2.2"}'), '0.2.2');
  assert.equal(manifestVersion('{"name":"agent-smith"}'), null);
  assert.equal(manifestVersion('{"version":"main"}'), null);
  assert.equal(manifestVersion('404: Not Found'), null);
});

test('updateLine names both versions, and only when the release is newer', () => {
  assert.equal(updateLine('0.2.1', '0.2.3'), 'agent-smith update available: v0.2.1 → v0.2.3');
  assert.equal(updateLine('0.2.3', '0.2.3'), null);
  assert.equal(updateLine('0.2.4', '0.2.3'), null);
  assert.equal(updateLine(null, '0.2.3'), null);
  assert.equal(updateLine('0.2.1', null), null);
});
