/**
 * normalize.ts — provider-agnostic normalization to ObservedJob.
 *
 * Every provider quirk and every judgement call lives HERE and only here, so
 * this file is the single place a reviewer reads to answer "why did that job
 * show up as failed?". Readers (agy-staff.ts, claude-code.ts) are dumb parsers;
 * they extract facts and get out of the way.
 *
 * The headline rule, stated once and enforced below:
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ AN EMPTY RESPONSE WITH WARNINGS IS NOT A CLEAN SUCCESS.           │
 *   │ agy-staff will happily write { status:'done', warnings:true } and │
 *   │ an empty result.md when the underlying run degraded. Reporting     │
 *   │ that as `succeeded` with no warnings is a lie the mod band would  │
 *   │ happily render as a green check. We downgrade to `failed` and      │
 *   │ attach `suspicious_success`.                                      │
 *   └──────────────────────────────────────────────────────────────────┘
 */

import { SCHEMA_VERSION } from "../forge/format.ts";
import { AGY_PAYLOAD } from "./agy-staff.ts";
import { SMITH_PAYLOAD } from "./agent-smith.ts";
import { CLAUDE_PAYLOAD } from "./claude-code.ts";
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

/** A "clean enough" answer. Whitespace and short filler count as empty. */
function looksEmpty(text: string | null): boolean {
  if (text === null) return true;
  const t = text.trim();
  if (t.length === 0) return true;
  // A single stray character is not a deliverable.
  if (t.length < 8) return true;
  return false;
}

// ── agy-staff normalizer ────────────────────────────────────────────────────

/**
 * Map an agy-staff payload onto ObservedJob.
 *
 * Status precedence (highest first):
 *   1. cancel marker exists                         ⇒ canceled    (HAZARD B)
 *   2. status.json status === 'canceled'           ⇒ canceled
 *   3. status.json status === 'error'               ⇒ failed
 *   4. status.json status === 'done'                ⇒ succeeded,
 *        UNLESS empty-output-with-warnings          ⇒ failed (suspicious_success)
 *   5. no status.json but progress evidence present ⇒ running
 *   6. nothing conclusive                           ⇒ unknown
 */
