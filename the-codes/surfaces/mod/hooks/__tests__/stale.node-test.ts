import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STALL_GRACE_MS, livenessOf } from '../stale.ts';

const now = Date.parse('2026-01-01T12:00:00Z');
const needsAttention = (l: ReturnType<typeof livenessOf>): boolean =>
  l !== null && (l.state === 'silent' || l.state === 'dead');

test('livenessOf: a settled job has no liveness', () => {
  for (const status of ['succeeded', 'failed', 'canceled', 'unknown']) {
    assert.equal(livenessOf({ status, lastEventAt: null, now }), null, status);
  }
});

test('livenessOf: unknown or unparsable progress time is silent, never healthy', () => {
  assert.equal(livenessOf({ status: 'running', now })?.state, 'silent');
  assert.equal(livenessOf({ status: 'running', lastEventAt: null, now })?.state, 'silent');
  assert.equal(livenessOf({ status: 'running', lastEventAt: 'not a date', now })?.state, 'silent');
});

test('livenessOf: the grace boundary, for ISO strings and epoch ms', () => {
  const quiet = (t: string | number) => needsAttention(livenessOf({ status: 'running', lastEventAt: t, now }));
  assert.equal(quiet(now - STALL_GRACE_MS), false);
  assert.equal(quiet(now - STALL_GRACE_MS - 1), true);
  assert.equal(quiet(new Date(now - 1000).toISOString()), false);
  assert.equal(quiet(new Date(now - STALL_GRACE_MS - 1000).toISOString()), true);
});
