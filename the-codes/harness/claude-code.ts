/**
 * claude-code.ts — reads Claude Code's own native subagent transcripts.
 *
 * VERIFIED LAYOUT (from ~/.claude/projects, 696 real subagents scanned):
 *
 *   ~/.claude/projects/<projectSlug>/<sessionId>/subagents/
 *       agent-<agentId>.jsonl        NDJSON transcript
 *       agent-<agentId>.meta.json    { agentType, description, toolUseId,
 *                                      spawnDepth, requestShape, model, ... }
 *
 *  - <projectSlug> is derived from a launch cwd by replacing `/`, `\`, and `.`
 *    with `-`. This is a *heuristic*, verified to match for the common case:
 *      /Users/gathrid/Repos/topos → -Users-gathrid-Repos-topos
 *    BUT it demonstrably diverges when the session was launched from a parent
 *    dir or a worktree, e.g.
 *      cwd /Users/gathrid/Repos/renyi/src/s1
 *      slug -Users-gathrid-Repos-renyi--claude-worktrees-s1-model-demo-plan
 *    So we NEVER rely on the slug alone: we scan all project dirs and read the
 *    real `cwd` out of each transcript's first record. A wrong guess here means
 *    we silently show zero jobs, which is worse than being slow.
 *
 *  - `isSidechain: true` and `agentId` appear on every *conversation* record of
 *    a subagent transcript. Neither appears on the parent transcript. That is
 *    the reliable sidechain discriminator (the filename is a weaker hint, since
 *    a parent transcript could in principle be named anything).
 *    CAVEAT: fork subagents break the "every line" rule — they lead with a
 *    `{"type":"fork-context-ref", ...}` header that has `agentId` but no
 *    `isSidechain` and no `cwd`. Handled in findCwdInHead().
 *
 *  - KNOWN GAP (documented, not a bug): workflow subagents live one level
 *    deeper, at `subagents/workflows/<workflowId>/agent-<id>.jsonl`. This
 *    reader only scans `subagents/*.jsonl` at depth 1, so workflow subagents
 *    are NOT discovered. Supporting them means extending the composite job id
 *    to three segments; deliberately left out of scope rather than
 *    half-implemented, because a partially-parsed workflow agent is worse than
 *    an absent one. (~57 such files exist in the sampled corpus.)
 *
 *  - Tool calls are `message.content[]` blocks of type `tool_use`
 *    ({ id, name, input }); results are blocks of type `tool_result`
 *    ({ tool_use_id, content }) which may be a string OR an array of blocks.
 *
 *  - There is NO terminal marker record. Verified across 200 real transcripts:
 *    zero have a `subtype` field, and 115/200 have no SubagentHandback call.
 *    We therefore infer lifecycle from content (see below).
 *
 *  ────────────────────────────────────────────────────────────────────────────
 *  IMPORTANT CAVEAT — the format is explicitly UNSTABLE UPSTREAM.
 *  Claude Code's own docs describe the transcript format as "internal and
 *  changes between versions". Observed already across 696 files: the set of
 *  top-level record keys varies per version and per feature flag (we saw
 *  `slug`, `effort`, `advisorModel`, `worktreePath`, `isFork`,
 *  `stoppedByUser`, `apiErrorStatus`, `serverClassifierContext`, … appear on
 *  some records only).
 *
 *  THEREFORE, THIS READER IS DEFENSIVE BY CONSTRUCTION:
 *    · every field access is optional-chained and type-guarded
 *    · an unknown record shape is skipped, never fatal
 *    · a malformed NDJSON line is counted, never thrown
 *    · this file must never `throw`. A future Claude Code version that renames
 *      `message.content` should degrade to "job visible, no tool details",
 *      not to a crashed mod band.
 *  ────────────────────────────────────────────────────────────────────────────
 */

import os from "node:os";
import path from "node:path";

import { existsSafe, readJsonSafe, readTextSafe, readPrefixSafe, readdirSafe } from "./safe-fs.ts";
import type { JobStateReader, RawJobState } from "./types.ts";

/** payload keys the claude-code normalizer relies on. */
export const CLAUDE_PAYLOAD = {
  agentType: "agent_type",
  description: "description",
  model: "model",
  spawnDepth: "spawn_depth",
  requestShape: "request_shape",
  stoppedByUser: "stopped_by_user",
  isFork: "is_fork",
  parentAgentId: "parent_agent_id",
  transcriptCwd: "transcript_cwd",
  recordCount: "record_count",
  malformedLines: "malformed_lines",
  firstAt: "first_at",
  lastAt: "last_at",
  toolCalls: "tool_calls", // { name, count }[]
  errorRecords: "error_records", // count of API-error records
  handback: "handback", // SubagentHandback message, if any
  finalText: "final_text", // last assistant text block, fallback output
  sidechain: "sidechain", // bool: verified via isSidechain on records
} as const;

