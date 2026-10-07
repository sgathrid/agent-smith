# `agy-watch` — the channel

A **Claude Code channel** (MCP server) that pushes agy-staff job state changes into
Claude's context, so Claude reacts to a finished or failed job **without being
asked**.

This is **Surface 2** of two. The [mod](../mod/README.md) reaches your eyes for
zero tokens; this reaches Claude's cognition for ~50 tokens per event. A mod can
draw while you watch but cannot wake Claude. A channel can wake Claude but cannot
draw and costs tokens per event. Neither replaces the other.

---

> ### ⚠ Research preview
>
> This only runs when you pass **`--channels`** to Claude Code, and it should stay
> that way until the four-event vocabulary below has been run against real long
> sessions long enough to trust. The dedupe logic is tested and the failure mode is
> silence rather than noise, but "Claude woke up at the right moment" has not been
> validated by anyone but its author.

---

## Install

```sh
cd the-codes/surfaces/channel
npm install          # @modelcontextprotocol/sdk — the ONE justified dependency
npm run build        # → dist/server.js
```

Register it as an MCP server:

```json
{
  "mcpServers": {
    "agy-watch": {
      "command": "node",
      "args": ["/abs/path/to/the-codes/surfaces/channel/dist/server.js"],
      "env": { "AGY_WATCH_CWD": "/abs/path/to/your/repo" }
    }
  }
}
```

Then launch Claude Code with `--channels`.

The channel watches `AGY_WATCH_CWD` (or `process.argv[2]`, or `process.cwd()`), and
expects `<repo>/.agy-staff/jobs/`. A repo that has never run agy-staff yields zero
jobs and the channel stays silent forever — which is correct, not broken.

### The only dependency

`@modelcontextprotocol/sdk`. This is the one place in the repo where a real
dependency is justified, because this **is** the protocol. The mod stays
dependency-free: a terminal surface should not drag a library into the user's
session.

---

## The design rule

```
PUSH STATE CHANGES ONLY. NEVER PROGRESS TICKS.
```

The mod already shows progress, for free, every second, to a human. A channel
cannot draw and a human cannot read Claude's context. So this surface's only job is
the one thing the mod cannot do: wake Claude when something **changed** that Claude
would otherwise not notice.

**Four pushable events. That is the entire vocabulary.**

| Event | Fires when |
|---|---|
| `finished` | the job reached a terminal success |
| `failed` | it failed, or reported a suspicious success |
| `attention` | it went silent past the 15-minute grace period |
| `cancelled` | a human stopped it |

**Not pushable, and the reasoning matters:**

| | Why not |
|---|---|
| `running` | this is a progress tick. It is the definition of the thing we forbid. |
| `unknown` | "something happened and I don't know what" costs tokens and buys nothing. |

If you push every poll, you have built the wrong thing. The tests enforce this
directly: *60 polls of a running job produce zero notifications*, and *a 28-minute
job produces one*.

### What it looks like

```
agy job implement-musm82da-f1dc1fe4 failed after 28m with warnings. It may have
claimed otherwise — /agy-radar to inspect.

agy job implement-musm82da-f1dc1fe4 finished after 28m with warnings. /agy-radar to inspect.

agy job implement-musm82da has stopped making progress. It may be stuck — /agy-radar to inspect.
```

And when five fail on the same tick, **one line**, not five:

```
agy: 5 failed (implement-musm82da-00000001, …, implement-musm82da-00000005). /agy-radar to inspect.
```

---

## How dedupe works

Two layers. `policy.ts` holds no state and is pure; `poller.ts` holds the memory.

### 1. The key — `dedupeKey(job)` → `` `${id}#${status}#${epoch}` ``

Identity **plus the specific state we announced**.

- *Why the status is in the key:* a job that fails and is re-run to success is **two
  distinct facts**. Keying on the id alone would swallow the recovery and leave
  Claude believing a failed job is still failed.
- *Why `finished_at` is **not** in the key:* it is the natural instinct and it is
  wrong. agy-staff rewrites `status.json` on some cleanup paths, so a timestamp is not
  stable — keying on it turns a re-read into a fake "new" event.

### 2. Four gates — `shouldPush(candidate, now)`

| Gate | Kills |
|---|---|
| state must be pushable | progress ticks, `unknown` |
| key must be new | a re-read of the same terminal state |
| **terminal needs a `finishedAt`** | the mid-flight flap (below) |
| **attention must be a transition** | a backlog of already-stalled jobs |

