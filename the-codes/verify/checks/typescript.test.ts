/**
 * checks/typescript tests — the presets are configurable defaults, not policy.
 *
 * The recurring assertion is that no emitted check has an empty command. A check
 * with nothing to run is the config-level version of the agy failure mode, so
 * the preset refuses to emit one rather than letting it fail at gate time.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { readPackageScripts, typescriptChecks } from './typescript.ts';

function repo(scripts?: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-smith-ts-'));
  if (scripts) {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts }));
  }
  return root;
}

function names(scripts: readonly { name: string }[]): string[] {
  return scripts.map((c) => c.name);
}

/* ---------------------------- script discovery ---------------------------- */

test('readPackageScripts returns the real scripts', () => {
  const root = repo({ typecheck: 'tsc --noEmit', test: 'vitest run', lint: 'eslint .' });
  try {
    assert.deepEqual(readPackageScripts(root), {
      typecheck: 'tsc --noEmit',
      test: 'vitest run',
      lint: 'eslint .',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readPackageScripts returns null when there is no package.json', () => {
  const root = repo();
  try {
    assert.equal(readPackageScripts(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed package.json is unknown, not fatal', () => {
  const root = repo();
  try {
    writeFileSync(join(root, 'package.json'), '{ this is not json');
    assert.equal(readPackageScripts(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a package.json with no scripts field yields an empty map', () => {
  const root = repo();
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"x"}');
    assert.deepEqual(readPackageScripts(root), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------- npm presets ------------------------------- */

test('the default preset finds the standard three scripts', () => {
  const root = repo({ typecheck: 'tsc --noEmit', test: 'vitest run', lint: 'eslint .' });
  try {
    const checks = typescriptChecks({ root });
    assert.deepEqual(names(checks), ['typecheck', 'test', 'lint']);
    assert.deepEqual(checks.map((c) => c.command), [
      'npm run typecheck',
      'npm run test',
      'npm run lint',
    ]);
    // Every check expects exit 0. Interpretation would be the thing to remove.
    for (const c of checks) assert.deepEqual(c.expect, { kind: 'exit0' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('alternative script spellings are resolved against the real package.json', () => {
  // Repos spell this every way. Assuming the wrong name produces a guaranteed red
  // gate on a healthy repo, so we look rather than guess.
  const root = repo({ types: 'tsc --noEmit', 'test:unit': 'vitest run' });
  try {
    const checks = typescriptChecks({ root });
    const typecheck = checks.find((c) => c.name === 'typecheck');
    assert.equal(typecheck?.command, 'npm run types');

    const test = checks.find((c) => c.name === 'test');
    // No 'test' script and no exact fallback match → the test check is omitted
    // rather than emitted as a command that cannot work.
    assert.equal(test?.command, 'npm run test:unit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a script that does not exist is omitted, not emitted broken', () => {
  const root = repo({ typecheck: 'tsc --noEmit' });
  try {
    const checks = typescriptChecks({ root });
    // No lint script in package.json → no lint check. Omission, not a failure:
    // emitting `npm run lint` for a repo that has no lint script is a guaranteed
    // red gate on a healthy tree.
    assert.deepEqual(names(checks), ['typecheck']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lint can be switched off entirely', () => {
  const root = repo({ typecheck: 'tsc --noEmit', test: 'vitest run', lint: 'eslint .' });
  try {
    assert.deepEqual(names(typescriptChecks({ root, lint: false })), ['typecheck', 'test']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('script names can be overridden', () => {
  const root = repo({ ci: 'tsc --noEmit' });
  try {
    const checks = typescriptChecks({ root, scripts: { typecheck: 'ci' } });
    assert.equal(checks.find((c) => c.name === 'typecheck')?.command, 'npm run ci');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an override naming a missing script yields no check', () => {
  const root = repo({ typecheck: 'tsc --noEmit' });
  try {
    const checks = typescriptChecks({ root, scripts: { typecheck: 'does-not-exist' } });
    assert.equal(checks.find((c) => c.name === 'typecheck'), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('with no package.json the configured names are used as given', () => {
  // Unknown repository: fall back to the guess rather than emitting nothing.
  const root = repo();
  try {
    assert.deepEqual(names(typescriptChecks({ root })), ['typecheck', 'test', 'lint']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* --------------------------- package managers --------------------------- */

test('other package managers produce their own invocation form', () => {
  const root = repo({ typecheck: 'tsc --noEmit', test: 'vitest run' });
  try {
    assert.equal(
      typescriptChecks({ root, packageManager: 'pnpm' }).find((c) => c.name === 'typecheck')?.command,
      'pnpm run typecheck',
    );
    assert.equal(
      typescriptChecks({ root, packageManager: 'yarn' }).find((c) => c.name === 'typecheck')?.command,
      'yarn typecheck',
    );
    assert.equal(
      typescriptChecks({ root, packageManager: 'bun' }).find((c) => c.name === 'test')?.command,
      'bun run test',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------- direct mode ------------------------------- */

test('direct mode invokes tsc through node, with --noEmit', () => {
  const root = repo();
  try {
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    const typecheck = typescriptChecks({ root, direct: true }).find((c) => c.name === 'typecheck');
    // `node <js>` rather than `./node_modules/.bin/tsc`: the bin shim is a .cmd on
    // Windows, and the failure mode of the wrong binary is a confusing ENOENT.
    assert.match(typecheck?.command ?? '', /^node /);
    assert.match(typecheck?.command ?? '', /tsc\.js/);
    // Never emit: the gate runs against a working tree it must not modify.
    assert.match(typecheck?.command ?? '', /--noEmit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('direct mode picks vitest when installed and jest otherwise', () => {
  const withVitest = repo();
  const withJest = repo();
  try {
    mkdirSync(join(withVitest, 'node_modules', 'vitest'), { recursive: true });
    mkdirSync(join(withJest, 'node_modules', 'jest'), { recursive: true });
    assert.match(
      typescriptChecks({ root: withVitest, direct: true }).find((c) => c.name === 'test')?.command ?? '',
      /vitest/,
    );
    assert.match(
      typescriptChecks({ root: withJest, direct: true }).find((c) => c.name === 'test')?.command ?? '',
      /jest/,
    );
  } finally {
    rmSync(withVitest, { recursive: true, force: true });
    rmSync(withJest, { recursive: true, force: true });
  }
});

test('the node binary is configurable', () => {
  const root = repo();
  try {
    const typecheck = typescriptChecks({ root, direct: true, nodeBin: '/usr/local/bin/node' })
      .find((c) => c.name === 'typecheck');
    assert.match(typecheck?.command ?? '', /^\/usr\/local\/bin\/node /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------ the invariants ------------------------------ */

test('no emitted check ever has an empty command', () => {
  const roots = [
    repo(),
    repo({}),
    repo({ typecheck: 'tsc --noEmit' }),
    repo({ types: 'tsc --noEmit', test: 'vitest run', lint: 'eslint .' }),
  ];
  try {
    for (const root of roots) {
      for (const direct of [true, false]) {
        for (const c of typescriptChecks({ root, direct, lint: false })) {
          assert.ok(c.command.trim().length > 0, `empty command for ${c.name}`);
          assert.ok(c.timeoutMs > 0, `${c.name} must have a timeout`);
          assert.equal(c.cwd, root);
        }
      }
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test('timeouts and tail bounds are configurable values', () => {
  const root = repo({ typecheck: 'tsc --noEmit' });
  try {
    const checks = typescriptChecks({
      root,
      typecheckTimeoutMs: 1_234,
      maxTailBytes: 512,
    });
    const typecheck = checks.find((c) => c.name === 'typecheck');
    assert.equal(typecheck?.timeoutMs, 1_234);
    assert.equal(typecheck?.maxTailBytes, 512);
    // Unset means the runner's 8KB default, not an accidental unlimited log.
    assert.equal(checks.find((c) => c.name === 'test')?.maxTailBytes, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tests get more time than a typecheck by default', () => {
  const root = repo({ typecheck: 'tsc --noEmit', test: 'vitest run' });
  try {
    const checks = typescriptChecks({ root });
    const typecheck = checks.find((c) => c.name === 'typecheck');
    const test = checks.find((c) => c.name === 'test');
    assert.ok((test?.timeoutMs ?? 0) > (typecheck?.timeoutMs ?? 0));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});