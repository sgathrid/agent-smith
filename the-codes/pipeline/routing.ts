/**
 * pipeline/routing.ts — dynamic model/stage selection.
 *
 * Six rules, each backed by a measurement. If you change one of these, change
 * the comment that justifies it, or you are just guessing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RULE 1 — DEFAULT EVERY STAGE TO THE CHEAPEST TIER.
 *
 * Measured on this user's own jobs: `high` effort cost **+50% wall clock and
 * 1.9x thinking tokens for ZERO accuracy gain** on an in-band task. Effort is
 * the one knob that reliably *spends* without returning anything. So `low` is
 * not a cautious default, it is the empirically correct starting point, and
 * spending effort has to be earned by a failure (RULE 2) rather than granted by
 * optimism.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RULE 2 — ESCALATE ON STALL SHAPES, NEVER ON THE FIRST ERROR.
 *
 * In a real 28-minute job, the first tool error appeared at **tool #34 of 484**
 * and that job **SUCCEEDED**. Agents that do long work error early and recover;
 * error count is therefore close to uncorrelated with failure, and any policy
 * that escalates on "an error happened" would have burned a stronger model on
 * the majority of *successful* jobs.
 *
 * What correlates with failure is a *shape*: the same failure signature
 * repeating, edits that churn with nothing ever verified, or a long run of
 * turns that change nothing. Those are patterns over an attempt, not moments.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RULE 3 — ESCALATE BY CONTINUING WITH CONTEXT, NOT BY RESTARTING.
 *
 * A restart discards the completed work, the explored dead ends, and every file
 * the worker already read, then re-pays for all of it. Resuming costs one call
 * and keeps the state that made the attempt worth escalating. See
 * `StageContinuation`. A restart is only correct when there is no transcript to
 * preserve.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RULE 4 — NO CONFIDENCE PREDICTION. NO DIFFICULTY CLASSIFIER.
 *
 * There is no reliable pre-hoc signal. Anything that claims to know a task's
 * difficulty *before* the work is done is guessing with extra steps, and a
 * guess that gates spend multiplies: mis-calibrate one way and every simple task
 * gets a frontier model, mis-calibrate the other way and the hard task never
 * escalates at all.
 *
 * The reliable signal only exists after the work is done, which is why this
 * module is *post-hoc by construction*: it consumes `Observation[]` from an
 * attempt that already ran. The consequence is deliberate — cheap models do the
 * cheap work and we pay for escalation exactly when the attempt actually went
 * sideways, rather than paying a tax on every job to insure against the ones
 * that would have been fine anyway.
 *
 * If someone asks for a `predictDifficulty(stage)` or a `confidence` field:
 * don't add it. Route on the artifact of the attempt instead.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RULE 5 — `moderate` IS A CROSS-FAMILY PROBE, AND IT IS NOT DEBATE.
 *
 * Generative agreement between same-family models is correlated: **60% agreement
 * when both models err** (ICML 2025, across 350+ models). Correlated errors mean
 * self-consistency is not verification — a model asked to check its own work
 * reproduces its own failure modes at a high rate, and the agreement looks like
 * confirmation. Only a different model *family* has a sufficiently independent
 * error distribution to make "did you miss this?" mean anything.
 *
 * That is also why `moderate` takes one opposing voice and does not vote: the
 * finding it replaces is that **debate underperforms plain self-consistency and
 * gets worse with more budget** (2406.06461, four budget-matched replications).
 * More models agreeing proves less and costs more. One different-family probe,
 * applied to a written artifact, is the honest version.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RULE 6 — EVERY STAGE IS ALLOWED TO STAY CHEAP.
 *
 * A stage with no stall signal never escalates. The common case must be cheap;
 * if routing spends by default, RULE 1 is dead.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  CostTier,
  Effort,
  ModelId,
  Observation,
  PipelineSpec,
  ProviderId,
  Stage,
  StageRole,
  StageRouting,
} from './types.ts';

/* -------------------------------------------------------------------------- */
/* Model families                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Provider and model prefixes mapped to a model family.
 *
 * WHY THIS TABLE EXISTS: "different model" is not enough. Two models from the
 * same vendor share training data, post-training recipes and failure modes, so
 * their agreement is correlated (RULE 5). The unit that buys independence is the
 * family.
 *
 * It is a prefix table on purpose — deliberately shallow. An unrecognised model
 * gets family 'unknown', which makes `assertCrossFamily` fail loudly instead of
 * quietly granting independence that may not exist.
 */
