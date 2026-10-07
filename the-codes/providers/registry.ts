/**
 * providers/registry.ts — name → Provider, plus machine capability detection.
 *
 * WHY A REGISTRY AND NOT A SWITCH STATEMENT
 * =========================================
 * ARCHITECTURE.md's whole premise is a MIXED PIPELINE: a task names different
 * workers per stage (implement: gemini, review: codex, moderate: claude). So
 * provider selection is data, not control flow — a stage says `provider: codex`
 * and something has to turn that string into a live Provider. This is that
 * something, and it is the only place that knows the full provider set.
 *
 * Two exports matter:
 *   - `getProvider(name)` / `PROVIDERS` — lookup. Throws on unknown names
 *     because a typo in a stage config should fail loudly at startup, not
 *     silently run no worker.
 *   - `detectAvailable()` — which of these CLIs exist on THIS machine. Powers
 *     the mod's provider readout and lets the supervisor refuse a plan it
 *     cannot staff before burning a job slot on it.
 */

import { agyProvider, AGY_BINARY } from './agy.ts';
import { claudeProvider, CLAUDE_BINARY } from './claude.ts';
import { codexProvider, CODEX_BINARY } from './codex.ts';
import { opencodeProvider, OPENCODE_BINARY } from './opencode.ts';
import type { Provider } from './types.ts';

// ---------------------------------------------------------------------------
// The provider set
// ---------------------------------------------------------------------------

/**
 * Canonical ordering. This is the order detectAvailable() reports in and the
 * order the mod lists them, and it is CHEAPEST-MOST-VERIFIED FIRST on purpose:
 * agy and claude are the two we verified end to end against live models, so if
 * something is wrong with detection, the providers we trust most show up first.
 */
export const PROVIDERS: readonly Provider[] = Object.freeze([
  agyProvider,
  codexProvider,
  opencodeProvider,
  claudeProvider,
]);

/** name → Provider. Built once; the set is static. */
const BY_NAME: ReadonlyMap<string, Provider> = new Map(PROVIDERS.map((p) => [p.name, p]));

/** All known provider names, in canonical order. */
export function providerNames(): string[] {
  return PROVIDERS.map((p) => p.name);
}

/**
 * Look up a provider by name.
 *
 * THROWS on an unknown name. Deliberate: a stage config with `provider: cdoe`
 * is a typo, and the failure mode we want is a startup crash with the list of
 * valid names, not a pipeline that silently runs zero workers and reports green.
 */
export function getProvider(name: string): Provider {
  const p = BY_NAME.get(name);
  if (p === undefined) {
    throw new Error(
      `unknown provider "${name}". Known providers: ${providerNames().join(', ')}. ` +
        'Register the adapter in registry.ts (PROVIDERS) to add one.',
    );
  }
  return p;
}

/** Non-throwing lookup, for config validation that wants to report rather than raise. */
export function findProvider(name: string): Provider | undefined {
  return BY_NAME.get(name);
}

// ---------------------------------------------------------------------------
// Availability detection
// ---------------------------------------------------------------------------

export interface ProviderAvailability {
  name: string;
  /** Resolvable on PATH (or at an explicit absolute path from the env override). */
  available: boolean;
  /** The binary we looked for, so an operator can see WHICH one was missing. */
  binary: string;
  /** Why it is unavailable, when it is. Human-readable, one line. */
  reason?: string;
}

/**
 * Which providers exist on this machine.
 *
 * IMPLEMENTATION: each Provider.available() does a PATH walk + X_OK test (see
 * binaryOnPath in ndjson.ts). Deliberately NOT a `--version` subprocess probe:
 * - four spawns on every startup is slow for a check that runs on every render;
 * - `--version` on a broken install can hang waiting on a network auth check;
 * - agy/agy models and codex/codex --version have both been observed to be
 *   slow or interactive in the past.
 *
 * The trade-off is explicit: this answers "can I exec it", NOT "is it
 * authenticated". A provider can be available and still fail its first job on
 * a 402 or a missing key. That failure arrives as a JobResult with a real error
 * string, which is where it belongs — not as a false negative in detection that
 * hides the provider from the mod.
 *
 * All four probes run concurrently. Never rejects: a provider whose probe throws
 * is reported unavailable with the reason, because detectAvailable() feeds a UI.
 */
