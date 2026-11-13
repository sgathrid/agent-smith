/**
 * normalize.ts — provider-agnostic normalization to ObservedJob.
 *
 * Every provider quirk and every judgement call lives HERE and only here, so
 * this file is the single place a reviewer reads to answer "why did that job
 * show up as failed?". Readers (agent-smith.ts) are dumb parsers; they
 * extract facts and get out of the way.
 *
 * The headline rule, an empty response is not a clean success, is applied
 * once, when the job is written (forge/format.ts `deriveStatus`), and not
 * re-derived here.
 */

import { SCHEMA_VERSION } from "../forge/format.ts";
import { STEER_NOT_APPLIED_RE } from "../surfaces/mod/hooks/reasons.ts";
import { SMITH_PAYLOAD } from "./agent-smith.ts";
import {
  type JobNormalizer,
  type ObservedJob,
  type ObservedStatus,
  type ObservedUsage,
  type ObservedWarning,
  type RawJobState,
} from "./types.ts";

// ── helpers ────────────────────────────────────────────────────────────────

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

// ── agent-smith normalizer ──────────────────────────────────────────────────

/**
 * Map an agent-smith payload onto ObservedJob.
 *
 * It is short because we own the format (see forge/format.ts). Three rows, in order:
 *
 *   1. cancel marker exists                    ⇒ canceled   (outranks job.json:
 *      the marker is written the instant cancel is requested, and the worker may
 *      never get to write its own terminal state)
 *   2. job.json.status is a terminal state      ⇒ that state, VERBATIM
 *   3. otherwise                               ⇒ running, or unknown if the
 *      anchor was unreadable
 *
 * ROW 2 HAS NO JUDGEMENT IN IT, and that is deliberate. The suspicious-success
 * downgrade — the headline rule of this whole codebase — is applied ONCE, at the
 * moment of writing, by `forge/format.ts`'s `deriveStatus`. It is not applied
 * again here. A normalizer that re-derived the verdict from the output would be a
 * second, subtly different implementation of the same rule, and the day the two
 * disagree the mod would draw one state while the channel announced another.
 *
 * The reader's job is to report what is on disk. The writer's job is to decide
 * what it means. One decision, one place.
 */
const smithNormalizer: JobNormalizer = (raw: RawJobState): ObservedJob => {
  const p = raw.payload;
  const warnings: ObservedWarning[] = [];

  const canceled = asBool(p[SMITH_PAYLOAD.canceled]) === true;
  const status = asString(p[SMITH_PAYLOAD.status]);
  const output = asString(p[SMITH_PAYLOAD.output]);
  const denied = p[SMITH_PAYLOAD.deniedActions];
  const deniedCount = Array.isArray(denied) ? denied.length : 0;
  const errorText = asString(p[SMITH_PAYLOAD.error]);
  const progressWarnings = asStringArray(p[SMITH_PAYLOAD.progressWarnings]);

  // A newer on-disk schema is not a job we understand. `unknown` is the honest
  // answer and it must survive to the surface: `unknown` is
  // load-bearing and must never be collapsed.
  const schema = asNumber(p[SMITH_PAYLOAD.schema]);

  if (deniedCount > 0) {
    const failedWithoutOutput = status === "failed" && (output === null || output.trim() === '');
    warnings.push({
      code: failedWithoutOutput ? "suspicious_success" : "tool_error",
      message: `${deniedCount} ${deniedCount === 1 ? 'call' : 'calls'} denied`,
    });
  }

  // The forge's error for a denial restates it ("denied view_file · …"); any other error still shows.
  if (errorText !== null && !(deniedCount > 0 && /^denied\b/.test(errorText))) {
    warnings.push({ code: "tool_error", message: errorText });
  }

  for (const w of progressWarnings) {
    warnings.push({ code: STEER_NOT_APPLIED_RE.test(w) ? "steer_not_applied" : "tool_error", message: w });
  }

  let resolved: ObservedStatus;
  if (canceled) {
    resolved = "canceled";
    warnings.push({ code: "canceled", message: "canceled" });
  } else if (schema !== null && schema > SCHEMA_VERSION) {
    // A newer writer's file. `unknown`, and NOT `running`: "we cannot read this"
    // is a different claim from "it is working", and drawing one as the other is
    // the specific failure `unknown` exists to prevent.
    resolved = "unknown";
    warnings.push({
      code: "incomplete_state",
      message: `schema v${schema} is newer than this reader (v${SCHEMA_VERSION})`,
    });
  } else if (status === "succeeded") {
    resolved = "succeeded";
    if (output === null || output.trim() === '') {
      // Defensive only. deriveStatus cannot produce `succeeded` with an empty
      // report, so reaching here means job.json was written by something other
      // than forge/writer.ts. Believe the file, flag the contradiction, and do
      // not silently upgrade a job with no output to a success.
      warnings.push({
        code: "empty_output",
        message: "done, but no output on disk",
      });
    }
  } else if (status === "failed") {
    resolved = "failed";
  } else if (status === "canceled") {
    resolved = "canceled";
  } else if (status === "running") {
    resolved = "running";
  } else if (raw.partial === true) {
    // The anchor is missing. NOT `running`: "we cannot tell" and "it is working"
    // are different claims and a band that draws one as the other is lying.
    resolved = "unknown";
    warnings.push({
      code: "incomplete_state",
      message: "job.json missing or unreadable",
    });
  } else {
    resolved = "unknown";
    warnings.push({
      code: "incomplete_state",
      message: "no status in job.json",
    });
  }

  // A cancelled job's empty output is expected, not a defect.
  const kept = resolved === "canceled" ? warnings.filter((w) => w.code !== "empty_output") : warnings;

  return buildSmith(raw, resolved, kept);
};

