# Agent Smith MCP server

This server is the control surface for the forge runtime. It directly launches
external harnesses; it does not invoke agy-staff.

Build from the repository root with `npm run build`. TypeScript errors fail the
build; the executable entrypoint is `dist/server.js`.

The session-scoped launcher loads both the server and the UI:

```sh
/path/to/agent-smith/dev.sh --repo /path/to/workspace
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

Tools: `list_capabilities`, `spawn_job`, `resume_job`, `list_jobs`, `status`, `cancel`,
`run_pipeline`, `pipeline_status`. All launch tools return immediately. Errors use MCP `isError`.
Schema validation rejects malformed settings before execution.

The runtime uses the official MCP TypeScript SDK v2 (`server` and `core` 2.3.1).
Its stdio dispatcher serves the 2026-07-28 protocol and legacy clients through
the same Forge handlers. Setting `AGENT_SMITH_TASKS=1` enables the opt-in 2026-07-28
MCP Tasks (`io.modelcontextprotocol/tasks`) receiver for `spawn_job` and
`resume_job` when a modern request advertises client Tasks support; otherwise
launch `taskHandle` fields remain ordinary tool-result data.

The server resolves the workspace from an explicit positional argument, then
`AGY_WATCH_CWD`, then its process cwd. stdout is exclusively MCP JSON-RPC; logs go
to stderr. Completion notices come from the mod and the job-scoped watch hook, not
the server.

Follow-up messages use the worker's native conversation handle and preserve its
stable identity. They start a new invocation; these CLI adapters do not steer a
running turn. Ambiguous worker names require a job ID.
