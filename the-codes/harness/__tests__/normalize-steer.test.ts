import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { FILES, jobFile } from "../../forge/format.ts";
import { AgentSmithReader, SMITH_PAYLOAD } from "../agent-smith.ts";
import { normalize } from "../normalize.ts";

test("progress warnings: the dropped-steer message is steer_not_applied, others stay tool_error", () => {
  const job = normalize({
    provider: "agent-smith", jobId: "j1", cwd: "/tmp/x",
    payload: {
      [SMITH_PAYLOAD.status]: "failed",
      [SMITH_PAYLOAD.progressWarnings]: [
        "2 queued steers not applied: the turn ended failed. Use resume_job or steer_job again.",
        "something else broke",
      ],
    },
  });
  assert.deepEqual(job.warnings.map((w) => w.code), ["steer_not_applied", "tool_error"]);
});

test("AgentSmithReader projects unified turn-chain fields and defensively reads 0.4.x job.json manifests", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "agent-smith-reader-chain-"));
  const writeJob = (id: string, data: Record<string, unknown>) => {
    const file = jobFile(repo, id, FILES.job);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      schema: 1, jobId: id, provider: "codex", mode: "implement", model: null, effort: null,
      cwd: repo, task: "t", promptChars: 1, unrestricted: false, conversation: null,
      status: "succeeded", createdAt: "2026-11-23T09:00:00.000Z", updatedAt: "2026-11-23T09:05:00.000Z",
      startedAt: "2026-11-23T09:00:00.000Z", finishedAt: "2026-11-23T09:05:00.000Z",
      exitCode: 0, jobStatus: "success", error: null, deniedActions: [], usage: null, toolCalls: 1,
      pipeline: null, stage: null, attempt: null, ...data,
    }));
  };

  writeJob("modern-turn", {
    workerId: "worker-a",
    turn: 3,
    continuedFrom: "prev-turn",
    continuationKind: "steer-interrupt",
    chainStartedAt: "2026-11-23T08:00:00.000Z",
  });
  writeJob("legacy-turn", {
    steeredFrom: "legacy-parent",
  });
  writeJob("followed-turn", { workerId: "worker-a", turn: 1, followedBy: "next-turn" });

  const reader = new AgentSmithReader();
  const modern = await reader.read(repo, "modern-turn");
  assert.ok(modern);
  assert.equal(modern.payload["workerId"], "worker-a");
  assert.equal(modern.payload["turn"], 3);
  assert.equal(modern.payload["continuedFrom"], "prev-turn");
  assert.equal(modern.payload["continuationKind"], "steer", "legacy steer-interrupt normalizes to steer");
  assert.equal(modern.payload["chainStartedAt"], "2026-11-23T08:00:00.000Z");
  assert.equal("steeredFrom" in modern.payload, false);

  const legacy = await reader.read(repo, "legacy-turn");
  assert.ok(legacy);
  assert.equal(legacy.payload["workerId"], "legacy-turn");
  assert.equal(legacy.payload["turn"], 1);
  assert.equal(legacy.payload["continuedFrom"], "legacy-parent");
  assert.equal(legacy.payload["continuationKind"], "follow-up", "a 0.4.x continuation without a kind is a follow-up");
  assert.equal(legacy.payload["chainStartedAt"], "2026-11-23T09:00:00.000Z");
  assert.equal("steeredFrom" in legacy.payload, false);

  const followed = await reader.read(repo, "followed-turn");
  assert.equal(followed?.payload["followedBy"], "next-turn");
});
