/** A dropped queued steer is its own warning code, not a generic tool_error. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { SMITH_PAYLOAD } from "../agent-smith.ts";
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
