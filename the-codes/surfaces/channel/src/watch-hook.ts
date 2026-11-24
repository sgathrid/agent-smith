import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { existsSync, realpathSync } from 'node:fs';
import { readAcceptance } from '../../../forge/checks.ts';
import { claimMarkerPath, parseLaunches, unwrapResponse } from '../../mod/hooks/notice.ts';
import { type JobWatchOptions, runJobWatch } from './monitor.ts';

const MAX_WATCH_JOB_MS = 6 * 60 * 60_000;

export const HOOK_TIMEOUT_MS = 21_900_000;
const WATCH_CAP_MS = HOOK_TIMEOUT_MS - 60_000;
const WATCH_GRACE_MS = 60_000;

export interface WatchTarget {
  readonly kind: 'job' | 'run';
  readonly id: string;
  readonly ids: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}

export { unwrapResponse };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function parseHookInput(input: unknown): WatchTarget | null {
  if (!isObj(input)) return null;
  const rawTool = typeof input['tool_name'] === 'string' ? input['tool_name'] : '';
  const toolName = rawTool.includes('__') ? rawTool.slice(rawTool.lastIndexOf('__') + 2) : rawTool;
  if (toolName === 'follow_up' || toolName === 'steer') {
    const payload = unwrapResponse(input['tool_response']);
    if (!isObj(payload) || payload['action'] !== 'started') return null;
  }
  const launches = parseLaunches(input['tool_name'], input['tool_response']);
  const launch = launches[0];
  if (launch === undefined) return null;
  let cwd = launch.repo;
  if (cwd === null && typeof input['cwd'] === 'string' && input['cwd'].length > 0) cwd = input['cwd'];
  if (cwd === null) cwd = process.cwd();
  const resolved = path.resolve(cwd);
  const timeoutMs = Math.max(...launches.map((l) => {
    const budget = l.kind === 'job' ? pendingBudgetMs(resolved, l.id) : 0;
    return Math.min(WATCH_CAP_MS, (l.timeoutMs ?? MAX_WATCH_JOB_MS) + budget + WATCH_GRACE_MS);
  }));
  return { kind: launch.kind, id: launch.id, ids: launches.map((l) => l.id), cwd: resolved, timeoutMs };
}

function pendingBudgetMs(cwd: string, jobId: string): number {
  try {
    const b = (readAcceptance(cwd, jobId) as { pending?: boolean; budgetMs?: unknown }).budgetMs;
    return typeof b === 'number' && b > 0 ? b : 0;
  } catch { return 0; }
}

export async function runHook(
  stdin: string,
  write: (line: string) => void,
  options: Partial<JobWatchOptions> = {},
): Promise<number> {
  try {
    const target = parseHookInput(JSON.parse(stdin) as unknown);
    if (target === null) return 0;
    const perId = await Promise.all(target.ids.map(async (id) => {
      const lines: string[] = [];
      const emittedIds = new Set<string>();
      await runJobWatch({
        timeoutMs: target.timeoutMs,
        ...options,
        cwd: target.cwd,
        jobIds: target.kind === 'job' ? [id] : [],
        runIds: target.kind === 'run' ? [id] : [],
        onError: () => {},
        announceOnce: true,
        emit: (line, batch) => {
          lines.push(batch?.content ?? line);
          for (const key of batch?.keys ?? []) {
            const hash = key.indexOf('#');
            if (hash > 0) emittedIds.add(key.slice(0, hash));
          }
        },
      });
      return { id, emittedIds, lines };
    }));
    const lines = perId.flatMap(({ id, emittedIds, lines: idLines }) => (
      claimed(target.cwd, target.kind, id) || [...emittedIds].some((eid) => claimed(target.cwd, target.kind, eid))
        ? []
        : idLines
    ));
    if (lines.length === 0) return 0;
    // Exit 2 is the wake protocol, and the host labels it "Stop hook feedback".
    // This path runs only without the mod (which claims the job and announces it
    // itself), so say plainly that it is a notice, not an error.
    write(lines.join('\n') + '\n(notice, not an error)\n');
    return 2;
  } catch {
    return 0;
  }
}

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
