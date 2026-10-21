/**
 * writer.ts — one job, from `spawn()` to the terminal anchor.
 *
 * This is the module that makes the two halves of this repo one system. It takes
 * a `WorkerHandle` from providers/, translates its event stream into OUR state
 * format (format.ts), computes the verdict (format.deriveStatus), writes the
 * anchor, and projects the result into the compat mirror (mirror.ts) so an
 * unmodified mod can draw it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE WRITER, AND NOT THE SURFACE, OWNS THE FILES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Because a job outlives the tool call that started it. `spawn_job` returns a
 * job id in under a millisecond; the job then runs for 28 minutes across an MCP
 * server restart, a session close, and a pane that was never opened. If the
 * surface owned the state, a Claude Code restart would lose every running job.
 *
 * The filesystem is the only thing in this system that survives all three.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WRITE AMOUNT, BECAUSE THIS RUNS 484 TIMES ON A GOOD JOB
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The reference job made 484 tool calls. Naively, that is 484 progress.json
 * rewrites and 484 mirror progress rewrites. Both are invisible — the band polls
 * at 3 s, the channel at 5 s — so we coalesce: at most one progress flush every
 * PROGRESS_FLUSH_MS, with a trailing flush on every terminal transition so the
 * last state is never lost.
 *
 * What is NOT throttled: the terminal writes, the cancel marker, and the
 * append-only event log. Those are the ones a reader is waiting on.
 */

// Shared with the mod, which renders the digest; the mod loader cannot import forge, so it lives there.
import { classify, ProgressTracker } from '../surfaces/mod/hooks/progress.ts';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { appendLine, createMarker, writeAtomic, writeJsonAtomic } from './atomic.ts';
import {
  FILES,
  PROGRESS_FLUSH_MS,
  attributeChanged,
  failureFields,
  diffChangedFiles,
  isForgeStatePath,
  SCHEMA_VERSION,
  deriveStatus,
  jobFile,
  looksEmpty,
  shouldFlush,
  taskTitle,
  type ForgeActivity,
  type GitBaseline,
  type ForgeManifest,
  type ForgeProgress,
  type ForgeStatus,
  type ForgeView,
  type ForgeViewEvent,
  type WatchedFileSigs,
} from './format.ts';
import { MirrorWriter } from './mirror.ts';
import type { JobResult, ProviderEvent, WorkerHandle } from '../providers/types.ts';

/** How many recent activities we keep. Matches the pane's rendering cap. */
const RECENT_ACTIVITIES = 5;

/** How much assistant text we keep as the "reasoning" cell. */
const LATEST_TEXT_CHARS = 4_000;

export interface JobWriterOptions {
  readonly repo: string;
  readonly jobId: string;
  /** Project into the agy-staff-shaped compat mirror. Default true. */
  readonly mirror?: boolean;
  /** Progress coalescing window, ms. Overridable so tests need not sleep. */
  readonly flushMs?: number;
}

export interface StartInput {
  readonly name?: string;
  readonly workerId?: string;
  readonly task?: string;
  readonly provider: string;
  readonly mode: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly cwd: string;
  readonly prompt: string;
  /** The brief the service prepended before the provider saw the prompt (forge/brief.ts). */
  readonly preamble?: string;
  readonly unrestricted: boolean;
  readonly conversation: string | null;
  readonly timeoutMs: number;
  readonly pipeline: string | null;
  readonly stage: string | null;
  readonly attempt: number | null;
  readonly modelRequested?: string | null;
  readonly modelResolved?: string | null;
  readonly modelSource?: 'requested' | 'harness-config' | 'reported' | 'unknown';
  readonly preambleApplied?: boolean;
  readonly sandbox?: string;
  readonly sandboxFlags?: readonly string[];
  readonly readOnlyRequested?: boolean;
  readonly readOnlyEnforced?: boolean;
  readonly steeredFrom?: string | null;
  readonly watchedFiles?: Readonly<Record<string, WatchedFileSigs>>;
}

/**
 * Owns the on-disk state of exactly one job.
 *
 * Not thread-safe and does not need to be: one job has one owner (the coroutine
 * that spawned it), and `forge/service.ts` keeps that ownership in a map.
 */
export class JobWriter {
  readonly jobId: string;
  private readonly repo: string;
  private readonly flushMs: number;
  private readonly mirror: MirrorWriter;
  private readonly mirrorOn: boolean;