/** Assemble the ObservedJob for the agent-smith normalizer. */
function buildSmith(
  raw: RawJobState,
  status: ObservedStatus,
  warnings: ObservedWarning[],
): ObservedJob {
  const p = raw.payload;
  const usage = asUsage(p[SMITH_PAYLOAD.usage]);
  const toolCalls = asNumber(p[SMITH_PAYLOAD.toolCalls]);
  const usageFull: ObservedUsage | null =
    usage === null
      ? toolCalls === null || toolCalls === 0
        ? null
        : { turns: toolCalls }
      : toolCalls === null
        ? usage
        : { ...usage, turns: toolCalls };
  return {
    provider: "agent-smith",
    jobId: raw.jobId,
    status,
    warnings,
    output: asString(p[SMITH_PAYLOAD.output]),
    startedAt: asString(p[SMITH_PAYLOAD.startedAt]) ?? asString(p[SMITH_PAYLOAD.createdAt]),
    updatedAt: asString(p[SMITH_PAYLOAD.updatedAt]) ?? asString(p[SMITH_PAYLOAD.lastEventAt]),
    finishedAt: asString(p[SMITH_PAYLOAD.finishedAt]),
    mode: asString(p[SMITH_PAYLOAD.mode]),
    model: asString(p[SMITH_PAYLOAD.model]),
    // `label` is the pane's provider/permission word. Ours is honest about the
    // one field an operator must never have to guess: did this run with the
    // tool-approval prompt bypassed.
    label:
      asBool(p[SMITH_PAYLOAD.unrestricted]) === true
        ? "unrestricted"
        : asString(p[SMITH_PAYLOAD.provider]),
    outputTruncated: false,
    usage: usageFull,
    partial: raw.partial === true,
    raw: p,
  };
}

/**
 * Coerce a usage bag into the nullable ObservedUsage shape.
 *
 * Absent is absent. A provider that reports no token counts gets `null`, not a
 * bag of zeroes, because a confident `0` drawn on the pane is a measurement
 * nobody took.
 */
function asUsage(v: unknown): ObservedUsage | null {
  if (v === null || typeof v !== "object") return null;
  const src = v as Record<string, unknown>;
  const out: { -readonly [K in keyof ObservedUsage]: ObservedUsage[K] } = {};
  const map: ReadonlyArray<[string, keyof ObservedUsage]> = [
    ["inputTokens", "inputTokens"],
    ["outputTokens", "outputTokens"],
    ["thinkingTokens", "thinkingTokens"],
    ["cacheReadTokens", "cacheTokens"],
  ];
  for (const [from, to] of map) {
    const n = asNumber(src[from]);
    if (n !== null) out[to] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ── registry of normalizers ─────────────────────────────────────────────────

const NORMALIZERS: ReadonlyMap<string, JobNormalizer> = new Map<string, JobNormalizer>([
  ["agent-smith", smithNormalizer],
]);

/**
 * Normalize a raw provider snapshot.
 *
 * Unknown provider ⇒ returns a minimal `unknown` ObservedJob rather than
 * throwing, so adding a reader before adding its normalizer degrades to
 * "shows up but unknown", not "crashes the band".
 */
export function normalize(raw: RawJobState): ObservedJob {
  const norm = NORMALIZERS.get(raw.provider);
  return norm ? norm(raw) : fallbackNormalizer(raw);
}

/** Minimal normalization used when no provider-specific normalizer is registered. */
function fallbackNormalizer(raw: RawJobState): ObservedJob {
  return {
    provider: raw.provider,
    jobId: raw.jobId,
    status: "unknown",
    warnings: [
      {
        code: "incomplete_state",
        message: `No normalizer registered for provider "${raw.provider}".`,
      },
    ],
    output: null,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    mode: null,
    model: null,
    label: null,
    outputTruncated: false,
    usage: null,
    partial: true,
    raw: raw.payload,
  };
}

export { smithNormalizer };