**Gate 3, and why it is not paranoia.** agy-staff deletes `progress.json` on a clean
finish (hazard A), and there is a real window where the terminal file is being
written while we read it. A reader sampling that window sees a finished job as
`running`, then `succeeded` again. Without gate 3 that flaps as push → silence →
push. With it, a push requires a `finished_at` that exists.

**Gate 4.** A channel that starts against a directory of stalled jobs says nothing
about them: it did not *observe* them stall, so it has a backlog, not news.
Announcing the backlog would make the channel's first impression a wall of alarm.

### 3. The baseline — the first poll sends nothing

Whatever is on disk at startup happened **before the channel existed**. The first
poll records every current pushable state as already-seen and returns. Starting in a
repo with a history of finished jobs opens with zero notifications instead of twenty.

### 4. Batching — N events become at most **one** notification

Grouped **by kind**, not by job: "three finished, one failed" is a different piece of
news from "four failed", and Claude's useful next action differs. Several successes
is usually "carry on"; several failures is usually "stop and look". Collapsing them
into one undifferentiated list throws that away.

Failures are **named** even in a batch — "4 failed" does not tell Claude which four,
and naming them is what lets it act without the user retyping a job id.

### 5. Record after, not before

Keys are recorded only **after** `send` resolves. A lost notification is worse than a
repeated one, because nobody notices the loss. Tested.

---

## The `meta` contract

`meta` keys must match `[A-Za-z0-9_]`. Real agy job ids contain **hyphens**
(`implement-musm82da-f1dc1fe4`), so they are illegal there — and a malformed `meta`
makes the notification **silently undeliverable**, consuming the state transition
without Claude ever hearing about it.

`assertMetaSafe()` runs before every send and throws rather than send a bad one.

```ts
content: 'agy job implement-musm82da-f1dc1fe4 failed after 28m …'   // real ids, hyphens
meta:    { kind: 'failed', count: '1', jobs: 'implement_musm82da_f1dc1fe4' }  // sanitised
```

Only `meta` is sanitised. The prose keeps real ids, because a person and a model both
read it and neither cares about a hyphen. Sanitisation is lossy and deliberately so
— `a-b` and `a_b` collide. `meta` is for coarse filtering; `content` carries the
exact text.

---

## The contract with Claude Code

```ts
const mcp = new Server(
  { name: 'agy-watch', version: '0.1.0' },
  {
    capabilities: { experimental: { 'claude/channel': {} } },   // REQUIRED key
    instructions: 'Events arrive as <channel source="agy-watch" …>',
  },
);
await mcp.connect(new StdioServerTransport());

await mcp.notification({
  method: 'notifications/claude/channel',
  params: { content: 'human readable text', meta: { job: 'musm82da', status: 'failed' } },
});
```

The `experimental['claude/channel']` capability is **required**. Without it Claude
Code does not surface the channel and every notification is discarded **with no error
anywhere**. We assert it by construction (`CAPABILITIES`) because the failure mode is
silence, which is the hardest kind to debug.

**What we cannot assert:** that Claude Code recognises the capability. Only Claude
Code can. If events do not arrive, run with `--channels` and confirm the server is
listed — that is the only signal available.

### The protocol

The server exposes **no tools**. The entire interface is the capability plus
`notifications/claude/channel`. A channel that also defined tools would be a second
way to do the same job, and the user would have to remember which to reach for.

`instructions` is under 40 words because it is spent from the user's context on every
session. It has to do three things: say where events come from, say they are
*changes* and not progress, and say to act unprompted.

### stdout is the protocol channel

Errors go to **stderr**. Writing a log line to stdout corrupts the JSON-RPC stream,
and the symptom is a channel that mysteriously stops working.

---

## Timing

| | Value | Why |
|---|---|---|
| Poll | **5 s** | See below. |
| Chaining | `setTimeout`, not `setInterval` | Overlap is structurally impossible. |

**Why 5 s and not the mod's 3 s:** the mod redraws, so a 3 s poll costs nothing —
nobody reads between frames. This surface spends **tokens**. Polling faster cannot
make a change visible before agy-staff writes it (it republishes every 100 ms), and
it makes us more likely to sample and re-evaluate an intermediate state. 5 s is the
correct number, not a compromise.

**Why not `setInterval`:** an async callback in `setInterval` overlaps with itself
whenever a read outlasts the interval, and with 20 jobs and a 500 KB `events.jsonl`
a slow read is not hypothetical. Overlapping polls would double every read and could
push the same event twice from two interleaved ticks.

