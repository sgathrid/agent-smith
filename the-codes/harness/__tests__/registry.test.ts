/**
 * registry.test.ts — fault isolation is the contract here.
 *
 * A reader reads another program's mutable state. If it throws, the caller
 * must get null or an `unknown` job, never an exception.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { readObservedJob } from "../registry.ts";

test("readObservedJob returns null for an unknown provider", async () => {
  assert.equal(await readObservedJob("nope", "/tmp", "job"), null);
});

test("readObservedJob returns null (not a throw) for an unknown job", async () => {
  assert.equal(await readObservedJob("agy-staff", "/definitely/not/a/repo", "nope"), null);
  assert.equal(await readObservedJob("agent-smith", "/definitely/not/a/repo", "nope"), null);
});
