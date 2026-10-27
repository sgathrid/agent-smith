import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STALL_GRACE_MS, isStalled } from '../stale.ts';

const now = Date.parse('2026-01-01T12:00:00Z');

test('isStalled: only a running job can stall', () => {
  for (const status of ['succeeded', 'failed', 'canceled', 'attention', 'unknown']) {
    assert.equal(isStalled(status, null, now), false, status);
  }
});

test('isStalled: unknown or unparsable progress time is stalled', () => {
  assert.equal(isStalled('running', null, now), true);
  assert.equal(isStalled('running', undefined, now), true);
  assert.equal(isStalled('running', 'not a date', now), true);
});

test('isStalled: the grace boundary, for ISO strings and epoch ms', () => {
  assert.equal(isStalled('running', now - STALL_GRACE_MS, now), false);
  assert.equal(isStalled('running', now - STALL_GRACE_MS - 1, now), true);
  assert.equal(isStalled('running', new Date(now - 1000).toISOString(), now), false);
  assert.equal(isStalled('running', new Date(now - STALL_GRACE_MS - 1000).toISOString(), now), true);
});
