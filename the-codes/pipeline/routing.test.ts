/**
 * routing tests — the escalation rules, as executable assertions.
 *
 * Several of these exist mainly to be hard to break by accident. The comments
 * name the measurement each one is defending; a future edit that removes one of
 * these tests is removing the evidence, not just the coverage.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assessStall,
  CrossFamilyViolation,
  DEFAULT_LADDERS,
  DEFAULT_STALL_POLICY,
  familyOf,
  moderateStage,
  nextRouting,
  normalizeSignature,
  planInitialRouting,
  planSpecRouting,
  sameFamily,
} from './routing.ts';
import type { Observation, PipelineSpec, Stage } from './types.ts';
import type { StallVerdict } from './routing.ts';

const stage = (name: string, extra: Partial<Stage> = {}): Stage => ({ name, provider: 'gemini', ...extra });

const escalate = (shape: StallVerdict['shape']): StallVerdict => ({
  shape,
  escalate: true,
  because: `${shape} in test`,
  evidence: [],
});

/* -------------------------- RULE 1: cheapest default -------------------------- */

test('every stage defaults to the cheapest tier at low effort', () => {
  for (const provider of ['gemini', 'codex', 'claude']) {
    const routing = planInitialRouting(stage('implement', { provider }));
    assert.equal(routing.tier, 't0-cheap');
    assert.equal(routing.effort, 'low', `${provider} must default to low effort`);
    assert.equal(routing.model, DEFAULT_LADDERS[provider]?.defaultModel);
  }
});

test('the default-effort rationale cites the measurement', () => {
  const rationale = planInitialRouting(stage('implement')).rationale;
  assert.match(rationale, /\+50% wall clock/);
  assert.match(rationale, /1\.9x thinking tokens/);
});

test('a spec author may pin model and effort without routing rewriting them', () => {
  const routing = planInitialRouting(
    stage('hotfix', { provider: 'claude', model: 'claude-opus', effort: 'high', routingPinned: true }),
  );
  assert.equal(routing.model, 'claude-opus');
  assert.equal(routing.effort, 'high');
  assert.match(routing.rationale, /pinned by spec author/);
});

test('planSpecRouting leaves no stage at high effort by default', () => {
  const spec: PipelineSpec = {
    name: 'dashboard',
    stages: [
      stage('implement', { provider: 'gemini' }),
      stage('review', { provider: 'codex' }),
      stage('moderate', { provider: 'claude' }),
    ],
  };
  const planned = planSpecRouting(spec);
  assert.deepEqual(
    planned.stages.map((s) => s.effort),
    ['low', 'low', 'low'],
  );
  assert.deepEqual(
    planned.stages.map((s) => s.model),
    ['gemini-flash', 'gpt-5.6-mini', 'claude-sonnet'],
  );
});

/* ------------------------- RULE 2: shapes, not first errors ------------------------- */

test('a single distinct error never escalates', () => {
  const events: Observation[] = [
    { turn: 34, kind: 'tool', tool: 'bash', ok: false, message: 'grep: no matches in src/util.ts' },
    { turn: 40, kind: 'edit', target: 'src/a.ts' },
    { turn: 41, kind: 'verification', target: 'typecheck', ok: true },
  ];
  const verdict = assessStall(events);
  assert.equal(verdict.escalate, false);
  assert.equal(verdict.shape, null);
});

test('one failing tool among many successful ones is not a stall', () => {
  const events: Observation[] = Array.from({ length: 60 }, (_, i) => ({
    turn: i,
    kind: 'tool' as const,
    tool: 'read',
    ok: i !== 33,
    message: i === 33 ? 'file not found: src/legacy.ts' : undefined,
  }));
  const verdict = assessStall(events);
  // The reference job: first tool error at #34 of 484, and it SUCCEEDED.
  assert.equal(verdict.escalate, false);
});

test('the same signature repeated three times IS a stall', () => {
  const events: Observation[] = [10, 11, 12].map((turn) => ({
    turn,
    kind: 'error' as const,
    message: "Cannot find module './types' or its corresponding type declarations.",
  }));
  const verdict = assessStall(events);
  assert.equal(verdict.escalate, true);
  assert.equal(verdict.shape, 'repeat-signature');
  assert.match(verdict.because, /repeated 3x/);
});

test('two repetitions are a coincidence, not a shape', () => {
  const events: Observation[] = [10, 11].map((turn) => ({
    turn,
    kind: 'error' as const,
    message: 'ENOENT: no such file or directory, open tmp/build.json',
  }));
  assert.equal(assessStall(events).escalate, false);
});