  private manifest: ForgeManifest | null = null;
  private progress: ForgeProgress | null = null;
  private recent: ForgeActivity[] = [];
  private lastActivity: ForgeActivity | null = null;
  private lastFlushMs = 0;
  private toolCalls = 0;
  private toolSteps = new Set<number>();
  private latestText: string | null = null;
  private readonly tracker = new ProgressTracker();
  private view: ForgeView = { schema: 1, prompt: '', preamble: null, transcript: [], tools: [], timeline: [], truncated: false };
  private deltaOpen = false;
  private viewSequence = 0;
  private conversation: string | null = null;
  private finished = false;
  private cancelRequestedAt: string | null = null;
  private cwd = '';
  private baselinePending: Promise<void> | null = null;
  /** In-memory size:mtime signatures of baseline-dirty files, to detect further edits. */
  private baselineSigs = new Map<string, string>();
  private changed: { files: string[]; truncated: boolean } | null = null;
  private unattributed: string[] = [];
  private staleReads: string[] = [];
  /** Concatenated tool inputs of this job, used to attribute changed files to it. */
  private toolInputs = '';
  /** Concatenated inputs of edit tool calls only, so read calls never attribute an external edit to the worker. */
  private editToolInputs = '';

  constructor(options: JobWriterOptions) {
    this.repo = options.repo;
    this.jobId = options.jobId;
    this.flushMs = options.flushMs ?? PROGRESS_FLUSH_MS;
    this.mirrorOn = options.mirror ?? true;
    this.mirror = new MirrorWriter(options.repo, { enabled: options.mirror ?? true });
  }

  /**
   * Write the initial snapshot, BEFORE the process is spawned.
   *
   * The ordering is the whole point. A reader that finds nothing has to answer
   * "does this job exist?" with "no", and then the job's whole life is invisible
   * until its first event — which for a slow provider is seconds, and for a
   * spawn failure is forever. Writing first means the job exists from the
   * instant it was accepted, and a spawn that throws turns an existing job from
   * `running` into `failed` instead of leaving a hole.
   *
   * `claim()` runs first: if the id belongs to somebody else's job we refuse
   * before writing a single byte.
   */
  start(input: StartInput): ForgeManifest {
    const now = new Date().toISOString();
    this.view = { ...this.view, prompt: input.prompt.slice(0, 64_000), preamble: input.preamble?.slice(0, 4_000) ?? null,
      truncated: input.prompt.length > 64_000 || (input.preamble?.length ?? 0) > 4_000 };
    this.conversation = input.conversation;
    const manifest: ForgeManifest = {
      schema: SCHEMA_VERSION,
      jobId: this.jobId,
      name: input.name ?? this.jobId,
      workerId: input.workerId ?? this.jobId,
      role: input.mode,
      latestSummary: null,
      summarySource: null,
      provider: input.provider,
      mode: input.mode,
      model: input.model,
      effort: input.effort,
      cwd: input.cwd,
      task: input.task === undefined ? taskTitle(input.prompt) : taskTitle(input.task),
      promptChars: input.prompt.length,
      unrestricted: input.unrestricted,
      conversation: input.conversation,
      ownerPid: process.pid,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      finishedAt: null,
      exitCode: null,
      jobStatus: null,
      error: null,
      deniedActions: [],
      usage: null,
      toolCalls: 0,
      pipeline: input.pipeline,
      stage: input.stage,
      attempt: input.attempt,
      ...(input.modelRequested === undefined ? {} : { modelRequested: input.modelRequested }),
      ...(input.modelResolved === undefined ? {} : { modelResolved: input.modelResolved }),
      ...(input.modelSource === undefined ? {} : { modelSource: input.modelSource }),
      ...(input.preambleApplied === undefined ? {} : { preambleApplied: input.preambleApplied }),
      ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
      ...(input.sandboxFlags === undefined ? {} : { sandboxFlags: input.sandboxFlags }),
      ...(input.readOnlyRequested === undefined ? {} : { readOnlyRequested: input.readOnlyRequested }),
      ...(input.readOnlyEnforced === undefined ? {} : { readOnlyEnforced: input.readOnlyEnforced }),
      ...(input.steeredFrom ? { steeredFrom: input.steeredFrom } : {}),
      ...(input.watchedFiles !== undefined && Object.keys(input.watchedFiles).length > 0
        ? { watchedFiles: input.watchedFiles }
        : {}),
    };
    this.manifest = manifest;
    this.progress = {
      jobId: this.jobId,
      lastEventAt: now,
      recentActivities: [],
      lastActivity: null,
      latestText: null,
      toolCalls: 0,
      warnings: [],
    };

    this.mirror.claim(this.jobId);
    this.writeManifest();
    this.mirror.writeSpec(manifest, input.prompt, input.preamble);
    this.flushProgress(this.manifest.createdAt);
    // Fire and forget: spawn never waits on git. Merged into the manifest when it lands.
    this.cwd = input.cwd;
    this.baselinePending = this.captureBaseline(input.cwd);
    return manifest;
  }