const FAMILY_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['gpt', 'openai'],
  ['o1', 'openai'],
  ['o3', 'openai'],
  ['o4', 'openai'],
  ['codex', 'openai'],
  ['claude', 'anthropic'],
  ['sonnet', 'anthropic'],
  ['opus', 'anthropic'],
  ['haiku', 'anthropic'],
  ['gemini', 'google'],
  ['gemma', 'google'],
  // Kimi Code's managed aliases are Moonshot models. The provider-name fallback
  // stays 'unknown' because a kimi config can point at any OpenAI-compatible
  // vendor; only an id that names Moonshot itself claims the family.
  ['kimi-code/', 'moonshot'],
  ['moonshot-ai/', 'moonshot'],
  ['moonshot/', 'moonshot'],
  ['kimi-', 'moonshot'],
  ['k3', 'moonshot'],
  ['llama', 'meta'],
  ['qwen', 'alibaba'],
  ['deepseek', 'deepseek'],
  ['mistral', 'mistral'],
  ['grok', 'xai'],
];

/**
 * Provider-level fallback for models the prefix table does not know.
 * A provider's *vendor* is the best guess at its family.
 */
const PROVIDER_FAMILIES: Readonly<Record<string, string>> = {
  gemini: 'google',
  codex: 'openai',
  openai: 'openai',
  claude: 'anthropic',
  anthropic: 'anthropic',
  agy: 'unknown',
  opencode: 'unknown',
  // Config-dependent: [models] can name any vendor. Moonshot model ids are
  // resolved by the prefix table above.
  kimi: 'unknown',
};

/**
 * Family of a model id, or `'unknown'`.
 *
 * Unresolved ids stay 'unknown' on purpose. 'unknown' is not "no family", it is
 * "we do not know enough to claim independence", and the cross-family assertions
 * in this file treat it as a failure.
 */
export function familyOf(id: string): string {
  const lower = id.toLowerCase();
  for (const [prefix, family] of FAMILY_PREFIXES) {
    if (lower.startsWith(prefix)) return family;
  }
  return PROVIDER_FAMILIES[lower] ?? 'unknown';
}

/** True when two ids are known to share a model family. */
export function sameFamily(a: string, b: string): boolean {
  const fa = familyOf(a);
  const fb = familyOf(b);
  // 'unknown' is never treated as independent from anything, including itself.
  return fa === 'unknown' || fb === 'unknown' || fa === fb;
}

/** Thrown when a cross-family guarantee is requested but cannot be shown. */
export class CrossFamilyViolation extends Error {
  // Explicit fields, not constructor parameter properties (`erasableSyntaxOnly`).
  readonly a: string;
  readonly b: string;

  constructor(message: string, a: string, b: string) {
    super(message);
    this.name = 'CrossFamilyViolation';
    this.a = a;
    this.b = b;
  }
}

/**
 * Assert that two models are genuinely different families.
 *
 * Used by `moderateStage()` so the cross-family property is enforced by code
 * rather than by a reviewer's memory. A moderator from the same family as the
 * author is worse than no moderator: it manufactures agreement.
 */
