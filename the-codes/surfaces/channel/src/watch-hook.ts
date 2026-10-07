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

import { type JobWatchOptions, runJobWatch } from './monitor.ts';

export interface WatchTarget {
  readonly kind: 'job' | 'run';
  readonly id: string;
  readonly cwd: string;
}

const TOOLS: Record<string, 'job' | 'run'> = { spawn_job: 'job', resume_job: 'job', run_pipeline: 'run' };

function toolKind(name: unknown): 'job' | 'run' | null {
  if (typeof name !== 'string') return null;
  const bare = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name;
  return TOOLS[bare] ?? null;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Normalise any MCP result shape to the tool's payload object, or null on error/unparseable. */
export function unwrapResponse(response: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 4) return null;
  if (typeof response === 'string') {
    try { return unwrapResponse(JSON.parse(response) as unknown, depth + 1); } catch { return null; }
  }
  if (Array.isArray(response)) {
    // content array directly
    for (const part of response) {
      if (isObj(part) && typeof part['text'] === 'string') {
        const r = unwrapResponse(part['text'], depth + 1);
        if (r) return r;
      }
    }
    return null;
  }
  if (!isObj(response)) return null;
  if (response['isError'] === true) return null;
  if (isObj(response['structuredContent'])) return response['structuredContent'];
  if (Array.isArray(response['content'])) return unwrapResponse(response['content'], depth + 1);
  return response;
}

/** Decide what (if anything) to watch from a parsed hook input. */
export function parseHookInput(input: unknown, env: NodeJS.ProcessEnv = process.env): WatchTarget | null {
  if (!isObj(input)) return null;
  const kind = toolKind(input['tool_name']);
  if (kind === null) return null;
  const payload = unwrapResponse(input['tool_response']);
  if (payload === null || typeof payload['error'] === 'string') return null;
  const id = kind === 'job' ? payload['jobId'] : payload['runId'];
  if (typeof id !== 'string' || id.length === 0) return null;

  let cwd: string | null = null;
  if (typeof payload['repo'] === 'string' && payload['repo'].length > 0) cwd = payload['repo'];
  else if (kind === 'job' && typeof payload['dir'] === 'string') {
    // .../.agent-smith/jobs/<id>
    const jobs = path.dirname(payload['dir']);
    if (path.basename(jobs) === 'jobs' && path.basename(path.dirname(jobs)) === '.agent-smith') cwd = path.dirname(path.dirname(jobs));
  } else if (kind === 'run' && typeof payload['recordPath'] === 'string') {
    // .../.agent-smith/pipelines/<id>.json
    const dir = path.dirname(payload['recordPath']);
    if (path.basename(dir) === 'pipelines' && path.basename(path.dirname(dir)) === '.agent-smith') cwd = path.dirname(path.dirname(dir));
  }
  if (cwd === null && typeof input['cwd'] === 'string' && input['cwd'].length > 0) cwd = input['cwd'];
  if (cwd === null) cwd = env['AGY_WATCH_CWD'] || process.cwd();
  return { kind, id, cwd: path.resolve(cwd) };
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
      ...options,
      cwd: target.cwd,
      jobIds: target.kind === 'job' ? [target.id] : [],
      runIds: target.kind === 'run' ? [target.id] : [],
      onError: () => {},
      emit: (line) => { lines.push(line); },
    });
    if (lines.length === 0) return 0;
    write(lines.join('\n') + '\n');
    return 2;
  } catch {
    return 0;
  }
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