  private async captureBaseline(cwd: string): Promise<void> {
    try {
      const snap = await gitSnapshot(cwd);
      if (snap === null || this.finished || this.manifest === null) return;
      for (const p of snap.dirty.slice(0, CHANGED_FILES_SIG_CAP)) this.baselineSigs.set(p, fileSig(cwd, p));
      this.manifest = { ...this.manifest, gitBaseline: { head: snap.head, dirty: snap.dirty } };
      this.writeManifest();
    } catch { /* best effort */ }
  }

  /** Candidate paths that this worker's own edit tool calls touched. */
  editedFiles(candidates?: readonly string[]): string[] {
    const fromTracker = this.tracker.editedPaths(this.cwd);
    if (candidates === undefined) return fromTracker;
    const fromEditInputs =
      this.editToolInputs !== '' ? attributeChanged(candidates, this.editToolInputs).mine : [];
    return [...new Set([...fromTracker.filter((p) => candidates.includes(p)), ...fromEditInputs])];
  }

  /**
   * Compute `changedFiles` against the baseline. Call (awaited) just before
   * `finish()`; finish stays synchronous. Bounded by the git ~2s cap, never throws.
   */
  async prepareFinish(): Promise<void> {
    try {
      if (this.baselinePending !== null) await this.baselinePending;
      if (this.manifest === null) return;
      const watched = this.manifest.watchedFiles;
      const watchedKeys = watched !== undefined ? Object.keys(watched) : [];
      const editedWatchedSet = new Set(this.editedFiles(watchedKeys));
      const sameRoot = path.resolve(this.repo) === path.resolve(this.cwd);
      const base = this.manifest.gitBaseline;
      if (base !== undefined) {
        const now = await gitSnapshot(this.cwd);
        if (now !== null) {
          const modified = base.dirty.filter(
            (p) => now.dirty.includes(p) && this.baselineSigs.has(p) && this.baselineSigs.get(p) !== fileSig(this.cwd, p),
          );
          const committed = base.head !== null && now.head !== null && base.head !== now.head
            ? await gitCommittedPaths(this.cwd, base.head, now.head)
            : [];
          let baseForDiff = base;
          let nowDirty = now.dirty;
          let modifiedFiltered = modified;
          let committedFiltered = committed;
          if (watched !== undefined) {
            const unmodifiedWatched = new Set<string>();
            const modifiedWatched = new Set<string>();
            for (const [p, sigs] of Object.entries(watched)) {
              const sigChanged = fileSig(this.cwd, p) !== sigs.cwdSig;
              const workerModified = sameRoot ? sigChanged && editedWatchedSet.has(p) : sigChanged;
              if (!workerModified) unmodifiedWatched.add(p);
              else modifiedWatched.add(p);
            }
            if (unmodifiedWatched.size > 0) {
              baseForDiff = { ...base, dirty: base.dirty.filter((p) => !unmodifiedWatched.has(p)) };
              nowDirty = now.dirty.filter((p) => !unmodifiedWatched.has(p));
              modifiedFiltered = modified.filter((p) => !unmodifiedWatched.has(p));
              committedFiltered = committed.filter((p) => !unmodifiedWatched.has(p));
            }
            if (modifiedWatched.size > 0) {
              const nextMod = new Set(modifiedFiltered);
              for (const p of modifiedWatched) nextMod.add(p);
              modifiedFiltered = [...nextMod];
            }
          }
          const diff = diffChangedFiles(baseForDiff, nowDirty, modifiedFiltered, committedFiltered);
          const split = attributeChanged(diff.files, this.toolInputs);
          this.changed = { files: split.mine, truncated: diff.truncated };
          this.unattributed = split.other;
        }
      }
      if (watched !== undefined) {
        this.staleReads = computeStaleReads(this.repo, this.cwd, watched, [...editedWatchedSet]);
      }
    } catch { /* best effort */ }
  }

