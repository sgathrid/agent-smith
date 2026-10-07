/**
 * agy-staff.test.ts — reader-level tests against fixtures built from REAL data.
 *
 * Fixture provenance is recorded in fixtures/README.md. Every fixture is a
 * faithful copy of a real file from /Users/gathrid/Repos/renyi/.agy-staff/jobs
 * (or the real ~/.claude/projects), with only the huge prompt strings redacted.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { AgyStaffReader, stripSystemNotifications, parseLogTelemetry } from "../agy-staff.ts";
import { normalize } from "../normalize.ts";
import { readTextSafe } from "../safe-fs.ts";
import { AGY_PAYLOAD } from "../agy-staff.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures");

/**
 * Fixtures are laid out as `<fixture>/<jobId>.<file>` but the reader wants a
 * `<cwd>/.agy-staff/jobs/` tree. We expose the fixture dir directly by making
 * each fixture directory *be* the jobs dir via a tiny indirection: pass the
 * fixture's PARENT as cwd when the fixture dir is named `jobs`, else we point
 * the reader at a directory whose `.agy-staff/jobs` we alias.
 *
 * Simplest correct approach: each fixture dir contains its files flat, so we
 * create a per-test symlink-free shim directory. Rather than symlinks (which
 * are fragile on some CI filesystems), the tests below construct a real
 * `<tmp>/.agy-staff/jobs` and COPY the fixture files into it. Copying also
 * exercises the "worker owns this dir, we are a bystander" framing.
 */
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

/** Materialize a fixture dir as `<tmpRoot>/.agy-staff/jobs` and return tmpRoot. */
async function stageFixture(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agy-harness-"));
  await cp(path.join(FIX, name), path.join(root, ".agy-staff", "jobs"), { recursive: true });
  return root;
}

// ── HAZARD A: deleted progress.json means FINISHED, not missing ──────────────

