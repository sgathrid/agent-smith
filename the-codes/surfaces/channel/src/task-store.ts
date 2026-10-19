/** Durable MCP Tasks metadata linked to Forge's authoritative job lifecycle. */
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export type TaskStatus = 'working' | 'completed' | 'failed' | 'cancelled';
export interface TaskError { readonly code: number; readonly message: string }
export interface TaskRecord {
  readonly taskId: string;
  readonly jobId?: string;
  readonly requestFingerprint?: string;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly expiresAt: string;
  readonly cancellationRequestedAt?: string;
  readonly status: TaskStatus;
  readonly result?: unknown;
  readonly error?: TaskError;
}
export interface TaskStoreOptions {
  readonly ttlMs?: number;
  readonly maxRecords?: number;
  readonly now?: () => number;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TERMINAL = new Set<TaskStatus>(['completed', 'failed', 'cancelled']);
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 1000;

/**
 * Small file store for protocol identity and frozen result snapshots. Forge
 * remains the source of truth for execution and job status.
 */
export class TaskStore {
  private readonly directory: string;
  private readonly ttlMs: number;
  private readonly maxRecords: number;
  private readonly now: () => number;

  constructor(directory: string, options: TaskStoreOptions = {}) {
    this.directory = directory;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) throw new RangeError('ttlMs must be positive');
    if (!Number.isInteger(this.maxRecords) || this.maxRecords < 1) throw new RangeError('maxRecords must be a positive integer');
  }

  /** Atomically reserve a task ID before execution can be launched. */
  create(input: { taskId: string; jobId?: string; requestFingerprint?: string }): TaskRecord {
    const taskId = this.requireId(input.taskId);
    const jobId = input.jobId === undefined ? undefined : this.requireId(input.jobId);
    this.cleanup();
    if (this.countRecords() >= this.maxRecords) throw new Error('Task store capacity reached');
    const now = this.now();
    const stamp = new Date(now).toISOString();
    const record: TaskRecord = {
      taskId,
      ...(jobId === undefined ? {} : { jobId }),
      ...(input.requestFingerprint === undefined ? {} : { requestFingerprint: input.requestFingerprint }),
      createdAt: stamp,
      lastUpdatedAt: stamp,
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      status: 'working',
    };
    mkdirSync(this.directory, { recursive: true });
    const target = this.file(taskId);
    const temp = `${target}.tmp-${process.pid}-${this.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
      // link is an atomic no-overwrite publication on the same filesystem.
      linkSync(temp, target);
      return record;
    } finally {
      try { unlinkSync(temp); } catch { /* already removed or create failed */ }
    }
  }

  get(taskId: string): TaskRecord | undefined {
    const id = this.requireId(taskId);
    const file = this.file(id);
    if (!existsSync(file)) return undefined;
    const record = this.read(file, id);
    if (Date.parse(record.expiresAt) <= this.now()) {
      this.remove(id);
      return undefined;
    }
    const terminalFile = this.terminalFile(id);
    return existsSync(terminalFile) ? this.read(terminalFile, id) : record;
  }

  bindJob(taskId: string, jobId: string): TaskRecord {
    const record = this.requireWorking(taskId);
    const id = this.requireId(jobId);
    if (record.jobId !== undefined && record.jobId !== id) throw new Error(`Task ${taskId} is already bound to a job`);
    if (record.jobId === id) return record;
    return this.write({ ...record, jobId: id, lastUpdatedAt: this.stamp() });
  }

  /** Store cancellation intent; terminal outcome still comes from the worker. */
  requestCancel(taskId: string): TaskRecord {
    const record = this.get(taskId);
    if (!record) throw new Error(`Unknown task: ${taskId}`);
    if (TERMINAL.has(record.status) || record.cancellationRequestedAt) return record;
    const at = this.stamp();
    return this.write({ ...record, cancellationRequestedAt: at, lastUpdatedAt: at });
  }

  complete(taskId: string, result: unknown): TaskRecord {
    return this.finish(taskId, { status: 'completed', result });
  }

  fail(taskId: string, error: TaskError): TaskRecord {
    if (!Number.isInteger(error.code) || typeof error.message !== 'string') throw new TypeError('Task error must have a numeric code and string message');
    return this.finish(taskId, { status: 'failed', error: { code: error.code, message: error.message } });
  }

  cancel(taskId: string, result?: unknown): TaskRecord {
    return this.finish(taskId, { status: 'cancelled', ...(result === undefined ? {} : { result }) });
  }

  private finish(taskId: string, terminal: Pick<TaskRecord, 'status'> & Partial<Pick<TaskRecord, 'result' | 'error'>>): TaskRecord {
    const record = this.get(taskId);
    if (!record) throw new Error(`Unknown task: ${taskId}`);
    if (TERMINAL.has(record.status)) return record;
    const body = `${JSON.stringify({ ...record, ...terminal, lastUpdatedAt: this.stamp() }, null, 2)}\n`;
    const frozen = JSON.parse(body) as TaskRecord;
    const file = this.terminalFile(record.taskId);
    const temp = `${file}.tmp-${process.pid}-${this.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      writeFileSync(temp, body, { flag: 'wx' });
      try { linkSync(temp, file); } catch (error) {
        if (existsSync(file)) return this.read(file, record.taskId);
        throw error;
      }
      renameSync(temp, this.file(record.taskId));
      return frozen;
    } finally {
      try { unlinkSync(temp); } catch { /* already removed or publication failed */ }
    }
  }