  /** Feed one normalized provider event into the snapshot. */
  onEvent(event: ProviderEvent): void {
    if (this.finished || this.manifest === null) return;
    const at = event.at;

    if (event.kind === 'started') {
      if (typeof event.conversationId === 'string' && event.conversationId.trim() !== '') {
        this.conversation = event.conversationId;
        this.manifest = { ...this.manifest, conversation: this.conversation };
        // Resume identity must survive a supervisor crash even inside the
        // progress coalescing window, before finish() can publish it.
        this.writeManifest();
      }
      if (typeof event.model === 'string' && this.manifest.model === null) {
        // Provider-reported (structured event, never worker text) beats "unknown"/harness-config guesses.
        this.manifest = {
          ...this.manifest,
          model: event.model,
          modelResolved: event.model,
          modelSource: 'reported',
        };
      }
      this.touch(at);
      return;
    }

    if (event.kind === 'activity-start' || event.kind === 'activity-end') {
      this.deltaOpen = false;
      const ref = event.activity;
      const status =
        event.kind === 'activity-start'
          ? ('active' as const)
          : event.status === 'denied'
            ? ('denied' as const)
            : event.status === 'error'
              ? ('error' as const)
              : ('done' as const);

      if (!this.toolSteps.has(ref.stepIndex)) {
        this.toolSteps.add(ref.stepIndex);
        this.toolCalls += 1;
      }

      // A tool's DONE record frequently carries no `input` (the provider split
      // ACTIVE and DONE for the same step_index, and only ACTIVE had the
      // parameters — 14,900 archived records confirm it). So the DONE row
      // INHERITS the input from the ACTIVE row rather than dropping it, which is
      // what keeps the pane's activity phrase readable on a finished job.
      const idx = this.recent.findIndex((a) => a.stepIndex === ref.stepIndex);
      const input = ref.input ?? (idx >= 0 ? this.recent[idx]?.input : undefined);
      const row: ForgeActivity = {
        stepIndex: ref.stepIndex,
        tool: ref.tool === 'tool_result' ? this.recent[idx]?.tool ?? ref.tool : ref.tool,
        status,
        ...(input === undefined ? {} : { input }),
      };
      if (event.kind === 'activity-start' && ref.input !== undefined) {
        if (this.toolInputs.length < TOOL_INPUTS_CAP) this.toolInputs += ref.input + '\n';
        if (classify(row.tool, input).kind === 'edit' && this.editToolInputs.length < TOOL_INPUTS_CAP) {
          this.editToolInputs += ref.input + '\n';
        }
      }
      if (event.kind === 'activity-start') this.tracker.start(ref.stepIndex, row.tool, input);
      else this.tracker.end(ref.stepIndex, row.tool, input, status);
      this.lastActivity = row;
      if (idx >= 0) this.recent[idx] = row;
      else this.recent.push(row);
      // The pane picks the HIGHEST step_index, not the last entry, because a
      // rewritten array mid-poll is not guaranteed sorted. Keeping the array
      // short is what stops that from mattering.
      if (this.recent.length > RECENT_ACTIVITIES) this.recent = this.recent.slice(-RECENT_ACTIVITIES);

      const tools = [...this.view.tools];
      const toolIndex = tools.findIndex(t => t.stepIndex === ref.stepIndex);
      const previous = tools[toolIndex];
      const detail = { stepIndex: ref.stepIndex, at, tool: (ref.tool === 'tool_result' ? previous?.tool ?? ref.tool : ref.tool).slice(0, 120),
        input: (ref.input ?? previous?.input ?? '').slice(0, 1_000),
        output: (ref.output ?? previous?.output ?? '').slice(0, 2_000),
        state: status === 'active' ? 'active' as const : status === 'done' ? 'done' as const : 'error' as const };
      if (toolIndex >= 0) tools[toolIndex] = detail;
      else tools.push(detail);
      this.view = { ...this.view, tools: tools.slice(-60), truncated: this.view.truncated || tools.length > 60 ||
        (ref.input?.length ?? 0) > 1_000 || (ref.output?.length ?? 0) > 2_000 || ref.tool.length > 120 };

      const timeline = [...this.view.timeline ?? []];
      const eventIndex = timeline.findIndex(e => e.kind === 'tool' && e.stepIndex === ref.stepIndex);
      const oldEvent = timeline[eventIndex];
      const item: ForgeViewEvent = { ...detail, kind: 'tool', sequence: oldEvent?.sequence ?? this.viewSequence++,
        at: oldEvent?.at ?? at };
      if (eventIndex >= 0) timeline[eventIndex] = item;
      else timeline.push(item);
      const bounded = boundTimeline(timeline);
      this.view = { ...this.view, timeline: bounded.events, truncated: this.view.truncated || bounded.truncated };

      this.mirror.appendEvent(this.jobId, event as unknown as Record<string, unknown>);
      this.touch(at);
      return;
    }

    if (event.kind === 'text') {
      if (event.stream !== 'assistant') return;
      this.mirror.appendEvent(this.jobId, event as unknown as Record<string, unknown>);
      const joinDelta = event.delta === true && this.deltaOpen;
      const transcript = [...this.view.transcript];
      if (event.delta && this.deltaOpen && transcript.length > 0) transcript[transcript.length - 1] += event.text;
      else transcript.push(event.text);
      this.deltaOpen = event.delta === true;
      let truncated = this.view.truncated;
      let chars = transcript.reduce((n, t) => n + t.length, 0);
      while (transcript.length > 1 && (chars > 64_000 || transcript.length > 200)) {
        chars -= transcript.shift()!.length;
        truncated = true;
      }
      if (chars > 64_000) { transcript[0] = transcript[0]!.slice(-64_000); truncated = true; }
      this.view = { ...this.view, transcript, truncated };
      const timeline = [...this.view.timeline ?? []];
      const last = timeline.at(-1);
      if (joinDelta && last?.kind === 'assistant') timeline[timeline.length - 1] = { ...last, text: last.text + event.text };
      else timeline.push({ kind: 'assistant', sequence: this.viewSequence++, at, text: event.text });
      const bounded = boundTimeline(timeline);
      this.view = { ...this.view, timeline: bounded.events, truncated: this.view.truncated || bounded.truncated };
      this.latestText = appendBounded(this.latestText ?? '', event.text, LATEST_TEXT_CHARS);
      this.manifest = { ...this.manifest, latestSummary: this.latestText.trim().slice(-1_000) || this.manifest.latestSummary || null, summarySource: 'worker' };
      this.touch(at);
      return;
    }

    if (event.kind === 'notice') {
      if (event.level === 'warn' || event.level === 'error') {
        this.addWarning(event.message.slice(0, 400));
        this.touch(at);
      }
      return;
    }

    if (event.kind === 'usage') {
      this.touch(at);
      return;
    }
  }

