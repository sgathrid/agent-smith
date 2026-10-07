/**
 * Declarative agent capabilities.
 *
 * Borrowed in spirit from omnigent's `harness_capabilities.py`, which exists
 * because their capability knowledge had escaped into `if harness == "x"`
 * branches across the codebase. They learned that lesson at 92k lines of
 * per-vendor adapters; we would rather learn it now, at four adapters.
 *
 * The rule this file enforces: **never branch on a provider name.** Ask the
 * capability instead. Adding a fifth agent must not require touching this file
 * or any switch statement — only adding an adapter that declares its shape.
 *
 * On tri-state (`true | false | null`): "unknown" is NOT the same as
 * "unsupported". Several agent catalogs list ids without capability metadata,
 * and collapsing the two would silently drop a stage — e.g. quietly skipping
 * the review stage because a catalog was incomplete. Unknown means "ask, don't
 * assume", and only the conformance bench may treat unknown as a failure.
 */

/**
 * How we run the agent. Borrowed verbatim in spirit from omnigent's
 * `IntegrationMode`, because the taxonomy is right: it tells you *where the
 * difficulty is* before you write a line of adapter.
 *
 * - `stream-json`  we spawn a CLI and parse typed NDJSON from its stdout.
 *                  The good case. agy, Codex, Claude Code all do this.
 * - `app-server`   the vendor runs a server we speak JSON-RPC/HTTP to.
 * - `pty`          we must scrape a human-readable terminal. Every one of
 *                  these is a future breaking change, so it is tracked as debt
 *                  and never chosen deliberately.
 */
export type IntegrationMode = 'stream-json' | 'app-server' | 'pty';

/**
 * Whether we can learn a capability by asking the agent itself, and whether we
 * can influence it mid-run. These are the two axes that determine whether a
 * provider is useful for the mixed pipelines we want to build.
 */
export interface AgentCapabilities {
  readonly integration: IntegrationMode;

  /** Emits typed structured events we can normalize. If false, we are scraping. */
  readonly structuredEvents: boolean | null;
  /** Can we ask the vendor what it supports (e.g. `agy models`)? */
  readonly selfDescribes: boolean | null;

  /** Resume a prior conversation rather than starting cold. */
  readonly resume: boolean | null;
  /** Interrupt a running turn (not just kill the process). */
  readonly steerMidTurn: boolean | null;
  /** Keep the conversation alive across separate invocations. */
  readonly persistentSession: boolean | null;

  /**
   * Does a permission denial still exit 0 with an empty success payload?
   *
   * agy does. This is the single most dangerous property in this file: a
   * job can report success having done nothing at all. When true, the adapter
   * MUST treat an empty response as a failure, not a clean run.
   */
  readonly silentDenialExitsZero: boolean | null;
}

/**
 * A capability value we cannot determine. Distinct from `false` on purpose —
 * see the file header. `readCapability` exists so callers have one place to
 * decide how to treat it.
 */
export function isUnknown(value: boolean | null): boolean {
  return value === null;
}

/**
 * Read a capability under an explicit policy for the unknown case.
 *
 * `optimistic`  — treat unknown as usable. Right when a missing capability
 *                  degrades gracefully, e.g. "resume if we can".
 * `pessimistic` — treat unknown as unusable. Right when assuming capability
 *                  would silently corrupt state, e.g. "steer mid-turn".
 */
export function readCapability(
  value: boolean | null,
  policy: 'optimistic' | 'pessimistic',
): boolean {
  if (value !== null) return value;
  return policy === 'optimistic';
}

/**
 * Can this provider be trusted to report its own failures honestly?
 *
 * The gate for automated escalation. If an agent can exit 0 while doing
 * nothing, its "success" carries no information and the verify gate becomes
 * the only thing standing between us and a silent no-op.
 */
export function trustworthySuccess(caps: AgentCapabilities): boolean {
  return caps.silentDenialExitsZero === false;
}

/**
 * Rank a provider for a stage that needs live observation. Lower is better.
 *
 * Used by the pipeline to pick a default worker for stages that want a live
 * view: structured NDJSON we can normalize always beats scraping a terminal.
 * `null` capabilities are treated as "unknown, assume the worst", which keeps
 * an incomplete catalog from promoting a fragile adapter.
 */
export function observationRank(caps: AgentCapabilities): number {
  if (caps.structuredEvents === true && caps.integration === 'stream-json') return 0;
  if (caps.structuredEvents === true) return 1;
  if (caps.integration === 'pty') return 3;
  return 2; // structured but unknown how it is delivered
}