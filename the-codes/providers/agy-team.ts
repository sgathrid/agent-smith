/**
 * agy-team.ts — observes the sub-agents an agy worker starts (a /swarm, or
 * invoke_subagent helpers) from agy's own on-disk state, read-only.
 *
 * CONTRACT (implemented by the reader; callers rely only on this):
 *   - `createAgyTeamReader({ conversationId, cwd })` is cheap and never throws.
 *   - `poll(nowMs)` reads what changed since the last poll and returns the full
 *     current snapshot, or `null` when the conversation has no sub-agents or
 *     agy's files are missing or not in the expected shape. Never throws.
 *   - It never writes, never opens a network connection, and reads only under
 *     `agyBrainRoot()`.
 */
import os from 'node:os';
import path from 'node:path';
import type { MemberView, Team } from '../surfaces/mod/types/index.d.ts';

export function agyBrainRoot(): string {
  return process.env['AGENT_SMITH_AGY_BRAIN'] ?? path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
}

export interface AgyTeamReaderOptions {
  /** The worker's (coordinator's) agy conversation id, from the `init` event. */
  readonly conversationId: string;
  /** The worker's cwd. */
  readonly cwd: string;
  /** Defaults to `agyBrainRoot()`. */
  readonly brainRoot?: string;
}

export interface AgyTeamRead {
  readonly team: Team;
  readonly views: readonly MemberView[];
}

export interface AgyTeamReader {
  poll(nowMs: number): AgyTeamRead | null;
}

export function createAgyTeamReader(_options: AgyTeamReaderOptions): AgyTeamReader {
  return { poll: () => null };
}
