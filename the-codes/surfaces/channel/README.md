# Agent Smith MCP server

This server is the control surface for the forge runtime. It directly launches
external harnesses.

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
      "args": ["/abs/path/to/agent-smith/the-codes/surfaces/channel/dist/server.js", "/abs/path/to/workspace"]
    }
  }
}
```

Tools: `list_capabilities`, `spawn_job`, `follow_up`, `steer`, `list_jobs`, `status`, `cancel`,
`run_pipeline`, `pipeline_status`. All launch tools return immediately. Errors use MCP `isError`.
Schema validation rejects malformed settings before execution.

The runtime uses the official MCP TypeScript SDK v2 (`server` and `core` 2.3.1).
Its stdio dispatcher serves the 2026-07-28 protocol and legacy clients through
the same Forge handlers. Setting `AGENT_SMITH_TASKS=1` enables the opt-in 2026-07-28
MCP Tasks (`io.modelcontextprotocol/tasks`) receiver for `spawn_job` and
`follow_up` when a modern request advertises client Tasks support; otherwise
launch results stay ordinary tool-result data.

The server resolves the workspace from an explicit positional argument, then its
process cwd. stdout is exclusively MCP JSON-RPC; logs go
to stderr. Completion notices come from the mod and the job-scoped watch hook, not
the server.

Address a worker by its name or any turn's `jobId`. `follow_up` sends the next
message without cutting the current turn: on a running Claude worker, plain
messages are written to stdin and read at the next tool round
(`delivery: "next-step"`); on other providers (or with overrides, `files`, or
`context`), they run when the current turn ends (`delivery: "turn-end"`); on an
idle worker, a new turn starts immediately (`delivery: "now"`). Queued messages
are delivered whatever the turn's outcome. Only `cancel` discards them, and it
reports the `discarded` count. `steer` interrupts an in-flight turn or running
checks to redirect the worker immediately. Both preserve the worker's identity
and native conversation handle.

`status` and `cancel` take a worker name (resolving to the worker's latest turn)
or a `jobId` (resolving to that exact turn, following only steer replacements).
Ambiguous names resolve running workers first, then this session's latest
worker, then a unique match, else return an error listing the candidates.

`env` values live only in the server's memory for the session and are never
written to disk. `follow_up` acks report `env: "set" | "kept" | "dropped"`
(omitted when the worker never had `env`).

In 0.5.0, `resume_job` and `steer_job` were removed. Update any Claude Code
permission allowlist entries from
`mcp__plugin_agent-smith_agent-smith__resume_job` and
`mcp__plugin_agent-smith_agent-smith__steer_job` to
`mcp__plugin_agent-smith_agent-smith__follow_up` and
`mcp__plugin_agent-smith_agent-smith__steer`.
