/**
 * cli/ladders.ts — the provider capability table the CLI supplies to routing.
 *
 * ============================================================================
 * WHY THIS FILE IS NOT A CONSTANT IN routing.ts
 * ============================================================================
 * `routing.ts`'s `DEFAULT_LADDERS` carries PLACEHOLDER model ids (`gemini-flash`,
 * `gpt-5.6-mini`, `claude-sonnet`, `agy-default`). Those are fine inside
 * pipeline/'s tests, which never spawn anything, and actively harmful here: the
 * CLI passes this table to `runPipeline`, routing picks the id for every stage,
 * and the id is handed straight to `agy --model` / `codex --model`. A placeholder
 * is not a model; it is a failed spawn or a silent fallback to the vendor's own
 * default, and either way the operator's stage ran on a model nobody chose.
 *
 * So the real table lives here, next to the code that spawns, where a wrong id
 * is visible in the same file as `doctor`'s output. The rule it follows: every id
 * below is either VERIFIED against the real CLI on this machine, or omitted —
 * never guessed.
 *
 * ============================================================================
 * THE THREE FIELDS ARE NOT SYMMETRIC, AND THAT IS DELIBERATE
 * ============================================================================
 *   defaultModel        what t0 uses. Verified, or absent → let the CLI decide.
 *   strongerModel       t2 rung. Absent for agy, opencode and kimi: we could not
 *                       establish a stronger id, and routing.ts SKIPS a rung a
 *                       provider cannot fill rather than substituting something
 *                       it was not measured for. An absent strongerModel makes
 *                       agy stop at t1 instead of silently spending on a guess.
 *   crossFamilyModel    t3 rung. Only claude has one, and only because
 *                       assertCrossFamily will verify it at runtime.
 *
 * A rung that cannot be filled is a ladder that stops. That is the correct
 * behaviour and it is already implemented in routing.ts's `nextRouting`; the
 * reason to say it here is that a reader will otherwise think these tables are
 * incomplete by accident.
 */

import type { ProviderLadder } from '../pipeline/routing.ts';

/**
 * Verified ids, with the evidence for each.
 *
 * agy / codex / claude / opencode: NO id is asserted. All adapters omit `--model`
 * when `SpawnSpec.model` is undefined and the vendor CLI then applies its own
 * documented default. That is a REAL default, chosen by the vendor, and it is a
 * better default than a string invented in this repo.
 *
 * So the consequence, stated plainly: `agent-smith run --provider codex` without
 * `--model` runs codex's default model, and `agent-smith ls` will show that model
 * as reported in the job's spec.json. What this table will not do is pretend to
 * know a model id we have not run.
 */
export const CLI_LADDERS: Readonly<Record<string, ProviderLadder>> = Object.freeze({
  agy: {
    // No model asserted: let agy choose its current default. This also keeps
    // explicit effort overrides compatible with whichever model agy selects.
    label: 'agy',
  },
  codex: {
    // No model asserted. codex's own default is real and documented.
    label: 'codex',
  },
  claude: {
    // No model asserted either — `sonnet` is a documented ALIAS, but which
    // concrete model it resolves to moves, so pinning the alias here would make
    // a cross-family check depend on a mapping we do not control. The
    // example pipeline names `sonnet` explicitly where it matters.
    label: 'claude',
  },
  opencode: {
    // opencode's model is `provider/model#variant` and comes from the user's
    // own opencode.json. Guessing it here would be guessing at their config.
    label: 'opencode',
  },
  kimi: {
    // No model asserted: kimi's real default is `default_model` in its own
    // config.toml. Its print mode has no per-run effort flag either, so the
    // adapter ignores routing's effort with a warning rather than inventing an
    // alias. `efforts: false` makes the t1 rung skip instead of duplicating the
    // model for no change.
    label: 'kimi',
    efforts: false,
  },
});

/**
 * Fallback ladders for a stage whose provider we have no entry for.
 *
 * `t0-cheap` with NO model, so routing's `stage.model ?? ladder.defaultModel`
 * resolves to undefined and the provider's own default applies. A stage naming a
 * provider we have no ladder for should still be able to run — the alternative
 * is refusing a pipeline because of a missing metadata row.
 */
export const UNKNOWN_LADDER: ProviderLadder = Object.freeze({ label: 'unknown' });

/** Look up a ladder, falling back to the model-less one. */
export function ladderFor(provider: string): ProviderLadder {
  return CLI_LADDERS[provider] ?? UNKNOWN_LADDER;
}

/** The whole table, in the shape `runPipeline` expects. */
export function allLadders(): Readonly<Record<string, ProviderLadder>> {
  return CLI_LADDERS;
}