test("HAZARD A: clean success with deleted progress.json still reads as a full job", async () => {
  const root = await stageFixture("agy-clean-success");
  try {
    const reader = new AgyStaffReader();
    const ids = await reader.discover(root);
    assert.deepEqual(ids, ["implement-clean01-aaaaaaaa"]);

    const raw = await reader.read(root, "implement-clean01-aaaaaaaa");
    // The crux of hazard A: progress.json and events.jsonl do NOT exist, and
    // read() must STILL return a snapshot (not null, not an error).
    assert.ok(raw, "read() must not return null just because progress.json is gone");

    // Terminal state was anchored on result.md.status.json, as designed.
    assert.equal(raw.payload[AGY_PAYLOAD.status], "done");
    assert.equal(raw.payload[AGY_PAYLOAD.finishedAt], "2026-10-03T17:05:44.132Z");
    assert.equal(raw.payload[AGY_PAYLOAD.hasProgressFile], false);
    assert.equal(raw.payload[AGY_PAYLOAD.hasEventsFile], false);

    const job = normalize(raw);
    assert.equal(job.status, "succeeded");
    assert.equal(job.partial, false); // status.json WAS present ⇒ not partial
    assert.deepEqual(
      job.warnings.map((w) => w.code).sort(),
      [],
      "a genuinely clean job must produce zero warnings",
    );
    assert.match(job.output ?? "", /## What I changed/);
    // telemetry survived the missing progress file
    assert.equal(job.usage?.inputTokens, 2221077);
    assert.equal(job.usage?.outputTokens, 137616);
    assert.equal(job.usage?.durationMs, 1681549); // round(1681.549339s * 1000)
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HAZARD A: a job with NO evidence at all returns null (not a crash)", async () => {
  const root = await stageFixture("agy-clean-success");
  try {
    const reader = new AgyStaffReader();
    assert.equal(await reader.read(root, "implement-does-not-exist"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── HAZARD B: .spec.json.cancel marker ───────────────────────────────────────

test("HAZARD B: cancel marker file is detected and forces status canceled", async () => {
  const root = await stageFixture("agy-canceled");
  try {
    const reader = new AgyStaffReader();
    const ids = await reader.discover(root);
    assert.deepEqual(ids, ["implement-murvydru-07eed78d"]);

    const raw = await reader.read(root, "implement-murvydru-07eed78d");
    assert.ok(raw);
    // The marker and its timestamp body must both be surfaced.
    assert.equal(raw.payload[AGY_PAYLOAD.canceled], true);
    assert.equal(raw.payload[AGY_PAYLOAD.cancelAt], "2026-10-03T04:24:33.249Z");

    const job = normalize(raw);
    assert.equal(job.status, "canceled");
    assert.ok(job.warnings.some((w) => w.code === "canceled"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HAZARD B: cancel marker wins even if status.json is absent", async () => {
  // A cancel can be mid-flight: the marker exists before status.json is final.
  const root = await stageFixture("agy-canceled");
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(path.join(root, ".agy-staff/jobs/implement-murvydru-07eed78d.result.md.status.json"));

    const reader = new AgyStaffReader();
    const raw = await reader.read(root, "implement-murvydru-07eed78d");
    assert.ok(raw, "marker alone is enough evidence the job exists");
    assert.equal(raw.payload[AGY_PAYLOAD.canceled], true);
    assert.equal(raw.payload[AGY_PAYLOAD.status], null);

    const job = normalize(raw);
    assert.equal(job.status, "canceled");
    assert.equal(job.partial, true); // no terminal status file
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── HAZARD C: system_notification stripping ──────────────────────────────────

test("HAZARD C: stripSystemNotifications removes all 12 real blocks from the real file", async () => {
  const real = await readTextSafe(
    path.join(FIX, "agy-polluted", "implement-musm82da-f1dc1fe4.result.md"),
  );
  assert.ok(real, "fixture must exist");
  // Preconditions, asserted against the REAL upstream artifact:
  assert.equal((real.match(/<system_notification>/g) ?? []).length, 12);
  assert.equal((real.match(/<\/system_notification>/g) ?? []).length, 12);

  const { text, removedCount } = stripSystemNotifications(real);
  assert.equal(removedCount, 12);
  assert.ok(!text.includes("<system_notification>"));
  assert.ok(!text.includes("</system_notification>"));

  // The real report starts immediately at "## What I changed".
  assert.ok(
    text.startsWith("## What I changed"),
    `expected cleaned text to start with the report heading, got: ${JSON.stringify(text.slice(0, 80))}`,
  );
  // And we must NOT have eaten the real content: the report is still substantial.
  assert.ok(text.length > 8000, `cleaned text should retain the report, got ${text.length} bytes`);
  assert.ok(text.includes("dashboard_decode.rs"));
});

test("HAZARD C: stripping is a no-op on clean text", () => {
  const clean = "## Report\n\nAll good. `cargo test` passed.\n";
  const { text, removedCount } = stripSystemNotifications(clean);
  assert.equal(removedCount, 0);
  assert.equal(text, clean.trimStart());
});

test("HAZARD C: an unmatched OPEN tag is left alone (does not swallow the document)", () => {
  const text = "<system_notification>\nno closing tag here\n\n## Real Report\n\ncontent\n";
  const { text: out, removedCount } = stripSystemNotifications(text);
  assert.equal(removedCount, 0);
  assert.ok(out.includes("## Real Report"));
});

test("HAZARD C: reader de-pollutes result.md and flags it", async () => {
  const root = await stageFixture("agy-polluted");
  try {
    const reader = new AgyStaffReader();
    const raw = await reader.read(root, "implement-musm82da-f1dc1fe4");
    assert.ok(raw);
    assert.equal(raw.payload[AGY_PAYLOAD.notificationsStripped], 12);

    const job = normalize(raw);
    assert.ok(job.warnings.some((w) => w.code === "polluted_result"));
    // Output survives and is clean.
    assert.ok(job.output);
    assert.ok(!job.output.includes("<system_notification>"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── THE HEADLINE RULE: empty + warnings is NOT clean success ─────────────────

test("normalize: done + warnings:true + EMPTY output is failed, not clean success", async () => {
  const root = await stageFixture("agy-empty-warned");
  try {
    const reader = new AgyStaffReader();
    const raw = await reader.read(root, "implement-empty1-cccccccc");
    assert.ok(raw);
    assert.equal(raw.payload[AGY_PAYLOAD.status], "done");
    assert.equal(raw.payload[AGY_PAYLOAD.statusWarnings], true);

    const job = normalize(raw);
    // The single most important assertion in this file.
    assert.notEqual(job.status, "succeeded");
    assert.equal(job.status, "failed");
    const codes = job.warnings.map((w) => w.code);
    assert.ok(codes.includes("suspicious_success"), `expected suspicious_success, got ${codes}`);
    assert.ok(codes.includes("empty_output"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── running / unknown ────────────────────────────────────────────────────────

test("running job with progress but no status.json normalizes to running", async () => {
  const root = await stageFixture("agy-running");
  try {
    const reader = new AgyStaffReader();
    const raw = await reader.read(root, "implement-run01-bbbbbbbb");
    assert.ok(raw);
    assert.equal(raw.payload[AGY_PAYLOAD.hasProgressFile], true);
    assert.equal(raw.payload[AGY_PAYLOAD.status], null);
    assert.equal(raw.partial, true);

    const job = normalize(raw);
    assert.equal(job.status, "running");
    assert.ok(job.updatedAt, "last_event_at should surface as updatedAt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── telemetry parser ─────────────────────────────────────────────────────────

test("parseLogTelemetry parses the real telemetry line and flags AGY_ERROR", () => {
  const good = parseLogTelemetry(
    "[agy-staff] mode=implement profile=unrestricted model=gemini-3.8-flash-high " +
      "agy_status=SUCCESS agy_exit=0 duration=1681.549339s turns=1 " +
      "tokens(in 2221077, out 137616, think 88239, cache 20425839)",
  );
  assert.equal(good["agy_status"], "SUCCESS");
  assert.equal(good["agy_exit"], 0);
  assert.equal(good["duration_ms"], 1681549);
  assert.equal(good["turns"], 1);
  assert.equal(good["tokens_cache"], 20425839);

  const bad = parseLogTelemetry(
    "[agy-staff] worker started x pid=1\nerror: There was a network issue\n" +
      'AGY_ERROR: {"status":"UNKNOWN","error_code":2,"retryable":true}',
  );
  assert.equal(bad["saw_agy_error"], true);
  assert.equal(bad["agy_error_reason"], "There was a network issue");
});

// ── discover robustness ──────────────────────────────────────────────────────

test("discover on an unknown cwd returns [] and does not throw", async () => {
  const reader = new AgyStaffReader();
  assert.deepEqual(await reader.discover("/definitely/not/a/repo"), []);
});

test("discover tolerates a directory containing non-spec files", async () => {
  const root = await stageFixture("agy-clean-success");
  try {
    // Drop a stray file in; it must be ignored rather than become a job id.
    await cp(
      path.join(FIX, "agy-polluted", "implement-musm82da-f1dc1fe4.result.md"),
      path.join(root, ".agy-staff/jobs/stray-file.md"),
    );
    const ids = await new AgyStaffReader().discover(root);
    assert.deepEqual(ids, ["implement-clean01-aaaaaaaa"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});