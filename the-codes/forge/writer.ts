// Shared with the mod, which renders the digest; the mod loader cannot import forge, so it lives there.
import { classify, ProgressTracker } from '../surfaces/mod/hooks/progress.ts';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { createMarker, writeAtomic, writeJsonAtomic } from './atomic.ts';
import {
  FAILED_EARLY_MS,
  FILES,
  PROGRESS_FLUSH_MS,
  cwdFacts,
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
  type ContinuationKind,
  type ForgeActivity,
  type GitBaseline,
  type ForgeManifest,
  type ForgeProgress,
  type ForgeStatus,
  type ForgeView,
  type ForgeViewEvent,
  type MessageSender,
  type TurnMessage,
  type WatchedFileSigs,
} from './format.ts';
import type { JobResult, ProviderEvent, WorkerHandle } from '../providers/types.ts';
import type { MemberView, Team } from '../surfaces/mod/types/index.d.ts';
import { memberFileName } from '../surfaces/mod/hooks/team.ts';

const RECENT_ACTIVITIES = 5;

const LATEST_TEXT_CHARS = 4_000;

const SUMMARY_CHARS = 1_000;

export const TEAM_MEMBERS_CAP = 64;

export interface JobWriterOptions {
  readonly repo: string;
  readonly jobId: string;
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
  readonly preamble?: string;
  readonly messages?: readonly TurnMessage[] | undefined;
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
  readonly turn?: number;
  readonly continuedFrom?: string | undefined;
  readonly continuationKind?: ContinuationKind | undefined;
  readonly chainStartedAt?: string | undefined;
  readonly watchedFiles?: Readonly<Record<string, WatchedFileSigs>>;
}

export class JobWriter {
  readonly jobId: string;
  private readonly repo: string;
  private readonly flushMs: number;

  private manifest: ForgeManifest | null = null;
  private progress: ForgeProgress | null = null;
  private recent: ForgeActivity[] = [];
  private lastActivity: ForgeActivity | null = null;
  private lastFlushMs = 0;
  private toolCalls = 0;
  private toolSteps = new Set<number>();
  private latestText: string | null = null;
  private currentMessage = '';
  private toolErrorSteps = new Set<number>();
  private lastAliveAt: string | null = null;
  private workerPid: number | undefined;
  private lastHeartbeatFlushMs = 0;
  private firstEventSeen = false;
  private firstEventWasError = false;
  private readonly tracker = new ProgressTracker();
  private view: ForgeView = { schema: 1, prompt: '', preamble: null, transcript: [], tools: [], timeline: [], truncated: false };
  private deltaOpen = false;
  private viewSequence = 0;
  private conversation: string | null = null;
  private finished = false;
  private cancelRequestedAt: string | null = null;
  private cwd = '';
  private realCwd = '';
  private baselinePending: Promise<void> | null = null;
  private baselineSigs = new Map<string, string>();
  private changed: { files: string[]; truncated: boolean } | null = null;
  private unattributed: string[] = [];
  private staleReads: string[] = [];
  private toolInputs = '';
  private editToolInputs = '';
  private readonly editStepsCompleted = new Set<number>();
  private team: Team | null = null;
  private teamDirty = false;
  private readonly pendingViews = new Map<string, MemberView>();
  private readonly writtenViews = new Map<string, string>();
  private lastTeamFlushMs = 0;

  constructor(options: JobWriterOptions) {
    this.repo = options.repo;
    this.jobId = options.jobId;
    this.flushMs = options.flushMs ?? PROGRESS_FLUSH_MS;
  }

  start(input: StartInput): ForgeManifest {
    const now = new Date().toISOString();
    const turn = typeof input.turn === 'number' && Number.isInteger(input.turn) && input.turn >= 1 ? input.turn : 1;
    const chainStartedAt = input.chainStartedAt ?? now;
    this.view = {
      ...this.view,
      prompt: input.prompt.slice(0, 64_000),
      preamble: input.preamble?.slice(0, 4_000) ?? null,
      ...(input.messages !== undefined && input.messages.length > 0
        ? { messages: input.messages.map((m) => ({ sender: m.sender, text: m.text.slice(0, 64_000) })) }
        : {}),
      truncated: input.prompt.length > 64_000 || (input.preamble?.length ?? 0) > 4_000,
    };
    this.conversation = input.conversation;
    const manifest: ForgeManifest = {
      schema: SCHEMA_VERSION,
      jobId: this.jobId,
      name: input.name ?? this.jobId,
      workerId: input.workerId ?? this.jobId,
      turn,
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
      timeoutMs: input.timeoutMs,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      chainStartedAt,
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
      ...(input.continuedFrom ? { continuedFrom: input.continuedFrom } : {}),
      ...(input.continuationKind ? { continuationKind: input.continuationKind } : {}),
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
      editsCompleted: 0,
      warnings: [],
    };

    this.writeManifest();
    this.flushProgress(this.manifest.createdAt);
    this.cwd = input.cwd;
    this.realCwd = realPathOr(input.cwd);
    this.baselinePending = isInsideGitRepo(input.cwd) ? this.captureBaseline(input.cwd) : null;
    return manifest;
  }

