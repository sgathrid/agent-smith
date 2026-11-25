import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeAtomic } from './atomic.ts';
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
    } catch {}
  }
  return out;
}

function readCount(repo: string, jobId: string, name: string): number {
  try {
    const n = Number.parseInt(readFileSync(jobFile(repo, jobId, name), 'utf8').trim(), 10);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function readConsumedCount(repo: string, jobId: string): number {
  return readCount(repo, jobId, FILES.steerConsumed);
}

export function writeConsumedCount(repo: string, jobId: string, n: number): void {
  writeAtomic(jobFile(repo, jobId, FILES.steerConsumed), `${n}\n`);
}

export function readDiscardCut(repo: string, jobId: string): number {
  return readCount(repo, jobId, FILES.steerDiscard);
}

export function writeDiscardCut(repo: string, jobId: string, n: number): void {
  writeAtomic(jobFile(repo, jobId, FILES.steerDiscard), `${n}\n`);
}

export function undeliveredEntries(repo: string, jobId: string): SteerEntry[] {
  const discarded = existsSync(jobFile(repo, jobId, FILES.steerDiscard)) ? readDiscardCut(repo, jobId) : 0;
  return readSteerEntries(repo, jobId).slice(Math.max(readConsumedCount(repo, jobId), discarded));
}

function quoted(entries: readonly SteerEntry[]): string {
  return `"${entries[0]?.prompt.replace(/\s+/g, ' ').trim().slice(0, 80) ?? ''}"`;
}

function messages(n: number): string {
  return `${n} queued message${n === 1 ? '' : 's'}`;
}

export function notSentWarning(entries: readonly SteerEntry[], reason: string): string {
  return `${messages(entries.length)} not sent (${reason}): ${quoted(entries)}`;
}

export function discardedWarning(discarded: readonly SteerEntry[]): string {
  return `${messages(discarded.length)} discarded: ${quoted(discarded)}`;
}

export function liveDeliverable(e: Pick<SteerEntry, 'delivery' | 'overrides' | 'files' | 'context'>): boolean {
  return e.delivery === 'queue'
    && (e.overrides === undefined || Object.keys(e.overrides).length === 0)
    && (e.files === undefined || e.files.length === 0)
    && e.context === undefined;
}

export function liveMessageText(e: Pick<SteerEntry, 'prompt'>): string {
  return e.prompt;
}

export function buildSteeredPrompt(input: {
  wasInterrupted: boolean;
  priorStatus?: string | undefined;
  verdict?: string | undefined;
  freshContinuation?: boolean;
  responseTail: string;
  entries: readonly { readonly prompt: string }[];
  syncedFiles?: readonly string[];
  brief: string;
}): { rawPrompt: string; sentPrompt: string; prependBrief: boolean } {
  const steerBody =
    input.entries.length === 1
      ? input.entries[0]!.prompt
      : input.entries.map((e, idx) => `${idx + 1}. ${e.prompt}`).join('\n\n');
  const baseStatus = input.wasInterrupted
    ? 'Your previous turn was interrupted with updated instructions. Inspect your working tree before repeating any completed steps.'
    : `Your previous turn ${input.priorStatus === undefined || input.priorStatus === 'succeeded' ? 'completed' : `ended ${input.priorStatus}`}.`;
  const statusLine = input.freshContinuation ? `${baseStatus} This starts a fresh conversation.` : baseStatus;
  const parts = [statusLine];
  if (input.syncedFiles !== undefined && input.syncedFiles.length > 0) {
    parts.push(`Synced brief file(s) in your working tree: ${input.syncedFiles.join(', ')} (re-read before continuing).`);
  }
  if (input.verdict) parts.push(input.verdict);
  if (input.freshContinuation && input.responseTail) {
    parts.push(`Last response excerpt from previous turn:\n${input.responseTail}`);
  }
  const header = `${parts.join('\n')}\n\n${steerBody}`;
  const prependBrief = input.brief !== '' && !header.startsWith(input.brief);
  const sentPrompt = prependBrief ? `${input.brief}\n\n${header}` : header;
  return { rawPrompt: header, sentPrompt, prependBrief };
}

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
