/**
 * safe-fs.test.ts — the race-tolerance contract.
 *
 * These are the tests that would catch the #1 flake source: a file vanishing
 * or being half-written between our readdir and our read.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  existsSafe,
  readJsonSafe,
  readTextSafe,
  readdirSafe,
  statSafe,
} from "../safe-fs.ts";

test("readTextSafe returns null for a missing file (does not throw)", async () => {
  assert.equal(await readTextSafe("/definitely/not/here.txt"), null);
});

test("readJsonSafe returns null for missing, empty, and half-written files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "safefs-"));
  try {
    assert.equal(await readJsonSafe(path.join(root, "missing.json")), null);

    const empty = path.join(root, "empty.json");
    await writeFile(empty, "");
    assert.equal(await readJsonSafe(empty), null);

    // The real-world failure: agy-staff writeFile, we read mid-write.
    const half = path.join(root, "half.json");
    await writeFile(half, '{"status":"do');
    assert.equal(await readJsonSafe(half), null);

    const good = path.join(root, "good.json");
    await writeFile(good, '{"status":"done"}');
    assert.deepEqual(await readJsonSafe(good), { status: "done" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readdirSafe returns [] for a missing directory (does not throw)", async () => {
  assert.deepEqual(await readdirSafe("/definitely/not/here"), []);
});

test("readTextSafe on a directory returns null rather than EISDIR", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "safefs-"));
  try {
    assert.equal(await readTextSafe(root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readTextSafe returns null after a file is deleted mid-session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "safefs-"));
  const f = path.join(root, "racy.json");
  try {
    await writeFile(f, '{"a":1}');
    assert.ok(await readTextSafe(f), "readable before delete");
    await rm(f);
    // This is literally hazard A: gone between one read and the next.
    assert.equal(await readTextSafe(f), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existsSafe and statSafe never throw", async () => {
  assert.equal(await existsSafe("/definitely/not/here"), false);
  assert.equal(await statSafe("/definitely/not/here"), null);
});