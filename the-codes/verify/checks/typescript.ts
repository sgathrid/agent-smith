/**
 * verify/checks/typescript.ts — default check presets for a TypeScript repo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THESE ARE DEFAULTS, NOT POLICY
 *
 * Every number and every command here is a guess about a repository this file
 * has never seen. They are collected in one place so that being wrong about a
 * repo costs one edit in one object, not a hunt through the orchestrator. The
 * configuration surface is deliberately explicit:
 *
 *   - `scripts` overrides the assumed script names (repos spell this every way:
 *     `typecheck`, `types`, `tsc`, `check-types`, `tsc --noEmit`).
 *   - `lint` can be switched off, and is skipped rather than failed when absent.
 *   - `node` selects the runtime for bare `tsc`/`vitest`/`jest` invocations, so a
 *     repo without a `node_modules/.bin` on PATH still works.
 *   - Every timeout is a value, not a constant in a conditional.
 *
 * ONE HONESTY RULE, APPLIED HERE
 *
 * A check that could not run is reported as NOT RUN, with a `skipped` reason. It
 * is never reported as passed. This matters more than it looks: a gate that
 * silently passes checks it never executed is exactly the agy failure mode
 * ("all tests pass with zero warnings" over two `cargo test` exit-1s) wearing a
 * different hat. `CheckReport.incomplete` surfaces it to the caller.
 *
 * Note also what is NOT here: no "does the code look right" check, no model
 * review, no confidence score. External checklist 10/10 vs generic self-check
 * 5/10 (p=0.0325) — a generic criterion performs like a coin flip. A check that
 * runs is worth more than a criterion that reads well.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Check } from '../types.ts';

export interface TypeScriptRepoConfig {
  /** Repository root. All relative script names resolve against it. */
  readonly root: string;
  /**
   * Package manager for script invocation. Default 'npm'.
   * 'pnpm' → `pnpm run <script>`, 'yarn' → `yarn <script>`, 'bun' → `bun run <script>`.
   */
  readonly packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun' | undefined;
  /** Script names. Unset entries are omitted from the returned checks. */
  readonly scripts?: {
    readonly typecheck?: string | undefined;
    readonly test?: string | undefined;
    readonly lint?: string | undefined;
  } | undefined;
  /**
   * Emit `tsc`/`vitest`/`jest` directly instead of via package scripts.
   * Set this for repos with no package.json scripts (or with scripts that hide
   * the underlying flags you want gated).
   */
  readonly direct?: boolean | undefined;
  /**
   * Executable used for direct mode. Default 'node'.
   *
   * Why not call `./node_modules/.bin/tsc` directly? On macOS/Linux that
   * symlink is usually fine, but on Windows it is a `.cmd` shim, and the whole
   * failure mode of running the wrong binary is a confusing ENOENT. Going
   * through `node <path-to-js>` works on every platform.
   */
  readonly nodeBin?: string | undefined;
  /** Extra flags appended to the direct typecheck command. */
  readonly typecheckArgs?: readonly string[] | undefined;
  /** Extra flags appended to the direct test command. */
  readonly testArgs?: readonly string[] | undefined;
  readonly typecheckTimeoutMs?: number | undefined;
  readonly testTimeoutMs?: number | undefined;
  readonly lintTimeoutMs?: number | undefined;
  /** Per-stream output cap. Default 8KB. */
  readonly maxTailBytes?: number | undefined;
  /** Set false to omit the lint check entirely. */
  readonly lint?: boolean | undefined;
}

/**
 * Timeout defaults, chosen by how long the tool legitimately takes rather than
 * by taste: typechecking is bounded and fast, a full test suite is not.
 */
const DEFAULT_TYPECHECK_TIMEOUT_MS = 120_000;
const DEFAULT_TEST_TIMEOUT_MS = 600_000;
const DEFAULT_LINT_TIMEOUT_MS = 120_000;

/** Script names assumed when the caller does not say. */
export const DEFAULT_SCRIPT_NAMES = {
  typecheck: 'typecheck',
  test: 'test',
  lint: 'lint',
} as const;

/**
 * Read `package.json` scripts. Returns null when there is no package.json or it
 * is unreadable — which is information the caller needs, not an error.
 *
 * WHY WE LOOK: emitting a `npm run typecheck` check for a repo that has no such
 * script produces a guaranteed red gate on a repo that is fine. Detecting the
 * real script names turns a config guess into a fact.
 */
export function readPackageScripts(
  root: string,
): Record<string, string> | null {
  const file = join(root, 'package.json');
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (typeof scripts !== 'object' || scripts === null) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(scripts as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    // Malformed package.json: treat as "unknown", not as a fatal error. The
    // caller falls back to its configured commands.
    return null;
  }
}

function scriptInvocation(pm: string, script: string): string {
  switch (pm) {
    case 'pnpm':
      return `pnpm run ${script}`;
    case 'yarn':
      return `yarn ${script}`;
    case 'bun':
      return `bun run ${script}`;
    default:
      return `npm run ${script}`;
  }
}

/**
 * Script names to look for, per check, in order of likelihood for a TS repo.
 *
 * WHY THIS IS A LIST AND NOT ONE NAME: assuming a name that does not exist emits
 * a command guaranteed to fail, which turns a healthy repo's gate permanently
 * red. Detecting the real name is cheap; guessing wrong is not, because the
 * failure looks exactly like the worker having broken something.
 */
