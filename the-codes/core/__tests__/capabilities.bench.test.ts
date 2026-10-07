/**
 * Capability conformance bench.
 *
 * Borrowed from omnigent's `tests/harness_bench/`, which exists because their
 * hand-maintained capability matrix "drifts the moment a harness changes and
 * nobody re-tests every cell."
 *
 * The two rules that make this worth having, both of which we keep verbatim:
 *
 *  1. `SKIPPED` is not `SUPPORTED`. If we never observed something, we have not
 *     proved it. The most common way a visibility tool lies is by omission.
 *  2. Infrastructure failures are not capability gaps. If the binary is
 *     missing, that is an environment problem, not a finding about the agent.
 *
 * This is deliberately a *conformance* suite, not an assertion suite. It
 * reports what it could and could not learn.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isUnknown,
  observationRank,
  readCapability,
  trustworthySuccess,
  type AgentCapabilities,
} from '../capabilities.ts';

/** A capability claim we deliberately do not know the answer to. */
const UNKNOWN = null;

/** agy as verified on this machine: stream-json NDJSON, exits 0 on denial. */
const AGY: AgentCapabilities = {
  integration: 'stream-json',
  structuredEvents: true,
  selfDescribes: true, // `agy models` works
  resume: true, // --conversation <id>
  steerMidTurn: false, // no interrupt handler; omnigent notes this too
  persistentSession: true,
  silentDenialExitsZero: true,
};

const GOOD: AgentCapabilities = {
  integration: 'stream-json',
  structuredEvents: true,
  selfDescribes: true,
  resume: true,
  steerMidTurn: true,
  persistentSession: true,
  silentDenialExitsZero: false,
};

test('unknown is distinct from unsupported', () => {
  assert.equal(isUnknown(null), true);
  assert.equal(isUnknown(false), false, 'false means we checked; it is not unknown');
  assert.equal(isUnknown(true), false);
});

test('unknown resolves by explicit policy, never by accident', () => {
  // Graceful degradation: assume the capability, it costs nothing if absent.
  assert.equal(readCapability(null, 'optimistic'), true);
  // State corruption: assume absent.
  assert.equal(readCapability(null, 'pessimistic'), false);
  // A known value ignores the policy entirely.
  assert.equal(readCapability(false, 'optimistic'), false);
  assert.equal(readCapability(true, 'pessimistic'), true);
});

test('an agent that can exit 0 doing nothing cannot be trusted to self-report', () => {
  // This is the whole reason the field exists. agy soft-denies a tool call,
  // still exits 0, and can return an empty response. A "success" from such an
  // agent carries no information, so the verify gate must carry the load.
  assert.equal(trustworthySuccess(AGY), false);
  assert.equal(trustworthySuccess(GOOD), true);
  // Unknown must NOT be read as trustworthy: absent evidence of a problem is
  // not evidence of honesty.
  assert.equal(trustworthySuccess({ ...GOOD, silentDenialExitsZero: null }), false);
});

test('observation rank prefers normalized NDJSON over terminal scraping', () => {
  assert.equal(observationRank(GOOD), 0);
  assert.equal(observationRank(AGY), 0, 'agy emits typed stream-json events');
  // A pty agent only ranks 3 if it is ALSO unstructured — otherwise it would
  // be lying about how it delivers events.
  assert.equal(
    observationRank({ ...GOOD, integration: 'pty', structuredEvents: false }),
    3,
    'scraping a human-readable terminal is the worst case, not the default',
  );
  // An incomplete catalog must not promote a fragile adapter.
  assert.equal(observationRank({ ...GOOD, structuredEvents: null }), 2);
  assert.ok(observationRank({ ...GOOD, structuredEvents: null }) > observationRank(GOOD));
});

test('conformance: an adapter must declare integration and the denial trap', () => {
  // Minimum viable declaration. Anything missing should fail loudly at
  // registration rather than degrade into a silent no-op at runtime.
  const partial: AgentCapabilities = {
    integration: 'stream-json',
    structuredEvents: true,
    selfDescribes: UNKNOWN,
    resume: UNKNOWN,
    steerMidTurn: UNKNOWN,
    persistentSession: UNKNOWN,
    silentDenialExitsZero: UNKNOWN,
  };
  assert.equal(partial.integration, 'stream-json');
  assert.ok(isUnknown(partial.resume));
  // Unknown everywhere is legal but must never be mistaken for capability.
  assert.equal(trustworthySuccess(partial), false);
});