  /**
   * Write the terminal state.
   *
   * Every path out of a job goes through here, including the ones where the
   * process died without producing a JobResult — a cancel that raced the exit,
   * a throw from the adapter. A job that never gets a terminal write stays
   * `running` forever, which is a lie with a very long fuse.
   */
  finish(result: JobResult, report: string | null): ForgeManifest {
    if (this.finished || this.manifest === null) {
      // A second terminal write is a bug in the caller, but returning the
      // manifest we already have is strictly better than rewriting history.
      return this.manifest ?? emptyManifest(this.jobId);
    }
    this.finished = true;

    const finishedAt = result.finishedAt;
    // A marker records a request, not proof that the worker stopped. Only the
    // adapter's terminal cancellation verdict can make the job canceled.
    const alreadyTerminal: ForgeStatus | null = result.status === 'cancelled' ? 'canceled' : null;

    const verdict = deriveStatus({
      alreadyTerminal,
      ok: result.ok,
      jobStatus: result.status,
      deniedActions: result.deniedActions ?? [],
      report,
    });

    const failure = failureFields(verdict, result);

    const usage =
      result.usage === undefined
        ? null
        : (Object.fromEntries(
            Object.entries(result.usage).filter((e): e is [string, number] => typeof e[1] === 'number'),
          ) as Record<string, number>);

    const manifest: ForgeManifest = {
      ...this.manifest,
      status: verdict.status,
      updatedAt: finishedAt,
      finishedAt,
      startedAt: this.manifest.startedAt ?? result.startedAt,
      exitCode: result.exitCode,
      jobStatus: result.status,
      // The adapter's own text when it has one, else the verdict's reason; never both.
      error: failure.error,
      reason: failure.reason,
      deniedActions: (result.deniedActions ?? []).map((d) => ({
        ...(d.action === undefined ? {} : { action: d.action }),
        ...(d.displayName === undefined ? {} : { displayName: d.displayName }),
        ...(d.nonfatal === true ? { nonfatal: true } : {}),
      })),
      usage,
      toolCalls: this.toolCalls,
      conversation: this.conversation,
      latestSummary: result.response.trim().slice(0, 1_000) || this.manifest.latestSummary || null,
      summarySource: result.response.trim() || this.manifest.latestSummary ? 'worker' : null,
      ...(this.changed === null
        ? {}
        : { changedFiles: this.changed.files, changedFilesTruncated: this.changed.truncated }),
      ...(this.unattributed.length === 0 ? {} : { unattributedFiles: this.unattributed }),
      ...(this.staleReads.length === 0 ? {} : { staleReads: this.staleReads }),
      ...(this.manifest.pendingSteers !== undefined ? { pendingSteers: 0 } : {}),
    };
    this.manifest = manifest;
    if (this.progress !== null && this.progress.pendingSteers !== undefined) {
      this.progress = { ...this.progress, pendingSteers: 0 };
    }

    const body = report ?? '';
    writeAtomic(jobFile(this.repo, this.jobId, FILES.report), body);
    this.writeManifest();
    this.flushProgress(finishedAt);
    this.mirror.finish(manifest, body, verdict.suspicious);

    if (verdict.suspicious) this.addWarning(verdict.reason ?? 'suspicious success');
    return manifest;
  }