One bad poll is caught, logged to stderr, and the loop reschedules. It never takes the
server down — a crash would make the channel vanish from Claude Code with no
explanation.

---

## The three hazards

Handled by **delegating to `harness/`**, exactly as the mod does. `watch-source.ts`
imports `AgyStaffReader`, `normalize` and `stripSystemNotifications`, so it inherits:

| | Hazard | Handling |
|---|---|---|
| **A** | `progress.json` deleted on clean success | Terminal state anchored on `result.md.status.json`. Progress is never consulted for a terminal verdict. |
| **B** | `.spec.json.cancel` marker | `normalize()` folds it in ahead of `status.json`. |
| **C** | polluted `result.md` | Stripped by the reader before we see the text. |

**`server.ts` contains no status rules at all.** That is the point: there is exactly
one implementation of "what state is this job in", it is in `harness/`, and neither
surface has a private copy that could disagree.

Verified against all 20 real jobs:

```
succeeded 16 · failed 2 · canceled 2
both cancellations detected via their real .spec.json.cancel markers
```

---

## Coupling

| Import | From | Why |
|---|---|---|
| `AgyStaffReader`, `normalize`, `stripSystemNotifications` | `harness/` | Hazard handling and the "empty output + warnings ⇒ failed" rule. |
| `existsSafe` | `harness/safe-fs.ts` | Race-tolerant I/O. |
| `STALL_GRACE_MS` | `mod/hooks/stale.ts` | **Cross-surface, deliberately.** |

That last one is a cross-package import into the mod, which looks odd and is
intentional: the mod ships as a **standalone plugin directory** and cannot reach
outside itself, so it has to own any constant the channel also needs. One owner, two
importers, no drift. The pane and the channel cannot disagree about when a job
counts as stalled — if they did, the band would say "fine" while Claude was told the
job was stuck.

The value is 15 minutes, matching `core/liveness.ts`'s `DEFAULT_GRACE_MS`. Defensible
because agy-staff's own default timeout is 60m (`"timeout": "60m"` in every real
`spec.json`), so 15m of silence is a quarter of the budget gone — while still leaving
room for one genuinely long `cargo test --workspace` on a cold target dir.

### We do not use `core/store.ts`

The store is a SQLite projection built for history and querying. This surface needs a
live read of files another process is actively rewriting. Going through the store
would make a **token-spending, hard-to-debug surface** depend on a write path it has
no business owning. When `core/store.ts` gains a live-watch mode, this is the first
call site to migrate — the policy layer would not change at all, because it already
consumes a five-field `WatchableJob` and cannot see the provider payload.

---

## Cost

| | Tokens |
|---|---|
| Normal operation (most 5 s ticks) | **0** |
| One job finishing | ~50 |
| Five jobs failing at once | ~80 (one line, five names) |

The `WatchableJob` the policy sees has five fields. The policy **cannot** read the
provider payload, so it cannot accidentally start depending on provider detail, and a
reader change cannot silently alter what gets pushed into someone's context.

---

## Tests

```sh
cd the-codes/surfaces/channel
npm test          # 35 tests
```

`policy.test.ts` proves each rule in isolation. `poller.test.ts` proves they hold
**across polls**, which is where the real money is — the channel's cost is a property
of the loop, not of any single decision. `read` is injected, so the poller is driven
by a scripted timeline with no transport, no filesystem, and no mocking library.

The load-bearing ones:

- 60 polls of a running job → **0** notifications
- a 28-minute job (336 polls) → **1** notification
- 5 simultaneous failures → **1** notification
- a failed send is **retried**, not swallowed
- a first poll over 10 finished jobs → **0** notifications
- a read that throws → one tick of silence, and the channel recovers

---

## Known limitations

- **Research preview.** Only runs with `--channels`, and only one author has used it.
- **Unbounded dedupe memory.** `announced` never evicts. A day of work is tens of
  jobs, and pruning would open a window where a long session re-announces something
  the user already saw. If this ever becomes a long-lived daemon, the fix is LRU over
  a session-scoped map, not a TTL.
- **agy-staff only.** `toWatchStatus` maps agy's statuses; Codex and OpenCode would
  need their own mapping in `watch-source.ts`. The policy is unchanged — that is why
  `WatchStatus` is a closed union, asserted by a test.
- **No duration when timestamps are <60 s apart.** `last_event_at` is the last
  *event*, not the start, so for a fast job the difference is a few seconds. We say
  nothing rather than "after 0m".
- **We cannot verify Claude Code recognises the capability.** See above.