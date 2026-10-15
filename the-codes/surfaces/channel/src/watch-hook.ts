/**
 * PostToolUse (asyncRewake) hook entrypoint.
 *
 * Reads the hook JSON from stdin; for spawn_job / resume_job / run_pipeline it
 * watches the new job/run in-process until it is terminal, writes the milestone
 * line(s) to stderr and exits 2 so Claude is woken. Anything else, any error:
 * exit 0 silently. A hook must never break the session.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { existsSync, realpathSync } from 'node:fs';
import { claimMarkerPath, parseLaunch, unwrapResponse } from '../../mod/hooks/notice.ts';
import { type JobWatchOptions, runJobWatch } from './monitor.ts';

/** Longest job a spawn may request (forge MAX_TIMEOUT_MS = 6h). */
const MAX_WATCH_JOB_MS = 6 * 60 * 60_000;

export interface WatchTarget {
  readonly kind: 'job' | 'run';
  readonly id: string;
  readonly cwd: string;
  /** Watch budget: the job's own timeout (from the ack) plus a minute; pipelines get the 6h job cap. */
  readonly timeoutMs: number;
}

export { unwrapResponse };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Decide what (if anything) to watch from a parsed hook input. The ack parsing
 * is the mod's (notice.ts parseLaunch), so both announcers agree on what a
 * launch started; only the cwd fallbacks are the hook's own.
 */
export function parseHookInput(input: unknown, env: NodeJS.ProcessEnv = process.env): WatchTarget | null {
  if (!isObj(input)) return null;
  const launch = parseLaunch(input['tool_name'], input['tool_response']);
  if (launch === null) return null;
  let cwd = launch.repo;
  if (cwd === null && typeof input['cwd'] === 'string' && input['cwd'].length > 0) cwd = input['cwd'];
  if (cwd === null) cwd = env['AGY_WATCH_CWD'] || process.cwd();
  const timeoutMs = (launch.timeoutMs ?? MAX_WATCH_JOB_MS) + 60_000;
  return { kind: launch.kind, id: launch.id, cwd: path.resolve(cwd), timeoutMs };
}

/** Run the hook. Resolves to the process exit code (2 = wake Claude). */
export async function runHook(
  stdin: string,
  write: (line: string) => void,
  options: Partial<JobWatchOptions> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    const target = parseHookInput(JSON.parse(stdin) as unknown, env);
    if (target === null) return 0;
    const lines: string[] = [];
    await runJobWatch({
      timeoutMs: target.timeoutMs,
      ...options,
      cwd: target.cwd,
      jobIds: target.kind === 'job' ? [target.id] : [],
      runIds: target.kind === 'run' ? [target.id] : [],
      onError: () => {},
      // The notice as written, line breaks kept; the timeout line has no batch.
      emit: (line, batch) => { lines.push(batch?.content ?? line); },
    });
    if (lines.length === 0) return 0;
    // The mod claimed this launch and announces it; a second notice would repeat it.
    if (claimed(target.cwd, target.kind, target.id)) return 0;
    // Exit 2 is the wake protocol, and the host labels it "Stop hook feedback".
    // This path runs only without the mod (which claims the job and announces it
    // itself), so say plainly that it is a notice, not an error.
    write(lines.join('\n') + '\n(notice, not an error)\n');
    return 2;
  } catch {
    return 0;
  }
}

/**
 * The mod writes the marker under the repo path it was configured with; the
 * ack may spell the same repo differently (a symlinked /tmp, say), so check
 * the canonical path as well.
 */
function claimed(cwd: string, kind: 'job' | 'run', id: string): boolean {
  if (existsSync(claimMarkerPath(cwd, kind, id))) return true;
  try { return existsSync(claimMarkerPath(realpathSync(cwd), kind, id)); } catch { return false; }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

function isEntrypoint(): boolean {
  const invoked = process.argv[1];
  return invoked !== undefined && path.resolve(invoked) === fileURLToPath(import.meta.url);
}

if (isEntrypoint()) {
  try {
    const code = await runHook(await readStdin(), (s) => { process.stderr.write(s); });
    process.exitCode = code;
  } catch {
    process.exitCode = 0;
  }
}