  hasPendingBaseline(): boolean {
    return this.baselinePending !== null;
  }

  private async captureBaseline(cwd: string): Promise<void> {
    try {
      const snap = await gitSnapshot(cwd);
      if (snap === null || this.finished || this.manifest === null) return;
      for (const p of snap.dirty.slice(0, CHANGED_FILES_SIG_CAP)) this.baselineSigs.set(p, fileSig(cwd, p));
      this.manifest = { ...this.manifest, gitBaseline: { head: snap.head, dirty: snap.dirty } };
      this.writeManifest();
    } catch {}
  }

  async awaitBaseline(): Promise<readonly string[]> {
    try {
      if (this.baselinePending !== null) await this.baselinePending;
    } catch {}
    return (this.manifest?.gitBaseline?.dirty ?? []).filter((p) => !isForgeStatePath(p));
  }

  updatePreamble(preamble: string): void {
    this.view = {
      ...this.view,
      preamble: preamble.slice(0, 4_000),
      truncated: this.view.truncated || preamble.length > 4_000,
    };
    writeJsonAtomic(jobFile(this.repo, this.jobId, FILES.view), this.view);
  }

  editedFiles(candidates?: readonly string[]): string[] {
    const fromTracker = this.tracker.editedPaths(this.cwd, this.realCwd);
    if (candidates === undefined) return fromTracker;
    const fromEditInputs =
      this.editToolInputs !== '' ? attributeChanged(candidates, this.editToolInputs).mine : [];
    return [...new Set([...fromTracker.filter((p) => candidates.includes(p)), ...fromEditInputs])];
  }

  async prepareFinish(): Promise<void> {
    try {
      if (this.baselinePending !== null) await this.baselinePending;
      if (this.manifest === null) return;
      if (!existsSync(this.cwd)) return;
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
    } catch {}
  }

  heartbeat(at: string, pid?: number): void {
    if (this.finished || this.manifest === null || this.progress === null) return;
    this.lastAliveAt = at;
    if (typeof pid === 'number') this.workerPid = pid;
    this.progress = { ...this.progress, lastAliveAt: at, ...(this.workerPid === undefined ? {} : { workerPid: this.workerPid }) };
    const nowMs = Date.parse(at);
    if (!shouldFlush(this.lastHeartbeatFlushMs, Number.isNaN(nowMs) ? Date.now() : nowMs, this.flushMs)) return;
    this.lastHeartbeatFlushMs = Number.isNaN(nowMs) ? Date.now() : nowMs;
    writeJsonAtomic(jobFile(this.repo, this.jobId, FILES.progress), this.progress);
    try { this.flushTeam(); } catch {}
  }

  onTeam(at: string, team: Team, views: readonly MemberView[]): void {
    if (this.finished || this.manifest === null) return;
    const members = team.members.slice(0, TEAM_MEMBERS_CAP);
    const kept = new Set(members.map((m) => m.id));
    this.team = { ...team, members };
    for (const view of views) if (kept.has(view.id)) this.pendingViews.set(view.id, view);
    this.teamDirty = true;
    const nowMs = Date.parse(at);
    const clock = Number.isNaN(nowMs) ? Date.now() : nowMs;
    if (shouldFlush(this.lastTeamFlushMs, clock, this.flushMs)) { this.lastTeamFlushMs = clock; try { this.flushTeam(); } catch {} }
  }