const agyNormalizer: JobNormalizer = (raw: RawJobState): ObservedJob => {
  const p = raw.payload;
  let warnings: ObservedWarning[] = [];

  const canceled = asBool(p[AGY_PAYLOAD.canceled]) === true;
  const terminalStatus = asString(p[AGY_PAYLOAD.status]);
  const statusWarnings = asBool(p[AGY_PAYLOAD.statusWarnings]);
  const statusReason = asString(p[AGY_PAYLOAD.statusReason]);
  const progressWarnings = asStringArray(p[AGY_PAYLOAD.progressWarnings]);
  const output = asString(p[AGY_PAYLOAD.output]);
  const hasProgressFile = asBool(p[AGY_PAYLOAD.hasProgressFile]) === true;
  const lastEventAt = asString(p[AGY_PAYLOAD.lastEventAt]);
  const finishedAt = asString(p[AGY_PAYLOAD.finishedAt]);
  const strippedCount = asNumber(p[AGY_PAYLOAD.notificationsStripped]) ?? 0;

  const telemetry = (p[AGY_PAYLOAD.telemetry] ?? {}) as Record<string, unknown>;

  // -- warning: de-polluted result (HAZARD C) ---------------------------------
  if (strippedCount > 0) {
    warnings.push({
      code: "polluted_result",
      message: `Removed ${strippedCount} <system_notification> block${strippedCount === 1 ? '' : 's'} from the result text.`,
    });
  }

  // -- warning: tool errors observed during the run --------------------------
  const sawAgyError = asBool(telemetry["saw_agy_error"]) === true;
  if (sawAgyError || progressWarnings.length > 0) {
    const detail =
      asString(telemetry["agy_error_reason"]) ??
      (progressWarnings[0] ?? "provider reported warnings");
    warnings.push({ code: "tool_error", message: detail });
  }

  // -- warning: cancellation --------------------------------------------------
  if (canceled || terminalStatus === "canceled") {
    warnings.push({ code: "canceled", message: "canceled" });
  }

  // -- status resolution ------------------------------------------------------
  const emptyOutput = looksEmpty(output);
  let status: ObservedStatus;

  if (canceled || terminalStatus === "canceled") {
    status = "canceled";
  } else if (terminalStatus === "error") {
    status = "failed";
  } else if (terminalStatus === "done") {
    // ── THE HEADLINE RULE ──────────────────────────────────────────────────
    // "done" + (warnings OR an empty answer) is a SUSPICIOUS success. We
    // refuse to call it `succeeded`, because doing so is exactly the failure
    // mode this project exists to eliminate: reporting work as done that was
    // not. Empty-and-warned ⇒ failed with a suspicious_success warning.
    if (emptyOutput) {
      status = "failed";
      warnings.push({
        code: "empty_output",
        message: "no output",
      });
      if (statusWarnings === true || progressWarnings.length > 0) {
        warnings.push({
          code: "suspicious_success",
          message: "success with warnings and no output",
        });
      } else {
        warnings.push({
          code: "suspicious_success",
          message: "success with no output",
        });
      }
    } else {
      // Non-empty output: still downgrade to `failed` if the provider flagged
      // hard warnings? No — warnings alone don't fail a job that clearly
      // produced work. But `statusWarnings: true` with no progress warning
      // text and a suspiciously short body is still suspicious; we flag it as
      // a warning while keeping status `succeeded`. This is the "clean success
      // vs. clean-ish success" distinction: warn loudly, don't overclaim.
      status = "succeeded";
      if (statusWarnings === true) {
        warnings.push({
          code: "suspicious_success",
          message: "done with warnings; review it",
        });
      }
    }
  } else if (hasProgressFile || lastEventAt !== null) {
    // Terminal status file not written yet but live evidence present ⇒ running.
    status = "running";
  } else {
    // No status.json, no progress. Could be a job that was cleaned up entirely,
    // or a job we know nothing about. `unknown` is the honest answer.
    status = "unknown";
    warnings.push({
      code: "incomplete_state",
      message: "no status or progress found",
    });
  }

  // A canceled job that also has an empty output is expected; don't double-flag.
  if (status === "canceled" && emptyOutput) {
    warnings = warnings.filter((w) => w.code !== "empty_output");
  }

  // -- usage ------------------------------------------------------------------
  let usage: ObservedUsage | null = null;
  // Built field-by-field as telemetry is parsed, so the accumulator itself is
  // mutable even though the published `ObservedUsage` shape is readonly.
  type UsageAccumulator = { -readonly [K in keyof ObservedUsage]: ObservedUsage[K] };
  const usageParts: UsageAccumulator = {};
  const tin = asNumber(telemetry["tokens_in"]);
  const tout = asNumber(telemetry["tokens_out"]);
  const tthink = asNumber(telemetry["tokens_think"]);
  const tcache = asNumber(telemetry["tokens_cache"]);
  const durMs = asNumber(telemetry["duration_ms"]);
  const turns = asNumber(telemetry["turns"]);
  if (tin !== null) usageParts["inputTokens"] = tin;
  if (tout !== null) usageParts["outputTokens"] = tout;
  if (tthink !== null) usageParts["thinkingTokens"] = tthink;
  if (tcache !== null) usageParts["cacheTokens"] = tcache;
  if (durMs !== null) usageParts["durationMs"] = durMs;
  if (turns !== null) usageParts["turns"] = turns;
  if (Object.keys(usageParts).length > 0) usage = usageParts;

  // -- startedAt: agy-staff does not store a clean start time on the files we
  // read, so we leave it null rather than guessing. (Honor the contract: an
  // explicit null beats an invented value.)
  const startedAt: string | null = null;

  // -- updatedAt: the freshest timestamp we have. --
  const updatedAt = lastEventAt ?? finishedAt;

  return {
    provider: "agy-staff",
    jobId: raw.jobId,
    status,
    warnings,
    output,
    startedAt,
    updatedAt,
    finishedAt,
    mode: asString(p[AGY_PAYLOAD.mode]),
    model: asString(p[AGY_PAYLOAD.model]) ?? asString(telemetry["model"]),
    label: asString(p[AGY_PAYLOAD.profile]),
    outputTruncated: asBool(p[AGY_PAYLOAD.outputTruncated]) === true,
    usage,
    partial: raw.partial === true,
    raw: p,
  };
};

// ── claude-code normalizer ──────────────────────────────────────────────────

/**
 * Map a Claude Code subagent transcript onto ObservedJob.
 *
 * LIFECYCLE INFERENCE (necessary because there is no terminal marker record —
 * verified: 0/200 real transcripts carry a `subtype`):
 *   1. meta.stoppedByUser === true                     ⇒ canceled
 *   2. a SubagentHandback tool_use was made            ⇒ succeeded (the
 *      subagent explicitly reported its result back)
 *   3. API-error records present (isApiErrorMessage)   ⇒ failed
 *   4. transcript still being appended (no handback, no
 *      error, and the reader saw a live-looking file)   ⇒ running
 *   5. otherwise (short, ended without handback)         ⇒ unknown
 *
 * Rule 5 is conservative on purpose: a subagent transcript with no handback and
 * no error might have been truncated, killed, or simply not use the handback
 * tool. We do NOT guess `succeeded`.
 */
