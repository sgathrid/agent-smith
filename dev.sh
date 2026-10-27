#!/usr/bin/env bash
# Session-scoped Agent Smith launch. Does not modify ~/.claude or install plugins.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$PWD"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --help)
      echo 'Usage: /path/to/agent-smith/dev.sh [--repo /path/to/workspace] [Claude flags]'
      echo 'MCP tools and /forge are always loaded.'
      exit 0 ;;
    *) break ;;
  esac
done
REPO="$(cd "$REPO" && pwd)"
[[ -f "$HERE/the-codes/surfaces/channel/dist/server.js" ]] || {
  echo 'Build Agent Smith first: npm install && npm run build' >&2
  exit 1
}
MCP_CONFIG="$(node --input-type=module - "$HERE" "$REPO" <<'JS'
const [root, repo] = process.argv.slice(2);
console.log(JSON.stringify({mcpServers:{'agent-smith':{command:process.execPath,args:[`${root}/the-codes/surfaces/channel/dist/server.js`],env:{AGY_WATCH_CWD:repo}}}}));
JS
)"
ARGS=(--plugin-dir "$HERE/the-codes/surfaces/mod" --mcp-config "$MCP_CONFIG")
cd "$REPO"
exec claude "${ARGS[@]}" "$@"