  private flushTeam(): void {
    if (!this.teamDirty || this.team === null) return;
    writeJsonAtomic(jobFile(this.repo, this.jobId, FILES.team), this.team);
    for (const [id, view] of this.pendingViews) {
      const body = JSON.stringify(view);
      if (this.writtenViews.get(id) !== body) {
        try {
          writeAtomic(jobFile(this.repo, this.jobId, path.join(FILES.members, memberFileName(id))), body);
        } catch {
          continue;
        }
        this.writtenViews.set(id, body);
      }
      this.pendingViews.delete(id);
    }
    this.teamDirty = this.pendingViews.size > 0;
  }

  onEvent(event: ProviderEvent): void {
    if (this.finished || this.manifest === null) return;
    switch (event.kind) {
      case 'heartbeat': this.heartbeat(event.at, event.pid); return;
      case 'team': this.onTeam(event.at, event.team, event.views); return;
      case 'started': this.onStarted(event); return;
      case 'activity-start':
      case 'activity-update':
      case 'activity-end': this.onActivity(event); return;
      case 'text': this.onText(event); return;
      case 'notice':
        if (event.level !== 'info') this.noteFirstEvent(event.level === 'error');
        if (event.level === 'warn' || event.level === 'error') {
          this.addWarning(event.message.slice(0, 400));
          this.touch(event.at);
        }
        return;
      case 'usage': this.touch(event.at); return;
      default: return;
    }
  }

  private onStarted(event: Extract<ProviderEvent, { kind: 'started' }>): void {
    if (this.manifest === null) return;
    const at = event.at;
    if (typeof event.conversationId === 'string' && event.conversationId.trim() !== '') {
      this.conversation = event.conversationId;
      this.manifest = { ...this.manifest, conversation: this.conversation };
      this.writeManifest();
    }
    if (typeof event.model === 'string' && this.manifest.model === null) {
      this.manifest = {
        ...this.manifest,
        model: event.model,
        modelResolved: event.model,
        modelSource: 'reported',
      };
    }
    this.touch(at);
  }

  private onActivity(event: Extract<ProviderEvent, { kind: 'activity-start' | 'activity-update' | 'activity-end' }>): void {
    if (this.manifest === null) return;
    const at = event.at;
    this.deltaOpen = false;
    const ref = event.activity;
    const isStart = event.kind === 'activity-start';
    const status =
      isStart || event.kind === 'activity-update'
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

    const idx = this.recent.findIndex((a) => a.stepIndex === ref.stepIndex);
    const previousRow = idx >= 0 ? this.recent[idx] : undefined;
    const input = ref.input ?? previousRow?.input;
    const tool = ref.tool === 'tool_result' ? previousRow?.tool ?? ref.tool : ref.tool;
    const row: ForgeActivity = {
      stepIndex: ref.stepIndex,
      tool,
      status,
      ...(input === undefined ? {} : { input }),
    };
    if (ref.input !== undefined && previousRow?.input === undefined) {
      if (this.toolInputs.length < TOOL_INPUTS_CAP) this.toolInputs += ref.input + '\n';
      if (classify(tool, input).kind === 'edit' && this.editToolInputs.length < TOOL_INPUTS_CAP) {
        this.editToolInputs += ref.input + '\n';
      }
    }
    if (event.kind === 'activity-end') this.tracker.end(ref.stepIndex, row.tool, input, status);
    else this.tracker.start(ref.stepIndex, row.tool, ref.input ?? input);
    if (event.kind === 'activity-end' && status === 'done' && classify(tool, input).kind === 'edit') {
      this.editStepsCompleted.add(ref.stepIndex);
    }
    if (isStart) this.currentMessage = '';
    if (status === 'error') this.toolErrorSteps.add(ref.stepIndex);
    this.noteFirstEvent(false);
    this.lastActivity = row;
    if (idx >= 0) this.recent[idx] = row;
    else this.recent.push(row);
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

    this.touch(at);  }

  private onText(event: Extract<ProviderEvent, { kind: 'text' }>): void {
    if (this.manifest === null) return;
    const at = event.at;
    if (event.stream !== 'assistant') return;
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
    this.currentMessage = appendBounded(this.currentMessage, event.text, LATEST_TEXT_CHARS);
    this.noteFirstEvent(false);
    this.manifest = { ...this.manifest, latestSummary: summaryHead(this.currentMessage, SUMMARY_CHARS) || this.manifest.latestSummary || null, summarySource: 'worker' };
    this.touch(at);  }

