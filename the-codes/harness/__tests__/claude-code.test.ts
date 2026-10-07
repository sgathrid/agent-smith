/**
 * claude-code.test.ts — defensive-parsing tests for the native transcript reader.
 *
 * The single most important property here is NEGATIVE: the reader must never
 * throw on an unknown/malformed shape, because Claude Code's own docs call this
 * format "internal and changes between versions". A future rename of
 * `message.content` should cost us detail, not crash the mod band.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { ClaudeCodeReader, projectSlug, CLAUDE_PAYLOAD } from "../claude-code.ts";
import { normalize } from "../normalize.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "fixtures", "claude-root");
const CWD = "/tmp/fixture-repo";
const AGENT_ID = "a13ddc0eb936964c9";
const SESSION_ID = "sess-fixture01";
const JOB_ID = `${SESSION_ID}/${AGENT_ID}`;

function reader(): ClaudeCodeReader {
  return new ClaudeCodeReader({ projectsRoot: ROOT });
}

test("projectSlug maps a cwd the way Claude Code does", () => {
  assert.equal(projectSlug("/Users/gathrid/Repos/topos"), "-Users-gathrid-Repos-topos");
  // Verified divergence case: the slug heuristic is NOT reliable for worktrees,
  // which is exactly why discover() falls back to reading the transcript cwd.
  assert.equal(projectSlug("/Users/gathrid/Repos/renyi"), "-Users-gathrid-Repos-renyi");
});

test("discover finds a subagent by the transcript's own cwd", async () => {
  const ids = await reader().discover(CWD);
  assert.deepEqual(ids, [
    "sess-fixture01/a13ddc0eb936964c9",
    "sess-fixture02/awhere-are-wer-19d6b03cd46a71b9",
  ]);
});

test("discover does NOT miss a FORK subagent whose first record has no cwd", async () => {
  // Regression guard for a real trap found by scanning all 696 real subagents:
  // fork transcripts lead with `{"type":"fork-context-ref", ...}`, which has no
  // `cwd`. A reader that only inspects line 0 makes every fork subagent
  // invisible — a SILENT omission, the worst failure mode for a visibility tool.
  const ids = await reader().discover(CWD);
  assert.ok(
    ids.includes("sess-fixture02/awhere-are-wer-19d6b03cd46a71b9"),
    "fork subagent must be discovered even though its first record has no cwd",
  );

  const raw = await reader().read(CWD, "sess-fixture02/awhere-are-wer-19d6b03cd46a71b9");
  assert.ok(raw);
  assert.equal(raw.payload[CLAUDE_PAYLOAD.transcriptCwd], CWD);
  assert.equal(raw.payload[CLAUDE_PAYLOAD.isFork], true);
  assert.equal(raw.payload[CLAUDE_PAYLOAD.parentAgentId], "a13ddc0eb936964c9");
  // A fork agentId is not plain hex; slicing the filename must handle that.
  assert.match(String(raw.payload[CLAUDE_PAYLOAD.handback]), /## Fork report/);
});

test("read tolerates a malformed jsonl line and counts it", async () => {
  const raw = await reader().read(CWD, JOB_ID);
  assert.ok(raw);
  // The fixture contains exactly one deliberately-invalid NDJSON line.
  assert.equal(raw.payload[CLAUDE_PAYLOAD.malformedLines], 1);
  // ...and the valid records around it were still parsed.
  assert.ok((raw.payload[CLAUDE_PAYLOAD.recordCount] as number) >= 5);
});

test("read tolerates a record with no `message` key at all", async () => {
  const raw = await reader().read(CWD, JOB_ID);
  assert.ok(raw);
  // The attachment-only record and the API-error record both lack content; the
  // reader must skip them without throwing. Reaching here at all proves it.
  assert.equal(raw.payload[CLAUDE_PAYLOAD.errorRecords], 1);
});

test("read extracts meta descriptors, tools, and the handback", async () => {
  const raw = await reader().read(CWD, JOB_ID);
  assert.ok(raw);
  assert.equal(raw.payload[CLAUDE_PAYLOAD.agentType], "general-purpose");
  assert.equal(raw.payload[CLAUDE_PAYLOAD.description], "Verify other harness claims");
  assert.equal(raw.payload[CLAUDE_PAYLOAD.spawnDepth], 1);
  assert.equal(raw.payload[CLAUDE_PAYLOAD.requestShape], "background");
  assert.equal(raw.payload[CLAUDE_PAYLOAD.sidechain], true);

  const tools = raw.payload[CLAUDE_PAYLOAD.toolCalls] as Array<{ name: string; count: number }>;
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("Bash"));
  assert.ok(names.includes("SubagentHandback"));

  assert.match(String(raw.payload[CLAUDE_PAYLOAD.handback]), /## Findings/);
});

test("normalize: a handback means succeeded, with the API error kept as a warning", async () => {
  const raw = await reader().read(CWD, JOB_ID);
  assert.ok(raw);
  const job = normalize(raw);
  assert.equal(job.status, "succeeded");
  assert.ok(job.output?.includes("3 claims verified"));
  const codes = job.warnings.map((w) => w.code);
  // The malformed line and the API error must both surface as warnings rather
  // than being silently swallowed.
  assert.ok(codes.includes("tool_error"));
  assert.ok(codes.includes("incomplete_state"));
});

test("read returns null for an unknown job key (never throws)", async () => {
  assert.equal(await reader().read(CWD, "sess-nope/agent-nope"), null);
  // Malformed key (no slash) must also be null, not a crash.
  assert.equal(await reader().read(CWD, "no-slash-here"), null);
});

test("discover on an unknown projects root returns [] and does not throw", async () => {
  const empty = new ClaudeCodeReader({ projectsRoot: "/definitely/not/here" });
  assert.deepEqual(await empty.discover(CWD), []);
});