export async function detectAvailable(): Promise<ProviderAvailability[]> {
  return Promise.all(
    PROVIDERS.map(async (p): Promise<ProviderAvailability> => {
      try {
        const ok = await p.available();
        return { name: p.name, available: ok, binary: binaryFor(p.name) };
      } catch (err) {
        return {
          name: p.name,
          available: false,
          binary: binaryFor(p.name),
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

/** Just the names that resolved. Convenience for a gate: `if (await availableNames()).has('agy')`. */
export async function availableNames(): Promise<Set<string>> {
  const all = await detectAvailable();
  return new Set(all.filter((a) => a.available).map((a) => a.name));
}

/**
 * Can this plan actually be staffed?
 *
 * WHY THIS EXISTS: the failure this guards against is a plan that names three
 * providers on a machine that has one. Without the check, the supervisor starts
 * the first stage, the second stage resolves to a nonexistent binary, and the
 * operator learns about it from a stack trace 40 minutes into a run.
 */
export function missingProviders(required: readonly string[]): string[] {
  return required.filter((n) => !BY_NAME.has(n));
}

// ---------------------------------------------------------------------------
// Binary resolution (for display and for the mod's "not installed" hint)
// ---------------------------------------------------------------------------

/**
 * The binary name/path a provider will actually exec.
 *
 * Each adapter honours an AGENT_SMITH_<NAME>_BIN override so an operator can
 * point at a non-PATH install without editing code. Surfaced here so the
 * "provider not found" message tells you which command was looked for.
 */
export function binaryFor(providerName: string): string {
  switch (providerName) {
    case 'agy':
      return AGY_BINARY;
    case 'codex':
      return CODEX_BINARY;
    case 'opencode':
      return OPENCODE_BINARY;
    case 'claude':
      return CLAUDE_BINARY;
    default:
      return providerName;
  }
}

/**
 * What each provider is FOR, in one line. Not decoration: `moderate` stages
 * pick a provider by role, and a role that is not written down gets picked
 * wrong (using agy to moderate agy is the correlated-agreement mistake
 * ARCHITECTURE.md warns about).
 */
export const PROVIDER_ROLES: Readonly<Record<string, string>> = Object.freeze({
  agy: 'cheap implementer / workhorse. Highest throughput, most tool calls.',
  codex: 'reviewer. Different model family from the implementer, so its agreement is evidence.',
  opencode: 'generalist. Fast, multi-provider, useful when another vendor is cheaper.',
  claude: 'prober / moderator. Reads the diff and argues about it; sees subagent work via --forward-subagent-text.',
});

/**
 * Families, for the correlated-agreement check.
 *
 * WHY: "Claude proposes, another model probes." Self-consistency between
 * same-family models is correlated (ICML 2025, 350+ models: 60% agreement when
 * both err), so a moderate stage that runs on the same family as the implement
 * stage is decoration, not verification. This map lets core/ refuse or warn
 * about a plan that moderates with the implementer's own family.
 *
 * UNVERIFIED / needs testing: whether OpenCode's configured model is in the
 * same family depends on runtime config (`opencode.json`), not on the binary,
 * so 'opencode' is deliberately marked 'unknown' rather than guessed.
 */
export const PROVIDER_FAMILIES: Readonly<Record<string, 'anthropic' | 'openai' | 'google' | 'unknown'>> =
  Object.freeze({
    agy: 'google',
    codex: 'openai',
    claude: 'anthropic',
    opencode: 'unknown',
  });