  verdictFacts(): { cwdMissing: boolean; writing: boolean } {
    return cwdFacts(this.cwd, this.manifest?.mode, this.editStepsCompleted.size > 0);
  }

  finish(result: JobResult, report: string | null): ForgeManifest {
    if (this.finished || this.manifest === null) {
      return this.manifest ?? emptyManifest(this.jobId);
    }
    this.finished = true;

    const finishedAt = result.finishedAt;
    const alreadyTerminal: ForgeStatus | null = result.status === 'cancelled' ? 'canceled' : null;

    const { cwdMissing, writing } = this.verdictFacts();
    const verdict = deriveStatus({
      alreadyTerminal,
      ok: result.ok,
      jobStatus: result.status,
      deniedActions: result.deniedActions ?? [],
      report,
      cwdMissing,
      writing,
    });
    if (cwdMissing && !verdict.suspicious) {
      this.addWarning(`working directory ${this.cwd} was gone at finish; changed files and checks could not be verified`);
    }

    const failure = failureFields(verdict, result);
    const failedEarly =
      verdict.status === 'failed' && !result.ok && result.status !== 'timeout' && result.status !== 'cancelled' &&
      this.toolCalls === 0 && (result.durationMs <= FAILED_EARLY_MS || this.firstEventWasError);
    const response = result.response.trim();

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
      error: failure.error,
      reason: failure.reason,
      deniedActions: (result.deniedActions ?? []).map((d) => ({
        ...(d.action === undefined ? {} : { action: d.action }),
        ...(d.displayName === undefined ? {} : { displayName: d.displayName }),
        ...(d.nonfatal === true ? { nonfatal: true } : {}),
      })),
      usage,
      toolCalls: this.toolCalls,
      ...(this.toolErrorSteps.size === 0 ? {} : { toolErrors: this.toolErrorSteps.size }),
      ...(failedEarly ? { failedEarly: true } : {}),
      conversation: this.conversation,
      latestSummary: summaryHead(response, SUMMARY_CHARS) || this.manifest.latestSummary || null,
      summarySource: response || this.manifest.latestSummary ? 'worker' : null,
      ...(this.changed === null
        ? { changedFilesUnknown: true }
        : { changedFiles: this.changed.files, changedFilesTruncated: this.changed.truncated }),
      ...(cwdMissing ? { cwdMissingAtFinish: true } : {}),
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

    if (verdict.suspicious) this.addWarning(verdict.reason ?? 'suspicious success');
    return manifest;
  }

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
    return manifest;
  }

  requestCancel(at: string = new Date().toISOString()): void {
    if (this.finished) return;
    if (this.cancelRequestedAt === null) {
      this.cancelRequestedAt = at;
      createMarker(jobFile(this.repo, this.jobId, FILES.cancel), at);
    }
  }

  get cancelled(): boolean {
    return this.cancelRequestedAt !== null;
  }

  currentConversation(): string | null {
    return this.conversation;
  }

  markSuperseded(nextJobId: string): void {
    if (this.manifest === null) return;
    this.manifest = { ...this.manifest, supersededBy: nextJobId, pendingSteers: 0 };
    if (this.progress !== null) {
      this.progress = { ...this.progress, pendingSteers: 0 };
    }
  }

  markFollowedBy(nextJobId: string): void {
    if (this.manifest === null) return;
    this.manifest = { ...this.manifest, followedBy: nextJobId, pendingSteers: 0 };
    if (this.progress !== null) {
      this.progress = { ...this.progress, pendingSteers: 0 };
    }
  }

  setPendingSteers(count: number, at: string = new Date().toISOString()): void {
    if (this.finished || this.manifest === null) return;
    const next = Math.max(0, count);
    this.manifest = { ...this.manifest, pendingSteers: next, updatedAt: at };
    if (this.progress !== null) {
      this.progress = { ...this.progress, pendingSteers: next };
    }
    this.flushProgress(at);
  }

  recordMessage(text: string, delivery: 'next-step' | 'turn-start', sender: MessageSender, at: string = new Date().toISOString()): void {
    if (this.manifest === null) return;
    const timeline = [...this.view.timeline ?? [], { kind: 'message' as const, sequence: this.viewSequence++, at, text: text.slice(0, 2_000), delivery, sender }];
    const bounded = boundTimeline(timeline);
    this.view = { ...this.view, timeline: bounded.events, truncated: this.view.truncated || bounded.truncated };
    this.deltaOpen = false;
    if (this.finished) writeJsonAtomic(jobFile(this.repo, this.jobId, FILES.view), this.view);
    else this.flushProgress(at);
  }

  warn(message: string): void {
    this.addWarning(message);
  }

  activities(): readonly ForgeActivity[] {
    return [...this.recent].sort((a, b) => a.stepIndex - b.stepIndex);
  }

  snapshot(): ForgeManifest | null {
    return this.manifest;
  }

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
      editsCompleted: this.editStepsCompleted.size,
      ...(this.toolErrorSteps.size === 0 ? {} : { toolErrors: this.toolErrorSteps.size }),
      ...(this.lastAliveAt === null ? {} : { lastAliveAt: this.lastAliveAt }),
      ...(this.workerPid === undefined ? {} : { workerPid: this.workerPid }),
      warnings: this.progress?.warnings ?? [],
      digest: this.tracker.digest(this.cwd, this.realCwd),
      ...(this.progress?.pendingSteers !== undefined ? { pendingSteers: this.progress.pendingSteers } : {}),
    };
    const nowMs = Date.parse(at);
    const clock = Number.isNaN(nowMs) ? Date.now() : nowMs;
    if (shouldFlush(this.lastFlushMs, clock, this.flushMs)) this.flushProgress(at);
  }

  private noteFirstEvent(isError: boolean): void {
    if (this.firstEventSeen) return;
    this.firstEventSeen = true;
    this.firstEventWasError = isError;
  }

  private addWarning(message: string): void {
    if (this.progress === null) return;
    if (this.progress.warnings.includes(message)) return;
    this.progress = { ...this.progress, warnings: [...this.progress.warnings, message] };
  }

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
    const ms = Date.parse(at);
    this.lastFlushMs = Number.isNaN(ms) ? Date.now() : ms;
    try { this.flushTeam(); } catch {}
  }
}

