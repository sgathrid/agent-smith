/** stale.ts livenessOf: the one rule the band, the pane, notices and the channel share. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALIVE_GRACE_MS, STALL_GRACE_MS, isStalled, livenessOf } from '../hooks/stale.ts';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const bash = (status: string) => ({ tool: 'Bash', input: '{"command":"npm test -- --watch=false"}', status });

test('a job that is not running has no liveness', () => {
  for (const status of ['succeeded', 'failed', 'canceled', 'unknown']) {
    assert.equal(livenessOf({ status, lastEventAt: iso(NOW), now: NOW }), null);
  }
  assert.equal(isStalled(null), false);
});

test('active: an event within the grace period', () => {
  const l = livenessOf({ status: 'running', lastEventAt: iso(NOW - 60_000), lastAliveAt: iso(NOW - 5_000), now: NOW });
  assert.equal(l?.state, 'active');
  assert.equal(l?.silentForMs, 60_000);
  assert.equal(isStalled(l), false);
});

test('in-tool: an open call is not a stall, however long, while the process lives', () => {
  const l = livenessOf({ status: 'running', lastEventAt: iso(NOW - 40 * 60_000), lastAliveAt: iso(NOW - 20_000), lastActivity: bash('active'), now: NOW });
  assert.equal(l?.state, 'in-tool');
  assert.equal(l?.tool, 'npm test -- --watch=false');
  assert.equal(l?.silentForMs, 40 * 60_000);
  assert.equal(isStalled(l), false);
});

test('silent: no events past the grace period, heartbeat fresh, last call closed', () => {
  const l = livenessOf({ status: 'running', lastEventAt: NOW - STALL_GRACE_MS - 1, lastAliveAt: NOW - 1_000, lastActivity: bash('done'), now: NOW });
  assert.equal(l?.state, 'silent');
  assert.equal(l?.tool, undefined);
  assert.equal(isStalled(l), true);
});

test('dead: heartbeat older than the alive grace outranks an open call', () => {
  const l = livenessOf({ status: 'running', lastEventAt: iso(NOW - 60_000), lastAliveAt: iso(NOW - ALIVE_GRACE_MS - 1), lastActivity: bash('active'), now: NOW });
  assert.equal(l?.state, 'dead');
  assert.equal(l?.since, NOW - ALIVE_GRACE_MS - 1);
  assert.equal(l?.forMs, ALIVE_GRACE_MS + 1);
  assert.equal(isStalled(l), true);
});

test('older builds (no heartbeat): the old silence rule, labelled silent, even mid-call', () => {
  const quiet = livenessOf({ status: 'running', updatedAt: iso(NOW - 16 * 60_000), lastActivity: bash('active'), now: NOW });
  assert.equal(quiet?.state, 'silent');
  assert.equal(quiet?.tool, 'npm test -- --watch=false');
  assert.equal(livenessOf({ status: 'running', updatedAt: iso(NOW - 60_000), lastActivity: bash('active'), now: NOW })?.state, 'in-tool');
  assert.equal(livenessOf({ status: 'running', updatedAt: iso(NOW - 60_000), now: NOW })?.state, 'active');
});

test('no event time at all is silent, never healthy; waiting is reserved and never produced', () => {
  assert.equal(livenessOf({ status: 'running', now: NOW })?.state, 'silent');
  assert.equal(livenessOf({ status: 'attention', lastEventAt: 'not a date', now: NOW })?.state, 'silent');
  const states = new Set<string>();
  for (const ev of [0, 60_000, STALL_GRACE_MS + 1]) for (const alive of [null, 1_000, ALIVE_GRACE_MS + 1]) for (const a of [null, bash('active'), bash('done')]) {
    states.add(livenessOf({ status: 'running', lastEventAt: NOW - ev, lastAliveAt: alive === null ? null : NOW - alive, lastActivity: a, now: NOW })!.state);
  }
  assert.ok(!states.has('waiting'));
});

test('ISO strings and epoch ms give the same answer', () => {
  const a = livenessOf({ status: 'running', lastEventAt: iso(NOW - 20 * 60_000), lastAliveAt: iso(NOW - 10_000), now: NOW });
  const b = livenessOf({ status: 'running', lastEventAt: NOW - 20 * 60_000, lastAliveAt: NOW - 10_000, now: NOW });
  assert.deepEqual(a, b);
});