  /**
   * Record a terminal state with no JobResult at all.
   *
   * Used when the adapter throws or never resolves. Same guarantee as `finish`:
   * the job stops claiming to be `running`.
   */
  abort(status: Exclude<ForgeStatus, 'running'>, reason: string): ForgeManifest | null {
    if (this.finished || this.manifest === null) return this.manifest;
    this.finished = true;
    const now = new Date().toISOString();
    const manifest: ForgeManifest = {
      ...this.manifest,
      status,
      updatedAt: now,
      finishedAt: now,
      error: reason,
      reason: status === 'failed' ? reason.split(' · ')[0]! : null,
      jobStatus: status === 'canceled' ? 'cancelled' : 'malformed',
      ...(this.manifest.pendingSteers !== undefined ? { pendingSteers: 0 } : {}),
    };
    this.manifest = manifest;
    if (this.progress !== null && this.progress.pendingSteers !== undefined) {
      this.progress = { ...this.progress, pendingSteers: 0 };
    }
    this.addWarning(reason);
    this.writeManifest();
    this.flushProgress(now);
    this.mirror.finish(manifest, reportText(this.repo, this.jobId), false);
    return manifest;
  }

  /**
   * Request cancellation. Writes the marker FIRST, then the caller kills.
   *
   * Marker before kill because the kill is asynchronous and a reader polling in
   * between must already see the intent. This is agy-staff's HAZARD B, kept for
   * the same reason it exists there: a cancellation caught mid-flight is still a
   * cancellation, and the worker may never get to write its own terminal state.
   */
  requestCancel(at: string = new Date().toISOString()): void {
    if (this.finished) return;
    if (this.cancelRequestedAt === null) {
      this.cancelRequestedAt = at;
      createMarker(jobFile(this.repo, this.jobId, FILES.cancel), at);
      // Legacy readers treat a marker as already stopped. Keep the request
      // canonical until finish() publishes an acknowledged terminal state.
    }
  }

  /** Did this job get cancelled? True once a marker exists, terminal or not. */
  get cancelled(): boolean {
    return this.cancelRequestedAt !== null;
  }

  /** Latest conversation ID known to this writer (from start() or the provider's init event). */
  currentConversation(): string | null {
    return this.conversation;
  }

  /**
   * Stamp `supersededBy` in memory before `finish()` or `abort()` so the
   * terminal anchor write includes `supersededBy` atomically.
   */
  markSuperseded(nextJobId: string): void {
    if (this.manifest === null) return;
    this.manifest = { ...this.manifest, supersededBy: nextJobId, pendingSteers: 0 };
    if (this.progress !== null) {
      this.progress = { ...this.progress, pendingSteers: 0 };
    }
  }

  /** Update the published count of unconsumed queued steers in the writer-owned files. */
  setPendingSteers(count: number, at: string = new Date().toISOString()): void {
    if (this.finished || this.manifest === null) return;
    const next = Math.max(0, count);
    this.manifest = { ...this.manifest, pendingSteers: next, updatedAt: at };
    if (this.progress !== null) {
      this.progress = { ...this.progress, pendingSteers: next };
    }
    this.flushProgress(at);
  }

  /** Record a supervisor-level warning on this job's progress. */
  warn(message: string): void {
    this.addWarning(message);
  }

