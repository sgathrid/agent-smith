/**
 * registry.test.ts — fault isolation is the contract here.
 *
 * A reader reads another program's mutable state on another machine. If one
 * reader throws, the others must still contribute — a crashed mod band is a
 * worse outcome than a missing provider row.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  discoverAll,
  getReader,
  providerNames,
  readObservedJob,
} from "../registry.ts";

test("canonical and interoperability readers are registered", () => {
  assert.deepEqual(providerNames(), ["agent-smith", "agy-staff", "claude-code"]);
  assert.equal(getReader("agent-smith")?.provider, "agent-smith");
  assert.equal(getReader("agy-staff")?.provider, "agy-staff");
  assert.equal(getReader("claude-code")?.provider, "claude-code");
});

test("getReader returns undefined for an unknown provider", () => {
  assert.equal(getReader("not-a-provider"), undefined);
});

test("discoverAll never throws and reports every provider", async () => {
  // A cwd neither reader knows about. Both must return empty, not throw.
  const results = await discoverAll("/definitely/not/a/repo");
  assert.equal(results.length, providerNames().length);
  for (const r of results) {
    assert.equal(r.error, undefined);
    assert.deepEqual([...r.jobIds], []);
  }
});

test("readObservedJob returns null for an unknown provider", async () => {
  assert.equal(await readObservedJob("nope", "/tmp", "job"), null);
});

test("readObservedJob returns null (not a throw) for an unknown job", async () => {
  assert.equal(await readObservedJob("agy-staff", "/definitely/not/a/repo", "nope"), null);
});
