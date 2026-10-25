/** Build the isolated server environment, dropping only known fixture binaries. */
export function buildSmokeServerEnv(source, { repo, stateDir, fixtureBins = [] }) {
  const env = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined));
  const fixturePaths = new Set(fixtureBins);
  for (const name of ['AGENT_SMITH_AGY_BIN', 'AGENT_SMITH_CODEX_BIN', 'AGENT_SMITH_OPENCODE_BIN', 'AGENT_SMITH_CLAUDE_BIN', 'AGENT_SMITH_KIMI_BIN']) {
    if (fixturePaths.has(env[name])) delete env[name];
  }
  env.AGY_WATCH_CWD = repo;
  env.AGENT_SMITH_STATE_DIR = stateDir;
  return env;
}