  /**
   * The recent tool rows, in step order.
   *
   * Exposed so the pipeline runner can build `Observation[]` for routing.ts
   * without opening a second subscription to the provider's event stream — this
   * process already owns that stream.
   */
  activities(): readonly ForgeActivity[] {
    return [...this.recent].sort((a, b) => a.stepIndex - b.stepIndex);
  }

  /** The current manifest, for a status() read that does not re-parse the file. */
  snapshot(): ForgeManifest | null {
    return this.manifest;
  }

  /* ── internals ─────────────────────────────────────────────────────────── */

  private touch(at: string): void {
    if (this.manifest === null) return;
    this.manifest = { ...this.manifest, updatedAt: at };
    this.progress = {
      jobId: this.jobId,
      name: this.manifest.name,
      workerId: this.manifest.workerId,
      role: this.manifest.role,
      latestSummary: this.manifest.latestSummary,
      summarySource: this.manifest.summarySource,
      lastEventAt: at,
      recentActivities: this.recent,
      lastActivity: this.lastActivity,
      latestText: this.latestText,
      toolCalls: this.toolCalls,
      warnings: this.progress?.warnings ?? [],
      digest: this.tracker.digest(this.cwd),
      ...(this.progress?.pendingSteers !== undefined ? { pendingSteers: this.progress.pendingSteers } : {}),
    };
    const nowMs = Date.parse(at);
    const clock = Number.isNaN(nowMs) ? Date.now() : nowMs;
    if (shouldFlush(this.lastFlushMs, clock, this.flushMs)) this.flushProgress(at);
  }

  private addWarning(message: string): void {
    if (this.progress === null) return;
    if (this.progress.warnings.includes(message)) return;
    this.progress = { ...this.progress, warnings: [...this.progress.warnings, message] };
  }

  /** Persist the anchor. Always whole, always atomic. */
  private writeManifest(): void {
    if (this.manifest === null) return;
    writeJsonAtomic(jobFile(this.repo, this.jobId, FILES.job), this.manifest);
  }

  private flushProgress(at: string): void {
    if (this.progress === null) return;
    const progress: ForgeProgress = { ...this.progress, lastEventAt: at,
      name: this.manifest?.name, workerId: this.manifest?.workerId, role: this.manifest?.role,
      latestSummary: this.manifest?.latestSummary ?? null, summarySource: this.manifest?.summarySource ?? null };
    this.progress = progress;
    this.writeManifest();
    writeJsonAtomic(jobFile(this.repo, this.jobId, FILES.progress), progress);
    writeJsonAtomic(jobFile(this.repo, this.jobId, FILES.view), this.view);
    this.mirror.writeProgress(this.manifest ?? emptyManifest(this.jobId), progress);
    const ms = Date.parse(at);
    this.lastFlushMs = Number.isNaN(ms) ? Date.now() : ms;
  }
}

/* ── git baseline helpers ─────────────────────────────────────────────────── */

const GIT_CAP_MS = 2_000;
const TOOL_INPUTS_CAP = 200_000;
const CHANGED_FILES_SIG_CAP = 500;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_CAP_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/** HEAD + dirty paths, or null when cwd is not a git repo / git fails / is slow. */
async function gitSnapshot(cwd: string): Promise<GitBaseline | null> {
  try {
    const [status, head] = await Promise.all([
      git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => ''),
    ]);
    return { head: head.trim() === '' ? null : head.trim(), dirty: parsePorcelainZ(status) };
  } catch {
    return null;
  }
}

/** Parse `status --porcelain=v1 -z`: `XY path\0`, renames/copies add `orig\0`. Exported for tests. */
export function parsePorcelainZ(out: string): string[] {
  const parts = out.split('\0');
  const paths = new Set<string>();
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i] ?? '';
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    paths.add(e.slice(3));
    if (xy.includes('R') || xy.includes('C')) {
      const orig = parts[++i];
      if (orig) paths.add(orig);
    }
  }
  return [...paths].filter((p) => !isForgeStatePath(p)).sort();
}

async function gitCommittedPaths(cwd: string, from: string, to: string): Promise<string[]> {
  try {
    return (await git(cwd, ['diff', '--name-only', '-z', `${from}`, `${to}`])).split('\0').filter((p) => p !== '');
  } catch {
    return [];
  }
}

export function fileSig(cwd: string, rel: string): string {
  try {
    const full = path.join(cwd, rel);
    const st = statSync(full);
    if (!st.isFile()) return 'gone';
    if (st.size <= 4 * 1024 * 1024) {
      const hash = createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 16);
      return `${st.size}:${hash}`;
    }
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return 'gone';
  }
}

