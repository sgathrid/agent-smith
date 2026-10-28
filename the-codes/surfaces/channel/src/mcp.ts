/** Shared tool handlers, served by the SDK's modern/legacy stdio dispatcher. */
import { randomBytes } from 'node:crypto';
import {
  Server, createRequestStateCodec, inputRequired,
  type CallToolResult, type InputRequiredResult, type ElicitResult, type ClientCapabilities, type Tool,
  type JSONRPCRequest, type ServerContext, type Result,
} from '@modelcontextprotocol/server';
import { TOOL_DEFS, callTool, type HandlerContext } from './tools.ts';
import { ForgeTasks, TASKS_EXTENSION_ID_V2 } from './tasks.ts';
import { hasTaskClientCapabilityV2 } from '@modelcontextprotocol/ext-tasks/core/v2';

// The SDK adds `content: []` to every tools/call result after our handler
// returns, so a task handle can only be stripped here. `_wrapHandler` is
// protected API: the SDK is pinned exactly, and tasks.test.ts fails if a bump
// stops this override from running.
class SmithServer extends Server {
  protected override _wrapHandler(
    method: string,
    handler: (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result>,
  ): (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result> {
    const wrapped = super._wrapHandler(method, handler);
    if (method !== 'tools/call') return wrapped;
    return async (request, ctx) => {
      const result = await wrapped(request, ctx);
      if (result['resultType'] === 'task') {
        const { content: _content, ...task } = result;
        return task;
      }
      return result;
    };
  }
}

export function createSmithServer(context: Omit<HandlerContext, 'server'>, options: {
  era: 'legacy' | 'modern'; instructions?: string; tasks?: boolean;
}): Server {
  // Stdio runs every round in this process. Bind approval to the exact call;
  // clients cannot forge approval state or reuse it with broader arguments.
  const state = createRequestStateCodec<{ call: string; prompt: string }>({ key: randomBytes(32) });
  const tasks = options.era === 'modern' && (options.tasks ?? process.env['AGENT_SMITH_TASKS'] === '1') ? new ForgeTasks(context) : undefined;
  const server = new SmithServer({ name: 'agent-smith', version: '0.2.0' }, {
    capabilities: {
      tools: {},
      ...(tasks ? { extensions: { [TASKS_EXTENSION_ID_V2]: {} } } : {}),
    },
    instructions: options.instructions,
    requestState: { verify: state.verify },
  });
  tasks?.register(server);
  server.setRequestHandler('tools/list', async () => ({ tools: TOOL_DEFS as unknown as Tool[] }));
  server.setRequestHandler('tools/call', async (request, ctx) => {
    if (options.era === 'legacy') return callTool({ ...context, server }, request.params.name, request.params.arguments ?? {});
    let pending: InputRequiredResult | undefined;
    const call = JSON.stringify([request.params.name, request.params.arguments ?? {}]);
    const facade: HandlerContext['server'] = {
      getClientCapabilities: () => (ctx.mcpReq.envelope as Record<string, ClientCapabilities> | undefined)?.['io.modelcontextprotocol/clientCapabilities'],
      async elicitInput(params) {
        const saved = ctx.mcpReq.requestState<{ call: string; prompt: string }>();
        const answer = ctx.mcpReq.inputResponses?.['unrestricted'] as Partial<ElicitResult> | undefined;
        if (saved?.call === call && saved.prompt === JSON.stringify(params) && answer && ['accept', 'decline', 'cancel'].includes(answer.action ?? '')) {
          return { action: answer.action! };
        }
        pending = inputRequired({
          inputRequests: { unrestricted: params.mode === 'url' ? inputRequired.elicitUrl(params) : inputRequired.elicit(params) },
          requestState: await state.mint({ call, prompt: JSON.stringify(params) }),
        });
        // Stop the existing launch gate; the response below carries the request
        // for input. No worker launches until a validated round returns accept.
        return { action: 'cancel' };
      },
    };
    const taskCapable = tasks && ['spawn_job', 'resume_job'].includes(request.params.name) &&
      hasTaskClientCapabilityV2({ _meta: ctx.mcpReq.envelope });
    const result = taskCapable
      ? await tasks.launch({ ...context, server: facade }, request.params.name, request.params.arguments ?? {})
      : await callTool({ ...context, server: facade }, request.params.name, request.params.arguments ?? {});
    return (pending ?? result) as CallToolResult | InputRequiredResult;
  });
  return server;
}
