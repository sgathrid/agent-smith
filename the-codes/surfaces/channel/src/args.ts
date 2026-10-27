/** Argument parsing for tool calls: each helper validates one field and throws the message Claude sees. */
import path from 'node:path';
import { statSync } from 'node:fs';
import { inheritContinuedProviders } from '../../../pipeline/pipeline.ts';
import { EFFORTS, validateEnv, type Effort, type Stage, type StageCheck } from '../../../pipeline/types.ts';
import { FORMATS, MAX_CONTEXT_CHARS, PROVIDERS, stageSchema } from './tool-defs.ts';
import type { ResponseFormat } from './views.ts';

export function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
const REQUIRED_HINTS: Readonly<Record<string, string>> = { jobId: 'get one from spawn_job or list_jobs', runId: 'use the runId returned by run_pipeline', worker: 'a worker name or job ID from list_jobs', delivery: 'choose "queue" (after current turn) or "interrupt" (stop current turn now)' };
export function text(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const v = args[key];
  if (v === undefined && !required) return undefined;
  if (v === undefined) throw new Error(`${key} is required${REQUIRED_HINTS[key] ? `: ${REQUIRED_HINTS[key]}` : ''}.`);
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${key} must be a nonempty string.`);
  return v;
}
export function contextText(args: Record<string, unknown>): string | undefined {
  const v = text(args, 'context');
  if (v !== undefined && v.length > MAX_CONTEXT_CHARS) throw new Error(`context must be at most ${MAX_CONTEXT_CHARS} characters.`);
  return v;
}
export function filesList(args: Record<string, unknown>): string[] | undefined {
  const v = args.files;
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some(f => typeof f !== 'string' || !f.trim())) throw new Error('files must be an array of nonempty relative file paths.');
  return v as string[];
}
export function workingDirectory(args: Record<string, unknown>): string | undefined {
  const cwd = text(args, 'cwd');
  if (cwd === undefined) return undefined;
  if (!path.isAbsolute(cwd)) throw new Error(`cwd must be an absolute path (got "${cwd}").`);
  try {
    if (statSync(cwd).isDirectory()) return cwd;
  } catch { /* report the same validation error for absent/inaccessible paths */ }
  throw new Error(`cwd "${cwd}" is not a directory.`);
}
export function number(args: Record<string, unknown>, key: string, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const v = args[key]; if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > max) throw new Error(`${key} must be an integer from 1 to ${max}.`);
  return v;
}
export function boolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key]; if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new Error(`${key} must be a boolean.`);
  return v;
}
export function allowed(args: Record<string, unknown>, key: string, values: readonly string[]): string | undefined {
  const v = text(args, key); if (v !== undefined && !values.includes(v)) throw new Error(`${key} must be one of ${values.join(', ')}.`); return v;
}
export function format(args: Record<string, unknown>): ResponseFormat { return (allowed(args, 'response_format', FORMATS) ?? 'concise') as ResponseFormat; }
export function keys(args: Record<string, unknown>, known: readonly string[]): void {
  for (const key of Object.keys(args)) if (!known.includes(key)) throw new Error(`Unknown field ${key}; valid fields: ${known.join(', ')}.`);
}
export function parseChecks(raw: unknown): StageCheck[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error('checks must be an array.');
  return raw.map(v => { const c = record(v, 'check'); keys(c, ['name', 'command', 'cwd', 'timeoutMs', 'blocking']); return { name: text(c, 'name', true)!, command: text(c, 'command', true)!, cwd: text(c, 'cwd'), timeoutMs: number(c, 'timeoutMs'), blocking: boolean(c, 'blocking') }; });
}
export function parseStages(raw: unknown): Stage[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('stages must be a nonempty array.');
  return inheritContinuedProviders(raw.map((v, i) => {
    const s = record(v, `stages[${i}]`); keys(s, Object.keys(stageSchema.properties));
    let dependsOn: string[] | undefined;
    if (s.dependsOn !== undefined) {
      if (!Array.isArray(s.dependsOn) || s.dependsOn.some(d => typeof d !== 'string' || !d.trim())) throw new Error('dependsOn must contain stage names.');
      dependsOn = s.dependsOn as string[];
    }
    let consumes: Stage['consumes'];
    if (s.consumes !== undefined) {
      if (!Array.isArray(s.consumes)) throw new Error('consumes must be an array.');
      consumes = s.consumes.map(v => { const a = record(v, 'artifact'); keys(a, ['stage', 'path', 'label']); return { stage: text(a, 'stage', true)!, path: text(a, 'path', true)!, label: text(a, 'label') }; });
    }
    return { name: text(s, 'name', true)!, agentName: text(s, 'agentName'), workerId: text(s, 'workerId'), conversation: text(s, 'conversation'), continues: text(s, 'continues'), provider: allowed(s, 'provider', PROVIDERS), model: text(s, 'model'), effort: allowed(s, 'effort', EFFORTS) as Effort | undefined, prompt: text(s, 'prompt'), context: contextText(s), title: text(s, 'title'), role: text(s, 'role'), dependsOn, consumes, workDir: text(s, 'workDir'), resultPath: text(s, 'resultPath'), timeoutMs: number(s, 'timeoutMs'), routingPinned: boolean(s, 'routingPinned'), checks: parseChecks(s.checks), env: validateEnv(s.env, 'env') };
  }));
}
