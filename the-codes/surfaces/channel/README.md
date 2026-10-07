# Agent Smith MCP and channel

This server is the control surface for the forge runtime. It directly launches
external harnesses; it does not invoke agy-staff. The optional channel sends
completion and attention changes with bounded worker-authored output excerpts.

Build from the repository root with `npm run build`. TypeScript errors fail the
build; the executable entrypoint is `dist/server.js`.

The session-scoped launcher loads both the server and the UI:

```sh
/path/to/agent-smith/dev.sh --repo /path/to/workspace
/path/to/agent-smith/dev.sh --repo /path/to/workspace --channels
```

For manual MCP configuration:

```json
{
  "mcpServers": {
    "agent-smith": {
      "command": "node",
      "args": ["/abs/path/to/agent-smith/the-codes/surfaces/channel/dist/server.js"],
      "env": { "AGY_WATCH_CWD": "/abs/path/to/workspace" }
    }
  }
}
```

Tools: `spawn_job`, `resume_job`, `list_jobs`, `status`, `cancel`, `run_pipeline`,
`pipeline_status`. All launch tools return immediately. Errors use MCP `isError`.
Schema validation rejects malformed settings before execution.

Custom development channels require
`--dangerously-load-development-channels server:agent-smith`. Organization policy
may disable channel delivery; MCP execution and status tools remain useful without
notifications. Do not treat a connected MCP server as proof of channel delivery.

The server resolves the workspace from an explicit positional argument, then
`AGY_WATCH_CWD`, then its process cwd. stdout is exclusively MCP JSON-RPC; logs go
to stderr. State transitions are deduplicated after successful delivery, and the
initial poll is a silent baseline. Progress ticks never enter Claude's context.

Follow-up messages use the worker's native conversation handle and preserve its
stable identity. They start a new invocation; these CLI adapters do not steer a
running turn. Ambiguous worker names require a job ID.