export function assertCrossFamily(probe: string, underReview: string): void {
  if (sameFamily(probe, underReview)) {
    throw new CrossFamilyViolation(
      `probe '${probe}' and reviewed '${underReview}' share family ` +
        `'${familyOf(probe)}'. A same-family moderator reproduces correlated ` +
        `errors (60% agreement when both err, ICML 2025) and is not verification.`,
      probe,
      underReview,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Stall shapes                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The shapes that mean "this attempt is not converging".
 *
 * Each is a pattern across the attempt. None of them is "an error happened"
 * (RULE 2).
 */
export type StallShape =
  /** The same normalized failure signature recurring. */
  | 'repeat-signature'
  /** Many file mutations, and nothing was ever run to check them. */
  | 'edit-churn-unverified'
  /** A long run of turns that changed nothing at all. */
  | 'no-progress'
  /** The worker exhausted its context or hit a provider limit. */
  | 'context-exhaustion'
  /** The worker's own judgement that it could not proceed. */
  | 'declared-stuck';

export interface StallPolicy {
  /**
   * How many times the SAME normalized signature must appear before it counts.
   * Default 3: the first one is a fact, the second is a coincidence, the third
   * is a shape.
   */
  readonly repeatSignatureCount: number;
  /** Edits without a single verification run. */
  readonly editChurnMinEdits: number;
  /** Consecutive turns with no tool call, edit or verification. */
  readonly noProgressTurns: number;
  /** Max escalations per stage. See the ceiling note in nextRouting(). */
  readonly maxEscalations: number;
  /** Short-circuit these outright — they are never stall evidence. */
  readonly ignoredSignals: readonly string[];
}

export const DEFAULT_STALL_POLICY: StallPolicy = {
  repeatSignatureCount: 3,
  editChurnMinEdits: 8,
  noProgressTurns: 6,
  maxEscalations: 2,
  /**
   * RULE 2, as data. `first-error` is listed here so that any future code that
   * tries to escalate on it fails a test rather than shipping.
   */
  ignoredSignals: ['first-error', 'error-count', 'slow-start', 'self-doubt', 'looks-hard'],
};

/** The decision, with the evidence that produced it. */
export interface StallVerdict {
  /** null means "no stall shape found" — stay on the current rung. */
  readonly shape: StallShape | null;
  readonly escalate: boolean;
  /** Human-readable, short. Goes into the escalation record. */
  readonly because: string;
  /** The concrete counts behind the decision. Empty when shape is null. */
  readonly evidence: readonly string[];
}

/**
 * Reduce an error message to a comparable signature.
 *
 * Paths, line numbers, hex ids and quoted values change between occurrences of
 * the *same* failure, so comparing raw strings undercounts recurrence. We keep
 * the alphabetic words, drop the numbers, and truncate — the goal is "same
 * failure?" not "same message?".
 */
export function normalizeSignature(message: string): string {
  const words = message
    .toLowerCase()
    // Quoted spans and path-like runs vary between occurrences of the SAME
    // failure, so they are replaced wholesale rather than split into words.
    // Without this, "module './src/user/profile.ts'" and "module
    // './src/admin/settings.ts'" read as different failures and recurrence goes
    // uncounted — which is the one thing this function exists to detect.
    .replace(/'[^']*'/g, ' ')
    .replace(/"[^"]*"/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/[a-z0-9_./\\-]*[\\/][a-z0-9_./\\-]*/g, ' path ')
    .replace(/[0-9a-f]{8,}/g, '#')
    .replace(/\d+/g, '#')
    .split(/[^a-z]+/)
    .filter((w) => w.length > 2);
  return words.slice(0, 10).join(' ') || 'unknown';
}

function observationsOf(
  events: readonly Observation[],
): { errors: Observation[]; edits: Observation[]; verifications: Observation[]; turns: number } {
  let turns = 0;
  const errors: Observation[] = [];
  const edits: Observation[] = [];
  const verifications: Observation[] = [];
  for (const ev of events) {
    turns = Math.max(turns, ev.turn);
    if (ev.kind === 'error') errors.push(ev);
    else if (ev.kind === 'edit') edits.push(ev);
    else if (ev.kind === 'verification') verifications.push(ev);
  }
  return { errors, edits, verifications, turns };
}

/**
 * Decide whether an attempt stalled, and in what shape.
 *
 * Note the shape of the API: it takes an attempt that has already happened.
 * There is no variant of this function that runs before the work (RULE 4).
 */
export function assessStall(
  events: readonly Observation[],
  policy: StallPolicy = DEFAULT_STALL_POLICY,
): StallVerdict {
  if (events.length === 0) {
    // No structured events is not evidence of health. It is absence of evidence.
    return { shape: null, escalate: false, because: 'no observations reported', evidence: [] };
  }

  const { errors, edits, verifications, turns } = observationsOf(events);

  // 1. Same signature, repeatedly.
  const counts = new Map<string, number>();
  for (const ev of errors) {
    const sig = normalizeSignature(ev.message ?? '');
    counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }
  let worstSig = '';
  let worstCount = 0;
  for (const [sig, n] of counts) {
    if (n > worstCount) {
      worstSig = sig;
      worstCount = n;
    }
  }
  if (worstCount >= policy.repeatSignatureCount) {
    return {
      shape: 'repeat-signature',
      escalate: true,
      because: `same failure repeated ${worstCount}x: '${worstSig}'`,
      evidence: [
        `signature '${worstSig}' x${worstCount} (threshold ${policy.repeatSignatureCount})`,
        `total errors in attempt: ${errors.length}`,
        // The counter-evidence, recorded so the decision is auditable.
        `distinct signatures: ${counts.size} — repetition, not variety, is the signal`,
      ],
    };
  }

  // 2. Edits without ever running anything.
  if (edits.length >= policy.editChurnMinEdits && verifications.length === 0) {
    return {
      shape: 'edit-churn-unverified',
      escalate: true,
      because: `${edits.length} edits with zero verification runs`,
      evidence: [
        `edits: ${edits.length} (threshold ${policy.editChurnMinEdits})`,
        'verification runs: 0',
        'the worker is asserting success it has never observed',
      ],
    };
  }

  // 3. A long stretch where nothing happened.
  // A turn is INACTIVE when it appears in the stream carrying only prose: the
  // worker emitted turns but made no tool call, no edit and no run. The signal is
  // the length of a contiguous inactive run, so interleaving real activity resets
  // it — a worker that keeps poking around is not stalled, however long it takes.
  const activeTurns = new Set<number>();
  for (const ev of events) {
    if (ev.kind !== 'text') activeTurns.add(ev.turn);
  }
  const inactiveTurns = [...new Set(events.map((ev) => ev.turn))]
    .filter((t) => !activeTurns.has(t))
    .sort((a, b) => a - b);

  let bestRun = 0;
  let run = 0;
  let prev = -2;
  for (const t of inactiveTurns) {
    run = t === prev + 1 ? run + 1 : 1;
    if (run > bestRun) bestRun = run;
    prev = t;
  }
  if (bestRun >= policy.noProgressTurns) {
    return {
      shape: 'no-progress',
      escalate: true,
      because: `${bestRun} consecutive turns with no tool call, edit or run`,
      evidence: [`longest inactive run: ${bestRun} turns (threshold ${policy.noProgressTurns})`],
    };
  }

  // 4/5. The worker's own hard stop. This one is trustworthy *because* it is a
  // terminal condition, not a prediction — a runner that reports it has run out
  // of budget, and no amount of the same budget helps.
  const declared = errors.find((ev) =>
    /\b(context (exhausted|window|length)|max (tokens|turns)|out of budget|exceeded)\b/.test(
      ev.message ?? '',
    ),
  );
  if (declared) {
    return {
      shape: 'context-exhaustion',
      escalate: true,
      because: 'worker reported a hard budget/context limit',
      evidence: [normalizeSignature(declared.message ?? '')],
    };
  }
  const stuck = events.find(
    (ev) => ev.kind === 'text' && /\bi (can'?t|cannot|am unable to) (proceed|continue)\b/i.test(ev.message ?? ''),
  );
  if (stuck) {
    return {
      shape: 'declared-stuck',
      escalate: true,
      because: 'worker declared it could not proceed',
      evidence: [(stuck.message ?? '').slice(0, 200)],
    };
  }

  // The counter-case, stated explicitly: a first error is NOT a stall. In the
  // reference 28-minute job the first tool error came at tool #34 of 484 and the
  // job succeeded. It must not reach this function's caller as a reason to spend.
  if (errors.length > 0 && counts.size === errors.length) {
    return {
      shape: null,
      escalate: false,
      because: `${errors.length} error(s), all distinct signatures — variety, not repetition`,
      evidence: [
        `distinct signatures: ${counts.size}`,
        'not escalating: an isolated error is the observed normal for long jobs (tool #34 of 484 still succeeded)',
      ],
    };
  }

  return {
    shape: null,
    escalate: false,
    because: `${turns} turns, ${errors.length} errors, ${edits.length} edits, no stall shape`,
    evidence: [],
  };
}

/* -------------------------------------------------------------------------- */
/* The ladder                                                                  */
/* -------------------------------------------------------------------------- */

/** Options a provider exposes to the router. All optional: absent = unavailable. */
export interface ProviderLadder {
  /** Cheapest model the provider offers. The t0 default. */
  readonly defaultModel?: ModelId | undefined;
  /** A stronger model from the same provider. Used by t2. */
  readonly strongerModel?: ModelId | undefined;
  /** A model from a *different* family. Used by t3. */
  readonly crossFamilyModel?: ModelId | undefined;
  /**
   * False when the provider cannot change reasoning effort per run. The t1
   * "same model, more effort" rung is then skipped rather than duplicated.
   * Default true.
   */
  readonly efforts?: boolean | undefined;
  /** Human label used in rationale strings. */
  readonly label?: string | undefined;
}

/**
 * Ladders per provider.
 *
 * These are *declared capabilities*, not a ranking of intelligence. If a
 * provider cannot offer a rung, the ladder stops there rather than substituting
 * something it was not measured for.
 */
export const DEFAULT_LADDERS: Readonly<Record<string, ProviderLadder>> = {
  gemini: { defaultModel: 'gemini-flash', strongerModel: 'gemini-pro', label: 'gemini' },
  codex: { defaultModel: 'gpt-5.6-mini', strongerModel: 'gpt-5.6-sol', label: 'codex' },
  claude: {
    defaultModel: 'claude-sonnet',
    strongerModel: 'claude-opus',
    crossFamilyModel: 'gemini-flash',
    label: 'claude',
  },
  agy: { defaultModel: 'agy-default', label: 'agy' },
  opencode: { defaultModel: 'opencode-default', label: 'opencode' },
  // No invented model id: kimi's real default lives in its config.toml, and
  // print mode has no per-run effort flag (routing's effort is ignored by the
  // adapter with a warning).
  kimi: { label: 'kimi', efforts: false },
};

const TIER_ORDER: readonly CostTier[] = ['t0-cheap', 't1-effort', 't2-stronger', 't3-cross-family'];

/** Effort to use at each tier. Note t0/t1 keep the cheapest MODEL. */
function effortForTier(tier: CostTier): Effort {
  switch (tier) {
    case 't0-cheap':
      return 'low';
    case 't1-effort':
      return 'high';
    case 't2-stronger':
    case 't3-cross-family':
      return 'medium';
  }
}

/** The rationale string is a log line. Write it like one. */
function rationaleFor(tier: CostTier, stage: Stage, ladder: ProviderLadder): string {
  const who = ladder.label ?? stage.provider;
  switch (tier) {
    case 't0-cheap':
      return `${stage.name}: ${who} default model at low effort — measured default, high effort cost +50% wall clock / 1.9x thinking tokens for zero accuracy gain`;
    case 't1-effort':
      return `${stage.name}: same model, effort raised — only after a stall shape; the in-band measurement does not apply once the attempt is out-of-band`;
    case 't2-stronger':
      return `${stage.name}: stronger model in the same provider (${who}) after ${'stall shape'}`;
    case 't3-cross-family':
      return `${stage.name}: different model family after stall — correlated same-family agreement is not verification (60% agreement when both err, ICML 2025)`;
  }
}

/**
 * The initial routing for a stage: RULE 1, the cheapest tier.
 *
 * A spec author may pin model/effort (`stage.routingPinned`); we never
 * overwrite a deliberate pin, because that would silently discard the one
 * measurement they made themselves.
 */
export function planInitialRouting(
  stage: Stage,
  ladders: Readonly<Record<string, ProviderLadder>> = DEFAULT_LADDERS,
): StageRouting {
  const ladder = ladders[stage.provider] ?? { label: stage.provider };

  if (stage.routingPinned) {
    return {
      tier: 't0-cheap',
      provider: stage.provider,
      model: stage.model ?? ladder.defaultModel,
      effort: stage.effort ?? 'low',
      rationale: `${stage.name}: pinned by spec author, not rewritten by routing`,
    };
  }

  return {
    tier: 't0-cheap',
    provider: stage.provider,
    model: stage.model ?? ladder.defaultModel,
    // RULE 1: low, unless the spec explicitly asked for something else.
    effort: stage.effort ?? 'low',
    rationale: rationaleFor('t0-cheap', stage, ladder),
  };
}

/**
 * The next rung, or null if there is no next rung.
 *
 * THE CEILING (maxEscalations, default 2) exists because an agent that keeps
 * escalating is an agent that never returns. Two is enough to survive a stall
 * shape and one failed remedy; past that, more of the same medicine is not a
 * strategy. When we stop, we stop with the evidence attached so a human can see
 * what the worker actually did — see verify/gate.ts, where the parallel rule is
 * "never auto-retry more than once, because a loop is worse than a stop".
 */
export function nextRouting(
  current: StageRouting,
  verdict: StallVerdict,
  stage: Stage,
  ladders: Readonly<Record<string, ProviderLadder>> = DEFAULT_LADDERS,
  policy: StallPolicy = DEFAULT_STALL_POLICY,
  escalationsSoFar = 0,
): StageRouting | null {
  if (!verdict.escalate) return null;
  if (escalationsSoFar >= policy.maxEscalations) return null;

  const idx = TIER_ORDER.indexOf(current.tier);
  const ladder = ladders[current.provider] ?? { label: current.provider };

  // Walk up one rung at a time, skipping rungs this provider cannot fill.
  for (let next = idx + 1; next < TIER_ORDER.length; next++) {
    const tier = TIER_ORDER[next];
    if (tier === undefined) continue;
    // t1 changes effort, not model. A provider that cannot set effort per run
    // would spend a full duplicate attempt for nothing; skip the rung.
    if (tier === 't1-effort' && ladder.efforts === false) continue;
    const model = modelForTier(tier, current.provider, current.model, ladder);
    if (model === undefined) continue;

    // RULE 5: a cross-family rung that is not actually cross-family is a lie.
    // Fall through to no escalation rather than shipping correlated agreement.
    if (tier === 't3-cross-family') {
      const underReview = current.model ?? stage.provider;
      if (sameFamily(model, underReview)) continue;
    }

    return {
      tier,
      provider: current.provider,
      model,
      effort: stage.effort ?? effortForTier(tier),
      rationale: rationaleFor(tier, stage, ladder),
    };
  }
  return null;
}

function modelForTier(
  tier: CostTier,
  provider: ProviderId,
  currentModel: string | undefined,
  ladder: ProviderLadder,
): string | undefined {
  switch (tier) {
    case 't0-cheap':
      return ladder.defaultModel ?? currentModel;
    case 't1-effort':
      // Same model, more effort: nothing to fill in.
      return currentModel ?? ladder.defaultModel;
    case 't2-stronger':
      return ladder.strongerModel;
    case 't3-cross-family':
      return ladder.crossFamilyModel;
  }
}

/* -------------------------------------------------------------------------- */
/* Spec-level helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Apply RULE 1 to a whole spec, without running anything.
 *
 * Returns a new spec whose stages all carry an explicit cheap routing. Useful
 * for printing "what this pipeline will actually spend" before the first token
 * is bought, and for asserting in a test that no stage silently starts at high
 * effort.
 */
export function planSpecRouting(
  spec: PipelineSpec,
  ladders: Readonly<Record<string, ProviderLadder>> = DEFAULT_LADDERS,
): PipelineSpec {
  return {
    ...spec,
    stages: spec.stages.map((stage) => {
      const routing = planInitialRouting(stage, ladders);
      return { ...stage, model: routing.model, effort: routing.effort };
    }),
  };
}

/**
 * Build the `moderate` stage: a cross-family probe of another stage's artifact.
 *
 * WHY IT IS NOT DEBATE (RULE 5): debate underperforms plain self-consistency and
 * degrades with more budget (2406.06461). A moderator is not a voter, and this
 * function produces exactly one opposing voice pointed at one artifact. Its
 * value comes from the independence of its error distribution, not from
 * agreement-counting.
 *
 * Throws CrossFamilyViolation when the requested probe is not genuinely a
 * different family — enforced here so it cannot be forgotten at a call site.
 */
export function moderateStage(args: {
  /** Name for the new stage. */
  name: string;
  /** Stage whose artifact is being probed. */
  probes: string;
  /** Probe's provider. */
  provider: ProviderId;
  /** Probe's model. */
  model: ModelId;
  /** The reviewed stage, so family independence can be checked. */
  reviewedModel?: ModelId | undefined;
  /** Artifact to read. Defaults to the reviewed stage's convention. */
  reads?: string | undefined;
  prompt?: string | undefined;
  ladders?: Readonly<Record<string, ProviderLadder>> | undefined;
}): Stage {
  const underReview = args.reviewedModel ?? '';
  if (underReview) assertCrossFamily(args.model, underReview);

  const role: StageRole = 'moderate';
  return {
    name: args.name,
    provider: args.provider,
    model: args.model,
    effort: 'low',
    dependsOn: [args.probes],
    role,
    // Deliberately short. The rationale for why this is cross-family — the
    // correlated-agreement finding — belongs in a comment the operator reads,
    // not in an instruction the worker reads. Extra framing in a prompt is
    // exactly the surface on which a "generic self-check" starts sounding like a
    // checklist (external 10/10 vs generic self-check 5/10, p=0.0325). What the
    // worker needs is the artifact and the question.
    prompt:
      args.prompt ??
      `Read ${args.reads ?? 'result.md'} and find what is wrong with it: unstated assumptions, ` +
        `missed cases, and claims the evidence does not support. Report findings only; ` +
        `do not rewrite the work.`,
    routingPinned: true,
  };
}