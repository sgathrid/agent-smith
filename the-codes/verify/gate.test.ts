/**
 * gate tests — the accept / escalate / stop decision.
 *
 * These use real commands against a real temporary working tree, including the
 * escalation: the "worker" fixes the tree by creating the marker file, and the
 * recheck has to see that. A gate that cached its first verdict would pass these
 * tests only if it were reading the tree, which is the entire point.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  decideGate,
  ESCALATION_CEILING,
  failingCommand,
  formatEscalationContext,
  runGate,
  type EscalationRequest,
} from './gate.ts';
import { runCheck } from './runner.ts';
import type { Check, Verdict } from './types.ts';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'agent-smith-gate-'));
}

/** Passes only once the marker file exists — i.e. only once the worker "fixes" it. */
function markerCheck(cwd: string, name = 'test'): Check {
  return {
    name,
    command: `test -f ${join(cwd, 'fixed.marker')}`,
    cwd,
    timeoutMs: 5_000,
    expect: { kind: 'exit0' },
  };
}

const ok = { passed: true } as const;

/* ------------------------------ the policy itself ------------------------------ */

test('passing checks are accepted', () => {
  assert.equal(decideGate(ok, 0), 'accept');
});

test('failing checks escalate, then stop', () => {
  const failing = { passed: false };
  assert.equal(decideGate(failing, 0), 'escalate');
  assert.equal(decideGate(failing, ESCALATION_CEILING), 'stop');
});

test('the escalation ceiling is one, and is not a configurable default', () => {
  // A loop is worse than a stop: self-correction via prompting does not work
  // (TACL 2024), so more than one retry is not more thorough.
  assert.equal(ESCALATION_CEILING, 1);
});

/* --------------------------------- runGate --------------------------------- */