/** Derive the Claude project slug for a cwd. Heuristic — see file header. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[/\\.]/g, "-");
}

interface ClaudeSubMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
  requestShape?: string;
  model?: string;
  isFork?: boolean;
  parentAgentId?: string;
  stoppedByUser?: boolean;
  name?: string;
}

/** A discovered subagent, identified as `<sessionId>/<agentId>`. */
interface DiscoveredSubagent {
  readonly key: string; // "<sessionId>/<agentId>"
  readonly sessionId: string;
  readonly agentId: string;
  readonly jsonlPath: string;
  readonly metaPath: string;
}

export class ClaudeCodeReader implements JobStateReader {
  readonly provider = "claude-code";

  /**
   * Overridable root, for tests and for reading a relocated ~/.claude.
   *
   * WHY not hardcoded: the fixtures in __tests__/ mirror the real directory
   * layout, and a reader that can only ever read `$HOME/.claude/projects` is a
   * reader that cannot be tested. Default remains the real location.
   */
  private readonly rootOverride: string | null;

  constructor(options: { projectsRoot?: string } = {}) {
    this.rootOverride = options.projectsRoot ?? null;
  }

  private projectsRoot(): string {
    return this.rootOverride ?? path.join(os.homedir(), ".claude", "projects");
  }

  /**
   * Enumerate subagents belonging to a cwd.
   *
   * Strategy (correctness over speed): scan ALL project dirs (the slug
   * heuristic is unreliable), read each subagent's meta.json, and only then read
   * the transcript's first record to read the authoritative `cwd`. This is
   * O(#subagents) per call, which is heavy at 696 files — so we keep the
   * per-file reads minimal (meta.json is tiny; the transcript is read head-only).
   *
   * To keep this cheap for callers that poll, we filter candidate project dirs
   * by the exact slug FIRST; if that yields any matches we trust them, else we
   * fall back to the full scan. This gets the common case fast and stays
   * correct for the worktree/parent-dir divergence.
   *
   * `discover` never throws; returns [] on any trouble.
   */
  async discover(cwd: string): Promise<string[]> {
    const slug = projectSlug(cwd);
    const root = this.projectsRoot();

    // Fast path: only the dir whose slug matches exactly.
    const fast = await this.scanProjectDir(path.join(root, slug), cwd);
    if (fast.length > 0) return fast.map((s) => s.key).sort();

    // Slow-but-correct path: slug heuristic failed (worktree/parent launch dir).
    // Scan every project dir, filtering by the transcript's real `cwd`.
    const projectDirs = await readdirSafe(root);
    const all: DiscoveredSubagent[] = [];
    for (const dir of projectDirs) {
      if (dir === slug) continue; // already scanned in fast path
      const found = await this.scanProjectDir(path.join(root, dir), cwd);
      all.push(...found);
    }
    return all.map((s) => s.key).sort();
  }

  /**
   * Scan one project-slug dir for subagents whose transcript `cwd` matches.
   * Matches if the transcript cwd equals the requested cwd OR the requested cwd
   * is an ancestor of the transcript cwd (a subagent spawned in a subdirectory).
   */
  private async scanProjectDir(projectDir: string, cwd: string): Promise<DiscoveredSubagent[]> {
    const sessionIds = await readdirSafe(projectDir);
    const out: DiscoveredSubagent[] = [];
    for (const sessionId of sessionIds) {
      const subDir = path.join(projectDir, sessionId, "subagents");
      const files = await readdirSafe(subDir);
      for (const name of files) {
        if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
        const agentId = name.slice("agent-".length, -".jsonl".length);
        const jsonlPath = path.join(subDir, name);
        const metaPath = path.join(subDir, `agent-${agentId}.meta.json`);

        // cwd comes from the transcript, so read the head. NOT just line 0:
        // fork subagents lead with a `fork-context-ref` header that has no cwd
        // (see findCwdInHead).
        const head = await readPrefixSafe(jsonlPath, 8 * 1024);
        if (head === null) continue;
        const transcriptCwd = findCwdInHead(head);
        if (transcriptCwd === null) continue;

        // cwd match: equal, or transcript cwd is under the requested cwd.
        const normReq = cwd.replace(/\/+$/, "");
        const normTr = transcriptCwd.replace(/\/+$/, "");
        const matches =
          normTr === normReq || normTr.startsWith(normReq + path.sep) || normReq.startsWith(normTr + path.sep);
        if (!matches) continue;

        out.push({ key: `${sessionId}/${agentId}`, sessionId, agentId, jsonlPath, metaPath });
      }
    }
    return out;
  }

