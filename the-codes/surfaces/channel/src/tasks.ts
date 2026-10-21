/** Current-protocol Tasks receiver; Forge owns execution and acceptance. */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Server, ProtocolError, ProtocolErrorCode, type CallToolResult } from '@modelcontextprotocol/server';
import {
  TASKS_EXTENSION_ID_V2, CreateTaskResultV2Schema,
  GetTaskRequestV2Schema, GetTaskResultV2Schema,
  UpdateTaskRequestV2Schema, UpdateTaskResultV2Schema,
  CancelTaskRequestV2Schema, CancelTaskResultV2Schema,
  type CreateTaskResultV2, type GetTaskResultV2,
} from '@modelcontextprotocol/ext-tasks/core/v2';
import { readAcceptance } from '../../../forge/checks.ts';
import { TaskStore, type TaskRecord } from './task-store.ts';
import { callTool, fullStatus, structured, type HandlerContext } from './tools.ts';

export { TASKS_EXTENSION_ID_V2 };
export const TASK_RESULT_META = 'io.agent-smith/task-result';

export class ForgeTasks {
  readonly store: TaskStore;
  private readonly context: Omit<HandlerContext, 'server'>;
  constructor(context: Omit<HandlerContext, 'server'>) {
    this.context = context;
    this.store = new TaskStore(path.join(context.service.repo, '.agent-smith', 'tasks'));
  }

  async launch(context: HandlerContext, name: string, args: unknown): Promise<CallToolResult | CreateTaskResultV2> {
    const taskId = randomUUID();
    let task: TaskRecord | undefined;
    const result = await callTool({ ...context, onJobPrepared: jobId => {
      task = task ? this.store.rebindJob(taskId, jobId) : this.store.create({ taskId, jobId });
      context.onJobPrepared?.(jobId);
    } }, name, args);
    // Validation and MRTR approval both happen before onPrepared. Ordinary tool
    // errors keep their ordinary result shape and never claim a task was launched.
    if (!task) return result;
    if (result.isError) {
      task = this.store.complete(taskId, { ...result, resultType: 'complete', _meta: { ...result._meta, [TASK_RESULT_META]: true } });
    }
    return CreateTaskResultV2Schema.parse({ ...this.base(task), status: task.status, resultType: 'task' });
  }

  private require(taskId: string): TaskRecord {
    let record: TaskRecord | undefined;
    try { record = this.store.get(taskId); } catch (err) {
      if (!(err instanceof TypeError)) throw err;
    }
    if (!record) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown or expired task: ${taskId}`);
    return record;
  }

  private base(task: TaskRecord) {
    return { taskId: task.taskId, createdAt: task.createdAt, lastUpdatedAt: task.lastUpdatedAt,
      ttlMs: Date.parse(task.expiresAt) - Date.parse(task.createdAt), pollIntervalMs: this.context.pollMs ?? 1000 };
  }

  async get(taskId: string): Promise<GetTaskResultV2> {
    let task = this.require(taskId);
    if (task.status === 'working') {
      const jobId = task.jobId;
      if (!jobId) task = this.store.fail(taskId, { code: ProtocolErrorCode.InternalError, message: 'Task has no linked Forge job; execution was interrupted before launch.' });
      else {
        let detail;
        try {
          const headId = typeof this.context.service.resolveHead === 'function'
            ? this.context.service.resolveHead(jobId)
            : jobId;
          if (headId !== jobId) task = this.store.rebindJob(taskId, headId);
          detail = await this.context.service.detail(headId);
        } catch (err) {
          task = this.store.fail(taskId, { code: ProtocolErrorCode.InternalError, message: `Linked Forge job is unreadable: ${err instanceof Error ? err.message : String(err)}` });
        }
        if (detail) {
          const acceptance = readAcceptance(this.context.service.repo, detail.jobId);
          if (['succeeded', 'failed', 'canceled'].includes(detail.status) && !detail.supersededBy && !('pending' in acceptance && acceptance.pending)) {
            if (detail.status === 'canceled') task = this.store.cancel(taskId);
            else {
              const result = structured(fullStatus(detail, acceptance));
              task = this.store.complete(taskId, { ...result, resultType: 'complete',
                isError: detail.status !== 'succeeded' || acceptance.state === 'rejected',
                _meta: { [TASK_RESULT_META]: true } });
            }
          }
        }
      }
    }
    return GetTaskResultV2Schema.parse({ ...this.base(task), status: task.status, resultType: 'complete',
      ...(task.status === 'completed' ? { result: task.result } : {}),
      ...(task.status === 'failed' ? { error: task.error } : {}) });
  }

  register(server: Server): void {
    // The SDK's public explicit-schema handler API recognizes Tasks methods in
    // this era. Schemas are supplied by the official extension, not a base codec.
    server.setRequestHandler('tasks/get', { params: GetTaskRequestV2Schema.shape.params, result: GetTaskResultV2Schema },
      params => this.get(params.taskId));
    server.setRequestHandler('tasks/update', { params: GetTaskRequestV2Schema.shape.params, result: UpdateTaskResultV2Schema },
      (params, ctx) => {
        const parsed = UpdateTaskRequestV2Schema.shape.params.safeParse({
          ...params, inputResponses: ctx.mcpReq.inputResponses,
        });
        if (!parsed.success || (ctx.mcpReq.droppedInputResponseKeys?.length ?? 0) > 0) {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid params for tasks/update');
        }
        this.require(parsed.data.taskId);
        return { resultType: 'complete' as const };
      });
    server.setRequestHandler('tasks/cancel', { params: CancelTaskRequestV2Schema.shape.params, result: CancelTaskResultV2Schema },
      async params => {
        // Reconcile completion before recording cancellation: a finished worker
        // wins the race and a late cancel never rewrites its frozen result.
        await this.get(params.taskId);
        const task = this.store.requestCancel(params.taskId);
        if (task.status === 'working' && task.jobId) this.context.service.cancel(task.jobId);
        return { resultType: 'complete' as const };
      });
  }
}