  private requireWorking(taskId: string): TaskRecord {
    const record = this.get(taskId);
    if (!record) throw new Error(`Unknown task: ${taskId}`);
    if (record.status !== 'working') throw new Error(`Task ${taskId} is already terminal`);
    return record;
  }

  private write(record: TaskRecord): TaskRecord {
    const file = this.file(record.taskId);
    const terminal = this.terminalFile(record.taskId);
    const temp = `${file}.tmp-${process.pid}-${this.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
      if (existsSync(terminal)) return this.read(terminal, record.taskId);
      renameSync(temp, file);
      return existsSync(terminal) ? this.read(terminal, record.taskId) : record;
    } finally {
      try { unlinkSync(temp); } catch { /* rename may have consumed it */ }
    }
  }

  private cleanup(): void {
    mkdirSync(this.directory, { recursive: true });
    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!ID.test(id)) continue;
      const file = this.file(id);
      try {
        const record = this.read(file, id);
        if (Date.parse(record.expiresAt) <= this.now()) this.remove(id);
      } catch { /* ignore corrupt or concurrently removed records */ }
    }
  }

  private countRecords(): number {
    return readdirSync(this.directory).filter((name) => name.endsWith('.json') && !name.endsWith('.terminal.json')).length;
  }

  private remove(id: string): void {
    for (const file of [this.file(id), this.terminalFile(id)]) {
      try { unlinkSync(file); } catch { /* concurrent cleanup */ }
    }
  }

  private read(file: string, taskId: string): TaskRecord {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object') throw new Error('Invalid task record');
    const record = value as TaskRecord;
    if (record.taskId !== taskId || !['working', 'completed', 'failed', 'cancelled'].includes(record.status) ||
        !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.lastUpdatedAt)) ||
        !Number.isFinite(Date.parse(record.expiresAt)) ||
        (record.jobId !== undefined && (typeof record.jobId !== 'string' || !ID.test(record.jobId))) ||
        (record.requestFingerprint !== undefined && typeof record.requestFingerprint !== 'string') ||
        (record.cancellationRequestedAt !== undefined && !Number.isFinite(Date.parse(record.cancellationRequestedAt))) ||
        (record.error !== undefined && (!record.error || !Number.isInteger(record.error.code) || typeof record.error.message !== 'string')) ||
        (record.status === 'failed' && record.error === undefined) ||
        (record.status === 'completed' && record.result === undefined)) throw new Error('Invalid task record');
    return record;
  }

  private requireId(value: string): string {
    if (typeof value !== 'string' || !ID.test(value)) throw new TypeError('Task and job IDs may contain only letters, digits, underscore, and hyphen');
    return value;
  }
  private file(id: string): string { return path.join(this.directory, `${id}.json`); }
  private terminalFile(id: string): string { return path.join(this.directory, `${id}.terminal`); }
  private stamp(): string { return new Date(this.now()).toISOString(); }
}
