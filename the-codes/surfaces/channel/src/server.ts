/**
 * server.ts — the agy-watch Claude Code channel.
 *
 * A RESEARCH PREVIEW. It runs only when the user passes `--channels` to Claude
 * Code, and it should stay that way until the event vocabulary below has been run
 * against real long sessions long enough to trust. See README.md.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * An MCP server that connects over stdio and then pushes notifications INTO
 * Claude's context without being asked. It exposes NO TOOLS. The entire interface
 * is the `claude/channel` experimental capability plus
 * `notifications/claude/channel` messages.
 *
 * A channel that also defined tools would be a second way to do the same job, and
 * the user would have to remember which one to reach for. The division of labour
 * in this repo is deliberate: the mod reaches the eyes for free, the channel
 * reaches the cognition at ~50 tokens per event, and neither does the other's job.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE RULE, BECAUSE IT IS THE WHOLE DESIGN
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   PUSH CHANGES. NEVER PROGRESS.
 *
 * Every POLL_MS we read job state and ask policy.ts what changed. On most ticks
 * the answer is "nothing", and we send nothing. This channel is silent while work
 * proceeds normally, which is the correct behaviour and the hardest one to get
 * right: a version that pushes every poll looks perfect in a demo with one short
 * job and destroys a real session with a 28-minute one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HAZARDS — HANDLED HERE, NOT IN THIS FILE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The channel shares the mod's hazard handling by construction: watch-source.ts
 * delegates to harness/agy-staff.ts and harness/normalize.ts, so it inherits
 *
 *   A. progress.json deleted on clean success → terminal state is anchored on the
 *      always-written result.md.status.json, and progress is never consulted for
 *      a terminal verdict.
 *   B. the .spec.json.cancel marker → normalize() folds it in ahead of status.json,
 *      so a cancellation mid-flight is seen as a cancellation.
 *   C. a polluted result.md → stripped by the reader before we ever see the text.
 *
 * This file contains no status rules at all. That is the point: there is exactly
 * one implementation of "what state is this job in", and it is not here.
 */

// ── MCP SDK ─────────────────────────────────────────────────────────────────
//
// The ONE place a real dependency is justified in this repo: this IS the protocol.
// The mod above stays dependency-free because a terminal surface should not drag a
// library into the user's session.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { type Batch } from './policy.ts';
import { pollOnce, scheduleLoop } from './poller.ts';

/** The source name Claude sees in the `<channel source="...">` wrapper. */
const SOURCE = 'agy-watch';

/**
 * Poll interval: 5 seconds.
 *
 * WHY NOT 3, WHICH IS WHAT THE MOD USES: the mod redraws, and a 3 s poll costs
 * nothing because nobody reads between frames. This surface spends TOKENS.
 * Polling faster cannot make a change visible before agy-staff writes it — it
 * republishes every 100 ms, so 3 s versus 5 s is noise — while making us more
 * likely to sample and re-evaluate an intermediate state. The slower cadence is
 * the correct number, not a compromise.
 */
const POLL_MS = 5_000;

/**
 * Instructions handed to Claude at session start.
 *
 * This is not documentation for us; it is text spent from the user's context, and
 * it is the reason Claude knows the channel exists at all. Under 40 words. It has
 * to do three things: say where events come from, say they are CHANGES and not
 * progress (so Claude does not treat them as a heartbeat), and say to act
 * unprompted — because "act without being asked" is the entire value proposition.
 */
const INSTRUCTIONS =
  'Events arrive as <channel source="agy-watch" job="..." status="...">. ' +
  'They mark job state CHANGES, never progress. Act on them without being asked: ' +
  'summarize a finished report, investigate a failure, flag a stalled job. ' +
  '/agy-radar shows the detail.';

// ── the server ──────────────────────────────────────────────────────────────

/**
 * The capability declaration.
 *
 * The `experimental['claude/channel']` key is REQUIRED. Without it Claude Code does
 * not surface the channel and every notification we send is discarded with no error
 * anywhere — so it is stated once, as a named constant, rather than inline and
 * buried in a constructor call.
 *
 * Note what this does NOT do: it cannot verify Claude Code recognises the
 * capability. Only Claude Code can, and the only way to find out is to run with
 * `--channels` and confirm an event arrives. See README.md.
 */
const CAPABILITIES = { experimental: { 'claude/channel': {} } } as const;

const mcp = new Server(
  { name: SOURCE, version: '0.1.0' },
  {
    capabilities: CAPABILITIES,
    instructions: INSTRUCTIONS,
  },
);

/** The transport call. The only place in the repo that touches the SDK. */
async function sendBatch(batch: Batch): Promise<void> {
  if (batch.content === null) return;
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: batch.content,
      // `meta` keys are identifier-safe ([A-Za-z0-9_]) and values are strings;
      // policy.assertMetaSafe enforces this before we get here, because a bad meta
      // makes the notification undeliverable AND silent.
      meta: batch.meta,
    },
  });
}

/**
 * Which repo to watch.
 *
 * Resolution order: an explicit argv path, then AGY_WATCH_CWD, then process.cwd().
 * The argv form exists so `claude --channels` can be pointed at another repo
 * without an env var; the env form exists so an MCP config entry can set it once.
 */
function resolveCwd(): string {
  const arg = process.argv[2];
  if (arg !== undefined && arg.length > 0 && !arg.startsWith('--')) return arg;
  const env = process.env['AGY_WATCH_CWD'];
  if (typeof env === 'string' && env.length > 0) return env;
  return process.cwd();
}

const CWD = resolveCwd();

await mcp.connect(new StdioServerTransport());

// Poll only AFTER the transport is live, so no notification is ever written into a
// stream Claude Code is not yet reading. (On stdio that would be a malformed
// frame, not merely a lost message.)
scheduleLoop(CWD, POLL_MS, sendBatch, (err) => {
  process.stderr.write(`agy-watch: ${String(err)}\n`);
});

/**
 * Test seam. `pollOnce` is exercised directly in __tests__/poller.test.ts; this
 * re-export exists so the tests and the server can never disagree about which
 * function is the entry point.
 */
export { pollOnce } from './poller.ts';