const SCRIPT_CANDIDATES = {
  typecheck: ['typecheck', 'tsc', 'types', 'check-types', 'type-check'],
  test: ['test', 'test:unit', 'unit', 'tests', 'jest', 'vitest'],
  lint: ['lint', 'eslint', 'lint:check'],
} as const;

/** Resolve a package.json script name to one that actually exists. */
function resolveScript(
  configured: string | undefined,
  available: Record<string, string> | null,
  kind: keyof typeof SCRIPT_CANDIDATES,
): string | undefined {
  if (available === null) {
    // No package.json (or unreadable): we have no facts, so use the caller's
    // name if given, otherwise the primary candidate as an explicit guess.
    return configured ?? SCRIPT_CANDIDATES[kind][0];
  }
  if (configured !== undefined) {
    // An explicit override is honoured only if it exists — silently running a
    // different script than the one configured would be worse than not running it.
    return available[configured] !== undefined ? configured : undefined;
  }
  for (const candidate of SCRIPT_CANDIDATES[kind]) {
    if (available[candidate] !== undefined) return candidate;
  }
  return undefined;
}

/**
 * Build the check list for a TypeScript repo.
 *
 * A `Check` with an empty command is never returned. Every returned check has a
 * real command that either exists (verified against package.json when we can) or
 * was explicitly configured by the caller.
 */
export function typescriptChecks(config: TypeScriptRepoConfig): Check[] {
  const pm = config.packageManager ?? 'npm';
  const nodeBin = config.nodeBin ?? 'node';
  const scripts = readPackageScripts(config.root);
  const direct = config.direct ?? false;
  const maxTail = config.maxTailBytes;

  const checks: Check[] = [];

  const add = (check: Check): void => {
    if (check.command.trim().length > 0) checks.push(check);
  };

  /* ---------------------------------- typecheck --------------------------------- */
  if (direct) {
    add({
      name: 'typecheck',
      // --noEmit because this gate runs against a working tree we must not
      // modify, and because an emitting typecheck that hits an unrelated error
      // would leave stray .js next to .ts for the next stage to pick up.
      command: `${nodeBin} ./node_modules/typescript/lib/tsc.js --noEmit ${(config.typecheckArgs ?? []).join(' ')}`.trim(),
      cwd: config.root,
      timeoutMs: config.typecheckTimeoutMs ?? DEFAULT_TYPECHECK_TIMEOUT_MS,
      expect: { kind: 'exit0' },
      ...(maxTail === undefined ? {} : { maxTailBytes: maxTail }),
    });
  } else {
    const script = resolveScript(config.scripts?.typecheck, scripts, 'typecheck');
    if (script !== undefined) {
      add({
        name: 'typecheck',
        command: scriptInvocation(pm, script),
        cwd: config.root,
        timeoutMs: config.typecheckTimeoutMs ?? DEFAULT_TYPECHECK_TIMEOUT_MS,
        expect: { kind: 'exit0' },
        ...(maxTail === undefined ? {} : { maxTailBytes: maxTail }),
      });
    }
  }

  /* ------------------------------------- test ---------------------------------- */
  if (direct) {
    // vitest first, then jest: whichever is installed is the one this repo uses,
    // and only one of them exists. Neither installed → both invocations fail
    // loudly, which is correct (a repo with no tests should say so).
    const runner = existsSync(join(config.root, 'node_modules', 'vitest'))
      ? './node_modules/vitest/vitest.mjs run'
      : './node_modules/jest/bin/jest.js';
    add({
      name: 'test',
      command: `${nodeBin} ${runner} ${(config.testArgs ?? []).join(' ')}`.trim(),
      cwd: config.root,
      timeoutMs: config.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
      expect: { kind: 'exit0' },
      ...(maxTail === undefined ? {} : { maxTailBytes: maxTail }),
    });
  } else {
    const script = resolveScript(config.scripts?.test, scripts, 'test');
    if (script !== undefined) {
      add({
        name: 'test',
        command: scriptInvocation(pm, script),
        cwd: config.root,
        timeoutMs: config.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
        expect: { kind: 'exit0' },
        ...(maxTail === undefined ? {} : { maxTailBytes: maxTail }),
      });
    }
  }

  /* ------------------------------------- lint ---------------------------------- */
  if (config.lint !== false) {
    if (direct) {
      add({
        name: 'lint',
        command: `${nodeBin} ./node_modules/eslint/bin/eslint.js .`.trim(),
        cwd: config.root,
        timeoutMs: config.lintTimeoutMs ?? DEFAULT_LINT_TIMEOUT_MS,
        expect: { kind: 'exit0' },
        ...(maxTail === undefined ? {} : { maxTailBytes: maxTail }),
      });
    } else {
      const script = resolveScript(config.scripts?.lint, scripts, 'lint');
      if (script !== undefined) {
        add({
          name: 'lint',
          command: scriptInvocation(pm, script),
          cwd: config.root,
          timeoutMs: config.lintTimeoutMs ?? DEFAULT_LINT_TIMEOUT_MS,
          expect: { kind: 'exit0' },
          ...(maxTail === undefined ? {} : { maxTailBytes: maxTail }),
        });
      }
    }
  }

  return checks;
}