  /**
   * Read one subagent's current state.
   *
   * `jobId` is the composite key returned by discover(): `<sessionId>/<agentId>`.
   * Returns null only if neither the transcript nor the meta can be found/read.
   */
  async read(cwd: string, jobId: string): Promise<RawJobState | null> {
    const slash = jobId.indexOf("/");
    if (slash === -1) return null;
    const sessionId = jobId.slice(0, slash);
    const agentId = jobId.slice(slash + 1);
    if (sessionId.length === 0 || agentId.length === 0) return null;

    // The meta sidecar sits beside the transcript; resolve it the same way.
    const meta = await this.resolveSidecar(sessionId, agentId);

    // The meta sidecar is optional and may lag/be absent; prefer the transcript
    // as the source of truth for content, use meta for descriptors only.
    const raw = await this.readTranscript(sessionId, agentId);
    if (raw === null && meta === null) return null; // nothing readable at all

    const payload: Record<string, unknown> = {
      [CLAUDE_PAYLOAD.agentType]: meta?.agentType ?? null,
      [CLAUDE_PAYLOAD.description]: meta?.description ?? null,
      [CLAUDE_PAYLOAD.model]: meta?.model ?? null,
      [CLAUDE_PAYLOAD.spawnDepth]: meta?.spawnDepth ?? null,
      [CLAUDE_PAYLOAD.requestShape]: meta?.requestShape ?? null,
      [CLAUDE_PAYLOAD.stoppedByUser]: meta?.stoppedByUser ?? null,
      [CLAUDE_PAYLOAD.isFork]: meta?.isFork ?? null,
      [CLAUDE_PAYLOAD.parentAgentId]: meta?.parentAgentId ?? null,
      [CLAUDE_PAYLOAD.transcriptCwd]: raw?.cwd ?? null,
      [CLAUDE_PAYLOAD.recordCount]: raw?.recordCount ?? 0,
      [CLAUDE_PAYLOAD.malformedLines]: raw?.malformedCount ?? 0,
      [CLAUDE_PAYLOAD.firstAt]: raw?.firstAt ?? null,
      [CLAUDE_PAYLOAD.lastAt]: raw?.lastAt ?? null,
      [CLAUDE_PAYLOAD.toolCalls]: raw?.toolCalls ?? [],
      [CLAUDE_PAYLOAD.errorRecords]: raw?.errorRecords ?? 0,
      [CLAUDE_PAYLOAD.handback]: raw?.handback ?? null,
      [CLAUDE_PAYLOAD.finalText]: raw?.finalText ?? null,
      [CLAUDE_PAYLOAD.sidechain]: raw?.sawSidechain ?? false,
    };

    return {
      provider: this.provider,
      jobId,
      cwd: raw?.cwd ?? cwd,
      payload,
      partial: raw === null || raw.sawSidechain === false,
    };
  }

  /**
   * Read the meta sidecar for a subagent, tolerating its absence.
   *
   * The sidecar is a NEWER, "compact" artifact — it did not exist in older
   * Claude Code versions, and 70/696 real metas are missing `requestShape`
   * outright. So it is strictly optional: descriptors come from it when it is
   * there, and the transcript is the source of truth for content either way.
   */
  private async resolveSidecar(
    sessionId: string,
    agentId: string,
  ): Promise<ClaudeSubMeta | null> {
    const resolved = await this.resolveSubagentFile(
      sessionId,
      `agent-${agentId}.meta.json`,
    );
    if (resolved === null) return null;
    return readJsonSafe<ClaudeSubMeta>(resolved);
  }