export function computeStaleReads(
  repo: string,
  cwd: string,
  watchedFiles?: Readonly<Record<string, WatchedFileSigs>>,
  changedFiles?: readonly string[],
): string[] {
  if (!watchedFiles) return [];
  const entries = Object.entries(watchedFiles);
  if (entries.length === 0) return [];
  const repoRoot = path.resolve(repo);
  const cwdRoot = path.resolve(cwd);
  const sameRoot = repoRoot === cwdRoot;
  const workerChanged = new Set(changedFiles ?? []);
  const stale: string[] = [];
  for (const [rel, sigs] of entries) {
    const currentRepoSig = fileSig(repoRoot, rel);
    if (!sameRoot) {
      const currentCwdSig = fileSig(cwdRoot, rel);
      const externallyEditedInCwd =
        changedFiles !== undefined && currentCwdSig !== sigs.cwdSig && !workerChanged.has(rel);
      if (currentRepoSig !== sigs.repoSig || externallyEditedInCwd) {
        stale.push(rel);
      }
    } else if (currentRepoSig !== sigs.repoSig && !workerChanged.has(rel)) {
      stale.push(rel);
    }
  }
  return stale.sort();
}

/** Append `add` to `base`, bounded. Pure, so the bounding rule is testable. */
export function appendBounded(base: string, add: string, max: number): string {
  const joined = base === '' ? add : `${base}${add}`;
  if (joined.length <= max) return joined;
  // Cut from the FRONT: the newest text is what the pane shows, and a stale
  // opening paragraph is worth less than the sentence the worker just wrote.
  return joined.slice(joined.length - max);
}

/** Read back a report we wrote. Used by abort(), where we never had one. */
function reportText(repo: string, jobId: string): string {
  try {
    return readFileSync(jobFile(repo, jobId, FILES.report), 'utf8');
  } catch {
    return '';
  }
}

function emptyManifest(jobId: string): ForgeManifest {
  const now = new Date().toISOString();
  return {
    schema: SCHEMA_VERSION,
    jobId,
    provider: 'unknown',
    mode: 'unknown',
    model: null,
    effort: null,
    cwd: '',
    task: '',
    promptChars: 0,
    unrestricted: false,
    conversation: null,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    jobStatus: null,
    error: null,
    deniedActions: [],
    usage: null,
    toolCalls: 0,
    pipeline: null,
    stage: null,
    attempt: null,
  };
}

/**
 * Subscribe to a handle's events and drive this writer from them.
 *
 * Returns an unsubscribe. Event listeners run synchronously in stream order, so
 * this does no async work — the only awaits are in `onEvent`, and there are none.
 */
export function pipeEvents(writer: JobWriter, handle: WorkerHandle): () => void {
  return handle.onEvent((event) => {
    try {
      writer.onEvent(event);
    } catch {
      // A state write must never kill a worker that is otherwise fine. Losing
      // one progress snapshot costs one stale poll tick; killing the job costs
      // the user 28 minutes.
    }
  });
}

/** The report text a JobResult implies, under the headline rule. Exported for tests. */
export function reportFor(result: JobResult): string {
  if (typeof result.response === 'string' && !looksEmpty(result.response)) return result.response;
  return '';
}

/** Append one normalized event straight to our own event log. Used by tests. */
export function appendOwnEvent(repo: string, jobId: string, event: ProviderEvent): void {
  appendLine(jobFile(repo, jobId, FILES.events), event);
}

/** Ordered previews use the same bounded budget as the other detail fields. */
function boundTimeline(input: ForgeViewEvent[]): { events: ForgeViewEvent[]; truncated: boolean } {
  const events = [...input];
  let truncated = false;
  let chars = events.reduce((n,e) => n + (e.kind === 'assistant' ? e.text.length : 0),0);
  let tools = events.filter(e => e.kind === 'tool').length;
  while (events.length > 1 && (events.length > 100 || chars > 64_000 || tools > 60)) {
    const removed = events.shift()!;
    if (removed.kind === 'assistant') chars -= removed.text.length;
    else tools--;
    truncated = true;
  }
  const first = events[0];
  if (first?.kind === 'assistant' && first.text.length > 64_000) {
    events[0] = { ...first, text: first.text.slice(-64_000) };
    truncated = true;
  }
  return { events, truncated };
}