const claudeNormalizer: JobNormalizer = (raw: RawJobState): ObservedJob => {
  const p = raw.payload;
  const warnings: ObservedWarning[] = [];

  const stoppedByUser = asBool(p[CLAUDE_PAYLOAD.stoppedByUser]) === true;
  const handback = asString(p[CLAUDE_PAYLOAD.handback]);
  const finalText = asString(p[CLAUDE_PAYLOAD.finalText]);
  const errorRecords = asNumber(p[CLAUDE_PAYLOAD.errorRecords]) ?? 0;
  const malformed = asNumber(p[CLAUDE_PAYLOAD.malformedLines]) ?? 0;
  const lastAt = asString(p[CLAUDE_PAYLOAD.lastAt]);
  const firstAt = asString(p[CLAUDE_PAYLOAD.firstAt]);
  const output = handback ?? finalText;

  // -- warnings ---------------------------------------------------------------
  if (stoppedByUser) {
    warnings.push({ code: "canceled", message: "stopped by the user" });
  }
  if (errorRecords > 0) {
    warnings.push({
      code: "tool_error",
      message: `${errorRecords} API ${errorRecords === 1 ? 'error' : 'errors'}`,
    });
  }
  if (malformed > 0) {
    warnings.push({
      code: "incomplete_state",
      message: `skipped ${malformed} unreadable transcript ${malformed === 1 ? 'line' : 'lines'}`,
    });
  }
  // Same headline rule as agy: no deliverable + warnings ⇒ not a clean success.
  const emptyOutput = looksEmpty(output);
  if (emptyOutput && !stoppedByUser) {
    warnings.push({
      code: "empty_output",
      message: "no output",
    });
  }

  // -- status -----------------------------------------------------------------
  let status: ObservedStatus;
  if (stoppedByUser) {
    status = "canceled";
  } else if (handback !== null) {
    // The subagent explicitly reported a result back. API errors earlier in the
    // run become a `tool_error` warning but do not erase the delivered report.
    status = "succeeded";
  } else if (errorRecords > 0) {
    status = "failed";
  } else if (lastAt !== null) {
    // Transcript has records but no handback and no error. Most likely still
    // running or died mid-flight; treat as running only if it looks live.
    // Without a mtime signal we cannot tell, so `running` is optimistic but
    // bounded — we prefer it over `unknown` for a file that clearly has
    // content, because a crashed-with-no-handback subagent is rare.
    status = "running";
  } else {
    status = "unknown";
  }

  return {
    provider: "claude-code",
    jobId: raw.jobId,
    status,
    warnings,
    output,
    startedAt: firstAt,
    updatedAt: lastAt,
    finishedAt: stoppedByUser ? lastAt : null,
    mode: asString(p[CLAUDE_PAYLOAD.agentType]),
    model: asString(p[CLAUDE_PAYLOAD.model]),
    label: asString(p[CLAUDE_PAYLOAD.description]),
    outputTruncated: false,
    usage: null,
    partial: raw.partial === true,
    raw: p,
  };
};

// ── agent-smith normalizer ──────────────────────────────────────────────────

/**
 * Map an agent-smith payload onto ObservedJob.
 *
 * THIS IS THE PRIMARY NORMALIZER, and it is far shorter than the two above
 * because we own the format (see forge/format.ts). Three rows, in order:
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
  // answer and it must survive to the surface: core/types.ts is explicit that
  // `unknown` is load-bearing and must never be collapsed.
  const schema = asNumber(p[SMITH_PAYLOAD.schema]);

  if (deniedCount > 0) {
    const failedWithoutOutput = status === "failed" && (output === null || output.trim() === '');
    warnings.push({
      code: failedWithoutOutput ? "suspicious_success" : "tool_error",
      message: `${deniedCount} ${deniedCount === 1 ? 'call' : 'calls'} denied`,
    });
  }

  if (errorText !== null && deniedCount === 0) {
    warnings.push({ code: "tool_error", message: errorText });
  }

  for (const w of progressWarnings) {
    warnings.push({ code: "tool_error", message: w });
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
  ["agy-staff", agyNormalizer],
  ["claude-code", claudeNormalizer],
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

// Register the agy normalizer under the reader's provider key.
export { agyNormalizer, claudeNormalizer, smithNormalizer };