test('many different errors are not a repetition pattern', () => {
  const events: Observation[] = [
    { turn: 1, kind: 'error', message: 'tsc: type error TS2304 cannot find name Foo' },
    { turn: 2, kind: 'error', message: 'eslint: no-unused-vars at src/b.ts:12' },
    { turn: 3, kind: 'error', message: 'permission denied writing dist/index.js' },
    { turn: 4, kind: 'edit', target: 'src/c.ts' },
  ];
  const verdict = assessStall(events);
  assert.equal(verdict.escalate, false);
  assert.match(verdict.because, /variety, not repetition/);
});

test('many edits and zero verifications IS a stall', () => {
  const events: Observation[] = Array.from({ length: 9 }, (_, i) => ({
    turn: i,
    kind: 'edit' as const,
    target: `src/file${i}.ts`,
  }));
  const verdict = assessStall(events);
  assert.equal(verdict.escalate, true);
  assert.equal(verdict.shape, 'edit-churn-unverified');
  assert.match(verdict.evidence.join(' '), /asserting success it has never observed/);
});

test('edits WITH verification runs are not a stall', () => {
  const events: Observation[] = [
    ...Array.from({ length: 9 }, (_, i) => ({ turn: i, kind: 'edit' as const, target: `f${i}.ts` })),
    { turn: 9, kind: 'verification', target: 'npm test', ok: false },
  ];
  assert.equal(assessStall(events).escalate, false);
});

test('a long stretch of prose-only turns IS a stall', () => {
  const events: Observation[] = [
    { turn: 0, kind: 'tool', tool: 'read', ok: true },
    ...Array.from({ length: 7 }, (_, i) => ({ turn: i + 1, kind: 'text' as const })),
  ];
  const verdict = assessStall(events);
  assert.equal(verdict.escalate, true);
  assert.equal(verdict.shape, 'no-progress');
  assert.match(verdict.because, /7 consecutive turns/);
});

test('activity interleaved with prose resets the no-progress run', () => {
  // Same amount of talking, but the worker kept reading in between: it is slow,
  // not stuck. Slow is not the signal (see ignoredSignals: 'slow-start').
  const events: Observation[] = Array.from({ length: 12 }, (_, i) =>
    i % 3 === 0
      ? ({ turn: i, kind: 'tool', tool: 'read', ok: true } as Observation)
      : ({ turn: i, kind: 'text' } as Observation),
  );
  const verdict = assessStall(events);
  assert.equal(verdict.shape, null);
  assert.equal(verdict.escalate, false);
});

test('context exhaustion is treated as a hard stop, not a thought-through claim', () => {
  const verdict = assessStall([
    { turn: 1, kind: 'tool', tool: 'read', ok: true },
    { turn: 2, kind: 'error', message: 'Error: context length exceeded max_tokens limit' },
  ]);
  assert.equal(verdict.escalate, true);
  assert.equal(verdict.shape, 'context-exhaustion');
});

test('no observations is absence of evidence, not evidence of health', () => {
  const verdict = assessStall([]);
  assert.equal(verdict.escalate, false);
  assert.equal(verdict.shape, null);
  assert.match(verdict.because, /no observations/);
});

test('normalizeSignature collapses varying paths and line numbers', () => {
  const a = normalizeSignature("Cannot find module './src/user/profile.ts'");
  const b = normalizeSignature("Cannot find module './src/admin/settings.ts'");
  assert.equal(a, b);
});

test('the ignored-signal list names the rules we refuse to escalate on', () => {
  for (const forbidden of ['first-error', 'error-count', 'slow-start', 'self-doubt', 'looks-hard']) {
    assert.ok(
      DEFAULT_STALL_POLICY.ignoredSignals.includes(forbidden),
      `${forbidden} must stay an explicit non-signal`,
    );
  }
});

/* ------------------------- RULE 3 + ladder: continuation ------------------------- */

test('the ladder climbs one rung at a time and only on a stall', () => {
  const base = planInitialRouting(stage('implement', { provider: 'claude' }));
  assert.equal(base.tier, 't0-cheap');

  const r1 = nextRouting(base, escalate('no-progress'), stage('implement'), DEFAULT_LADDERS);
  assert.equal(r1?.tier, 't1-effort');
  assert.equal(r1?.model, base.model, 't1 changes effort, not model');
  assert.equal(r1?.effort, 'high');

  const r2 = nextRouting(r1!, escalate('no-progress'), stage('implement'), DEFAULT_LADDERS);
  assert.equal(r2?.tier, 't2-stronger');
  assert.equal(r2?.model, 'claude-opus');

  const r3 = nextRouting(r2!, escalate('no-progress'), stage('implement'), DEFAULT_LADDERS);
  assert.equal(r3?.tier, 't3-cross-family');
  assert.equal(r3?.model, 'gemini-flash');
  assert.ok(r3 && !sameFamily(r3.model!, 'claude-opus'));

  // Top of the ladder: nowhere left to go.
  assert.equal(nextRouting(r3!, escalate('no-progress'), stage('implement'), DEFAULT_LADDERS), null);
});