  /**
   * Parse a full subagent transcript defensively.
   *
   * Reads the whole jsonl (cap via safe-fs default) and folds every record into
   * a small summary. Every field is optional/guarded: a future Claude Code that
   * renames `message.content` yields an empty tool list, not an exception.
   */
  private async readTranscript(
    sessionId: string,
    agentId: string,
  ): Promise<{
    cwd: string | null;
    recordCount: number;
    malformedCount: number;
    firstAt: string | null;
    lastAt: string | null;
    toolCalls: Array<{ name: string; count: number }>;
    errorRecords: number;
    handback: string | null;
    finalText: string | null;
    sawSidechain: boolean;
  } | null> {
    // Resolve the real path (the project slug is not derivable from cwd alone).
    const resolved = await this.resolveSubagentFile(sessionId, `agent-${agentId}.jsonl`);
    if (resolved === null) return null;
    const text = await readTextSafe(resolved);
    if (text === null) return null;

    const toolTally = new Map<string, number>();
    let recordCount = 0;
    let malformedCount = 0;
    let errorRecords = 0;
    let sawSidechain = false;
    let cwd: string | null = null;
    let firstAt: string | null = null;
    let lastAt: string | null = null;
    let handback: string | null = null;
    let finalText: string | null = null;

    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // A malformed line is tolerated and counted (defensive-by-design).
        malformedCount += 1;
        continue;
      }
      recordCount += 1;
      if (rec["isSidechain"] === true) sawSidechain = true;
      if (typeof rec["cwd"] === "string" && cwd === null) cwd = rec["cwd"];

      const ts = rec["timestamp"];
      if (typeof ts === "string") {
        if (firstAt === null) firstAt = ts;
        lastAt = ts;
      }

      // API-error records: verified real keys `isApiErrorMessage` / `apiErrorStatus`.
      if (rec["isApiErrorMessage"] === true || typeof rec["error"] === "string") {
        errorRecords += 1;
      }

      // Walk message.content[] defensively.
      const message = rec["message"];
      const content =
        typeof message === "object" && message !== null
          ? (message as Record<string, unknown>)["content"]
          : null;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        const btype = b["type"];
        if (btype === "tool_use") {
          const name = typeof b["name"] === "string" ? b["name"] : "unknown";
          toolTally.set(name, (toolTally.get(name) ?? 0) + 1);
          const input = b["input"];
          if (
            name === "SubagentHandback" &&
            typeof input === "object" &&
            input !== null &&
            typeof (input as Record<string, unknown>)["message"] === "string"
          ) {
            handback = (input as Record<string, unknown>)["message"] as string;
          }
        } else if (btype === "text" && typeof b["text"] === "string") {
          finalText = b["text"];
        }
      }
    }

    const toolCalls = [...toolTally.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    return {
      cwd,
      recordCount,
      malformedCount,
      firstAt,
      lastAt,
      toolCalls,
      errorRecords,
      handback,
      finalText,
      sawSidechain,
    };
  }

  /**
   * Find the concrete on-disk path of a file in `<session>/subagents/`.
   *
   * WHY a search instead of computing the project slug from cwd: the slug
   * heuristic is demonstrably wrong for sessions launched from a parent dir or a
   * worktree (verified against the real corpus). The transcript itself is
   * authoritative, so we find the file rather than guess where it lives.
   */
  private async resolveSubagentFile(
    sessionId: string,
    fileName: string,
  ): Promise<string | null> {
    const root = this.projectsRoot();
    const projectDirs = await readdirSafe(root);
    for (const dir of projectDirs) {
      const candidate = path.join(root, dir, sessionId, "subagents", fileName);
      if (await existsSafe(candidate)) return candidate;
    }
    return null;
  }
}

/**
 * Find a subagent's `cwd` in the leading records of its transcript.
 *
 * WHY THIS EXISTS — a real trap found by scanning all 696 real subagents:
 * fork subagents do NOT start with a conversation record. They start with a
 * `fork-context-ref` header:
 *
 *   {"type":"fork-context-ref","agentId":"awhere-are-wer-...","parentSessionId":...,
 *    "contextLength":107}
 *
 * That header has NO `cwd`. The first record that does is one line later. A
 * reader that only inspects line 0 therefore makes every fork subagent
 * INVISIBLE — it would silently drop ~8 real jobs rather than fail loudly, which
 * is the worst possible failure mode for an observability tool.
 *
 * So: scan the leading records (bounded) for the first string `cwd`.
 */
function findCwdInHead(head: string): string | null {
  let seen = 0;
  for (const line of head.split("\n")) {
    if (line.trim().length === 0) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a malformed leading line must not stop the search
    }
    const cwd = rec["cwd"];
    if (typeof cwd === "string" && cwd.length > 0) return cwd;
    seen += 1;
    // Bounded: a transcript with no cwd in its first 20 records has none we
    // can trust. Stopping here keeps discovery cheap.
    if (seen >= 20) break;
  }
  return null;
}