function gitCapMs(): number {
  const n = Number(process.env['AGENT_SMITH_GIT_TIMEOUT_MS']);
  return Number.isFinite(n) && n > 0 ? n : 2_000;
}
const TOOL_INPUTS_CAP = 200_000;
const CHANGED_FILES_SIG_CAP = 500;

function realPathOr(dir: string): string {
  try { return realpathSync(dir); } catch { return dir; }
}

function isInsideGitRepo(cwd: string): boolean {
  let dir = path.resolve(cwd);
  while (true) {
    if (existsSync(path.join(dir, '.git'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: gitCapMs(), maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

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

export function appendBounded(base: string, add: string, max: number): string {
  const joined = base === '' ? add : `${base}${add}`;
  if (joined.length <= max) return joined;
  return joined.slice(joined.length - max);
}

export function summaryHead(text: string, max: number): string {
  const t = text.trim().replace(/^Status:[^\n]*(?:\n|$)/, '').trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  if (t[max] === '\n') return head.trim();
  for (const sep of ['\n\n', '\n']) {
    const i = head.lastIndexOf(sep);
    if (i >= 0 && head.slice(0, i).trim() !== '') return head.slice(0, i).trim();
  }
  return head.trim();
}

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
    workerId: jobId,
    turn: 1,
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
    chainStartedAt: now,
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

export function pipeEvents(writer: JobWriter, handle: WorkerHandle): () => void {
  return handle.onEvent((event) => {
    try {
      writer.onEvent(event);
    } catch {}
  });
}

export function reportFor(result: JobResult): string {
  if (typeof result.response === 'string' && !looksEmpty(result.response)) return result.response;
  return '';
}

function boundTimeline(input: ForgeViewEvent[]): { events: ForgeViewEvent[]; truncated: boolean } {
  const events = [...input];
  let truncated = false;
  let chars = events.reduce((n,e) => n + (e.kind === 'assistant' ? e.text.length : 0),0);
  let tools = events.filter(e => e.kind === 'tool').length;
  while (events.length > 1 && (events.length > 100 || chars > 64_000 || tools > 60)) {
    const removed = events.shift()!;
    if (removed.kind === 'assistant') chars -= removed.text.length;
    else if (removed.kind === 'tool') tools--;
    truncated = true;
  }
  const first = events[0];
  if (first?.kind === 'assistant' && first.text.length > 64_000) {
    events[0] = { ...first, text: first.text.slice(-64_000) };
    truncated = true;
  }
  return { events, truncated };
}
