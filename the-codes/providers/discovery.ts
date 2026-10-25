/**
 * providers/discovery.ts — shared plumbing for lazy `listModels()` implementations.
 * Never called at startup; every helper here is I/O on demand and never throws.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;

export interface RunResult {
  stdout: string;
  error?: string;
}

/** Runs `bin args` capturing stdout. Resolves (never rejects); failures land in `error`. */
export type RunFn = (bin: string, args: string[], timeoutMs: number) => Promise<RunResult>;

export const runCapture: RunFn = (bin, args, timeoutMs) =>
  new Promise((resolve) => {
    try {
      execFile(
        bin,
        args,
        { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: process.env },
        (err, stdout, stderr) => {
          if (err) {
            const killed = (err as { killed?: boolean }).killed === true;
            const detail = killed ? `timed out after ${timeoutMs} ms` : err.message;
            resolve({ stdout: stdout ?? '', error: `${bin} ${args.join(' ')}: ${detail}${stderr ? ` (${String(stderr).trim().slice(0, 200)})` : ''}` });
            return;
          }
          resolve({ stdout: stdout ?? '' });
        },
      );
    } catch (e) {
      resolve({ stdout: '', error: e instanceof Error ? e.message : String(e) });
    }
  });

/** Read a file as text, undefined on any failure. */
export function readTextSafe(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Home-relative config dir: first non-empty env var wins, else ~/<fallback>. */
export function configDir(envNames: readonly string[], fallback: string): string {
  for (const n of envNames) {
    const v = process.env[n];
    if (v !== undefined && v !== '') return v;
  }
  return path.join(process.env['HOME'] ?? os.homedir(), fallback);
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Top-level `key = "value"` pairs of a config.toml (stops at the first [table]). */
export function parseTomlTopLevel(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) break;
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/);
    if (m) out[m[1]!] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}
