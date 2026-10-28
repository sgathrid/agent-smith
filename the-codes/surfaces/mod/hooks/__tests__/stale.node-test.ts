import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STALL_GRACE_MS, isStalled, livenessOf } from '../stale.ts';

const now = Date.parse('2026-01-01T12:00:00Z');

test('isStalled: a settled job has no liveness and is never stalled', () => {
  for (const status of ['succeeded', 'failed', 'canceled', 'unknown']) {
    assert.equal(isStalled(livenessOf({ status, lastEventAt: null, now })), false, status);
  }
});

test('isStalled: unknown or unparsable progress time is stalled (silent), never healthy', () => {
  assert.equal(isStalled(livenessOf({ status: 'running', now })), true);
  assert.equal(isStalled(livenessOf({ status: 'running', lastEventAt: null, now })), true);
  assert.equal(isStalled(livenessOf({ status: 'running', lastEventAt: 'not a date', now })), true);
});

test('isStalled: the grace boundary, for ISO strings and epoch ms', () => {
  const at = (t: string | number) => isStalled(livenessOf({ status: 'running', lastEventAt: t, now }));
  assert.equal(at(now - STALL_GRACE_MS), false);
  assert.equal(at(now - STALL_GRACE_MS - 1), true);
  assert.equal(at(new Date(now - 1000).toISOString()), false);
  assert.equal(at(new Date(now - STALL_GRACE_MS - 1000).toISOString()), true);
});