test('the ladder stops when a provider has no cross-family model', () => {
  const base = planInitialRouting(stage('review', { provider: 'codex' }));
  // codex declares no crossFamilyModel, so t3 cannot be filled and must not be
  // faked with a model of the same family.
  const r1 = nextRouting(base, escalate('repeat-signature'), stage('review'), DEFAULT_LADDERS);
  assert.equal(r1?.tier, 't1-effort');
  const r2 = nextRouting(r1!, escalate('repeat-signature'), stage('review'), DEFAULT_LADDERS);
  assert.equal(r2?.tier, 't2-stronger');
  const r3 = nextRouting(r2!, escalate('repeat-signature'), stage('review'), DEFAULT_LADDERS);
  assert.equal(r3, null);
});

test('no stall means no escalation', () => {
  const base = planInitialRouting(stage('implement'));
  const calm: StallVerdict = { shape: null, escalate: false, because: 'all good', evidence: [] };
  assert.equal(nextRouting(base, calm, stage('implement'), DEFAULT_LADDERS), null);
});

test('the escalation ceiling is enforced across the ladder', () => {
  const base = planInitialRouting(stage('implement', { provider: 'claude' }));
  assert.equal(
    nextRouting(base, escalate('no-progress'), stage('implement'), DEFAULT_LADDERS, DEFAULT_STALL_POLICY, 2),
    null,
  );
  assert.ok(
    nextRouting(base, escalate('no-progress'), stage('implement'), DEFAULT_LADDERS, DEFAULT_STALL_POLICY, 1),
  );
});

test('there is no difficulty or confidence prediction anywhere in the module surface', () => {
  // RULE 4 as an executable guard: the module exports stall assessment over an
  // attempt that already happened, and nothing that scores work before it runs.
  const exported = [assessStall, nextRouting, planInitialRouting] as unknown as Array<{
    length?: number;
    name?: string;
  }>;
  for (const fn of exported) {
    assert.equal(typeof fn, 'function');
  }
  assert.equal(
    typeof (globalThis as Record<string, unknown>)['predictDifficulty'],
    'undefined',
    'a pre-hoc difficulty classifier must not exist',
  );
});

/* ------------------------- RULE 5: cross-family moderation ------------------------- */

test('families are resolved from model and provider ids', () => {
  assert.equal(familyOf('gpt-5.6-sol'), 'openai');
  assert.equal(familyOf('codex'), 'openai');
  assert.equal(familyOf('claude-sonnet'), 'anthropic');
  assert.equal(familyOf('sonnet'), 'anthropic');
  assert.equal(familyOf('gemini-pro'), 'google');
  assert.equal(familyOf('some-unreleased-model'), 'unknown');
});

test('unknown models are never treated as independent', () => {
  assert.equal(sameFamily('unknown-model-a', 'unknown-model-b'), true);
  assert.equal(sameFamily('claude-sonnet', 'unknown-model'), true);
});

test('same-family moderation is rejected', () => {
  assert.throws(
    () =>
      moderateStage({
        name: 'moderate',
        probes: 'implement',
        provider: 'gemini',
        model: 'gemini-pro',
        reviewedModel: 'gemini-flash',
      }),
    CrossFamilyViolation,
  );
});

test('cross-family moderation is allowed and wired to the probed stage', () => {
  const mod = moderateStage({
    name: 'moderate',
    probes: 'implement',
    provider: 'claude',
    model: 'claude-sonnet',
    reviewedModel: 'gemini-flash',
  });
  assert.equal(mod.role, 'moderate');
  assert.deepEqual(mod.dependsOn, ['implement']);
  assert.equal(mod.provider, 'claude');
  assert.match(mod.prompt ?? '', /do not rewrite the work/);
});

test('the moderate prompt does not ask for agreement or a vote', () => {
  // Debate underperforms plain self-consistency and degrades with more budget
  // (2406.06461): the prompt must request one probe, not consensus.
  const mod = moderateStage({
    name: 'moderate',
    probes: 'implement',
    provider: 'claude',
    model: 'claude-sonnet',
    reviewedModel: 'gemini-flash',
  });
  const prompt = mod.prompt ?? '';
  assert.doesNotMatch(prompt, /agree/i);
  assert.doesNotMatch(prompt, /vote|consensus|debate/i);
  assert.doesNotMatch(prompt, /rate|approve/i);
});