test('a clean run accepts without escalating', async () => {
  const cwd = scratch();
  try {
    writeFileSync(join(cwd, 'fixed.marker'), '');
    let escalations = 0;
    const report = await runGate({
      checks: [markerCheck(cwd)],
      escalate: () => {
        escalations += 1;
      },
    });
    assert.equal(report.outcome, 'accepted');
    assert.equal(report.passed, true);
    assert.equal(report.escalations, 0);
    assert.equal(escalations, 0, 'a passing gate must not bother the worker');
    assert.equal(report.attempts.length, 1);
    assert.deepEqual(report.failingCommands, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a failing run escalates once, and the recheck sees the fixed tree', async () => {
  const cwd = scratch();
  try {
    const requests: EscalationRequest[] = [];
    const report = await runGate({
      checks: [markerCheck(cwd)],
      escalate: (request) => {
        requests.push(request);
        // The worker acts on the request: fix the tree.
        writeFileSync(join(cwd, 'fixed.marker'), 'ok');
      },
    });

    assert.equal(report.outcome, 'escalated-accepted');
    assert.equal(report.passed, true);
    assert.equal(report.escalations, 1);
    assert.equal(requests.length, 1);

    // Both attempts are kept: the first failure is the evidence.
    assert.equal(report.attempts.length, 2);
    assert.equal(report.attempts[0]?.decision, 'escalate');
    assert.equal(report.attempts[1]?.decision, 'accept');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a still-failing run stops after exactly ONE escalation', async () => {
  const cwd = scratch();
  try {
    let escalations = 0;
    const report = await runGate({
      checks: [markerCheck(cwd)],
      // The "worker" does nothing useful. The gate must not keep asking.
      escalate: () => {
        escalations += 1;
      },
    });

    assert.equal(escalations, 1, 'the gate must not retry more than once');
    assert.equal(report.outcome, 'stopped');
    assert.equal(report.passed, false);
    assert.equal(report.escalations, 1);
    assert.equal(report.attempts.length, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the stop report hands over the exact failing command', async () => {
  const cwd = scratch();
  try {
    const report = await runGate({
      checks: [markerCheck(cwd, 'test')],
      escalate: () => {},
    });
    assert.equal(report.outcome, 'stopped');
    assert.equal(report.failingCommands.length, 1);
    // Not a paraphrase: the command, the directory, and the verdict.
    assert.match(report.failingCommands[0] ?? '', /test -f .*fixed\.marker/);
    assert.match(report.failingCommands[0] ?? '', new RegExp(cwd.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')));
    assert.match(report.failingCommands[0] ?? '', /exit 1/);
    assert.match(report.reason, /still failing after 1 escalation/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('without an escalate hook the gate stops instead of re-running', async () => {
  const cwd = scratch();
  try {
    const report = await runGate({ checks: [markerCheck(cwd)] });
    assert.equal(report.outcome, 'stopped');
    assert.equal(report.passed, false);
    assert.match(report.reason, /no escalate hook supplied/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('an empty check set is unverifiable, never an automatic accept', async () => {
  let escalations = 0;
  const report = await runGate({
    checks: [],
    escalate: () => {
      escalations += 1;
    },
  });
  // Absence of failure is not evidence of success: nothing ran.
  assert.equal(report.outcome, 'unverifiable');
  assert.equal(report.passed, false);
  assert.equal(escalations, 0);
  assert.match(report.reason, /no checks configured/);
});

test('a check set where nothing could run is unverifiable', async () => {
  const cwd = scratch();
  try {
    const report = await runGate({
      checks: [{ name: 'blank', command: '   ', cwd, timeoutMs: 1_000 }],
      escalate: () => {},
    });
    assert.equal(report.outcome, 'unverifiable');
    assert.equal(report.passed, false);
    assert.match(report.reason, /every check was skipped/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a partially unrunnable check set still accepts on what did run', async () => {
  const cwd = scratch();
  try {
    writeFileSync(join(cwd, 'fixed.marker'), '');
    const report = await runGate({
      checks: [
        markerCheck(cwd),
        { name: 'lint', command: '   ', cwd, timeoutMs: 1_000 },
      ],
      escalate: () => {},
    });
    assert.equal(report.outcome, 'accepted');
    assert.equal(report.passed, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the gate surfaces the specific failing check, not just "failed"', async () => {
  const cwd = scratch();
  try {
    const report = await runGate({
      checks: [
        { name: 'typecheck', command: 'exit 0', cwd, timeoutMs: 5_000 },
        markerCheck(cwd, 'test'),
      ],
      escalate: () => {},
    });
    assert.equal(report.failing.length, 1);
    assert.equal(report.failing[0]?.check.name, 'test');
    assert.match(report.reason, /test -f/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

/* --------------------------- escalation context --------------------------- */

test('the escalation context carries the exact command and its output', async () => {
  const cwd = scratch();
  try {
    let captured = '';
    await runGate({
      checks: [{ name: 'typecheck', command: 'echo "src/a.ts:7: error TS2345" >&2; exit 2', cwd, timeoutMs: 5_000 }],
      escalate: (request) => {
        captured = request.context;
      },
    });
    assert.match(captured, /check: typecheck/);
    assert.match(captured, /command: echo "src\/a\.ts:7: error TS2345" >&2; exit 2/);
    assert.match(captured, /exit 2/);
    assert.match(captured, /error TS2345/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the escalation context is evidence, not an instruction', async () => {
  const cwd = scratch();
  try {
    let captured = '';
    await runGate({
      checks: [{ name: 'test', command: 'echo nope >&2; exit 1', cwd, timeoutMs: 5_000 }],
      escalate: (request) => {
        captured = request.context;
      },
    });
    // Telling the agent what to fix reproduces the generic-self-check failure
    // (5/10 vs an external 10/10, p=0.0325). Facts, no orders.
    assert.doesNotMatch(captured, /\bfix\b/i);
    assert.doesNotMatch(captured, /you must|make sure|ensure that/i);
    assert.match(captured, /Facts only/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the escalation context is bounded', () => {
  const verdict: Verdict = {
    passed: false,
    check: { name: 'test', command: 'cargo test', cwd: '/tmp', timeoutMs: 1_000 },
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdoutTail: 'x'.repeat(50_000),
    stderrTail: '',
    truncated: true,
    durationMs: 10,
    reason: 'exit 1, expecting exit code 0',
    blocking: true,
  };
  const text = formatEscalationContext([verdict], 1024);
  assert.ok(text.length <= 1024 + 40, `context must be bounded, got ${text.length}`);
  assert.match(text, /truncated/);
  // The head survives: the command and the identity of the failure.
  assert.match(text, /check: test/);
  assert.match(text, /cargo test/);
});

test('a timeout is called out explicitly in the escalation context', async () => {
  const cwd = scratch();
  try {
    let captured = '';
    await runGate({
      checks: [{ name: 'test', command: 'sleep 5', cwd, timeoutMs: 120 }],
      escalate: (request) => {
        captured = request.context;
      },
    });
    // "It hung" is a different problem from "it failed", and the worker needs to
    // know it was a hang.
    assert.match(captured, /killed on timeout/);
    assert.match(captured, /timed out after 120ms/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('failingCommand names the command, the directory and the verdict', async () => {
  const cwd = scratch();
  try {
    const verdict = await runCheck({ name: 'x', command: 'exit 9', cwd, timeoutMs: 5_000 });
    const line = failingCommand(verdict);
    assert.match(line, /exit 9/);
    assert.match(line, new RegExp(cwd.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')));
    assert.match(line, /exit 9, expecting exit code 0/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});