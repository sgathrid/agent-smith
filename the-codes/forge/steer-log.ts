/**
 * steer-log.ts — the durable record of steers (`steer.jsonl`) and the prompt a
 * continuation turn is built from. Pure over the job directory: the pump in
 * forge/service.ts decides WHEN to chain; this decides what is said.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { FILES, jobDir, jobFile, type SteerEntry } from './format.ts';

export function appendSteerEntry(repo: string, jobId: string, entry: SteerEntry): void {
  const dir = jobDir(repo, jobId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(jobFile(repo, jobId, FILES.steer), `${JSON.stringify(entry)}\n`, 'utf8');
}

export function readSteerEntries(repo: string, jobId: string): SteerEntry[] {
  const file = jobFile(repo, jobId, FILES.steer);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: SteerEntry[] = [];
  const seenIds = new Set<string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<SteerEntry>;
      if (
        typeof parsed.id === 'string' &&
        typeof parsed.createdAt === 'string' &&
        typeof parsed.prompt === 'string' &&
        (parsed.delivery === 'queue' || parsed.delivery === 'interrupt') &&
        !seenIds.has(parsed.id)
      ) {
        seenIds.add(parsed.id);
        out.push(parsed as SteerEntry);
      }
    } catch { /* ignore truncated line */ }
  }
  return out;
}

export function buildSteeredPrompt(input: {
  parentJobId: string;
  wasInterrupted: boolean;
  freshContinuation?: boolean;
  toolCalls: number;
  responseTail: string;
  entries: readonly SteerEntry[];
  syncedFiles?: readonly string[];
  brief: string;
}): { rawPrompt: string; sentPrompt: string; prependBrief: boolean } {
  const steerBody =
    input.entries.length === 1
      ? input.entries[0]!.prompt
      : input.entries.map((e, idx) => `[Steer ${idx + 1} (${e.createdAt})]\n${e.prompt}`).join('\n\n');
  const tag = input.freshContinuation
    ? '[FRESH CONTINUATION]'
    : input.wasInterrupted
      ? '[TURN INTERRUPTED]'
      : `[FOLLOW-UP STEER · ${input.entries.length} queued update${input.entries.length === 1 ? '' : 's'}]`;
  const statusLine = input.wasInterrupted
    ? `Your previous turn (${input.parentJobId}) was interrupted after ${input.toolCalls} tool call(s) with updated instructions from the orchestrator. Inspect your working tree before repeating any completed steps.`
    : `Your previous turn (${input.parentJobId}) completed after ${input.toolCalls} tool call(s), and the orchestrator queued follow-up instructions for you.`;
  const syncedLine =
    input.syncedFiles !== undefined && input.syncedFiles.length > 0
      ? `\nSynced brief file(s) in your working tree: ${input.syncedFiles.join(', ')} (re-read before continuing).`
      : '';
  const tailBlock = input.responseTail
    ? `\nLast response excerpt from previous turn:\n${input.responseTail}\n`
    : '';
  const header = `[STEERED TURN CONTINUITY] ${tag}\n${statusLine}${syncedLine}${tailBlock}\n[ORCHESTRATOR UPDATE]\n${steerBody}`;
  const prependBrief = input.brief !== '' && !header.startsWith(input.brief);
  const sentPrompt = prependBrief ? `${input.brief}\n\n${header}` : header;
  return { rawPrompt: header, sentPrompt, prependBrief };
}

/** The child job id the pump published before stamping `supersededBy`, if any. */
export function readSteerHead(repo: string, jobId: string): string | null {
  try {
    const line = readFileSync(jobFile(repo, jobId, FILES.steerHead), 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s !== '');
    return line ?? null;
  } catch {
    return null;
  }
}
