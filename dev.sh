#!/usr/bin/env bash
# Run Claude Code in THIS repo with the agent-smith mod loaded for the session
# only. Nothing is installed globally, nothing is written to ~/.claude.
#
#   ./dev.sh              start a session with the mod
#   ./dev.sh --radar      start, then run /agy-radar straight away
#
# The mod is loaded via --plugin-dir, which Claude Code documents as
# "load a plugin from a directory ... for this session only". That is the
# difference between testing and installing: no marketplace, no cache, no
# entry in ~/.claude/plugins. Delete this repo's .claude dir and you are clean.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOD="$HERE/the-codes/surfaces/mod"

# Fail loudly rather than starting a session that silently has no mod.
if [[ ! -f "$MOD/.claude-plugin/plugin.json" ]]; then
  echo "error: no plugin at $MOD" >&2
  exit 1
fi

# The mod reads <repo>/.agy-staff/jobs. agent-smith has no jobs of its own, so
# point it at seeded state under .agy-staff/ (git-ignored) or at a real repo by
# setting AGY_SMITH_STATE_SRC.
if [[ -n "${AGY_SMITH_STATE_SRC:-}" ]]; then
  ln -sfn "$AGY_SMITH_STATE_SRC" "$HERE/.agy-staff"
  echo "state → $AGY_SMITH_STATE_SRC (symlink)"
fi

echo "mod   → $MOD"
echo "state → $(readlink "$HERE/.agy-staff" 2>/dev/null || echo "$HERE/.agy-staff")"
echo

exec claude --plugin-dir "$MOD" "$@"