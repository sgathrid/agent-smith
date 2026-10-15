/** Explicit doctor probes. Availability/spawn stay cheap and do not call these. */
import { execFile } from 'node:child_process';

export interface CompatibilityProbe {
  readonly output: string;
  readonly error?: string;
}
export type ProbeCommand = (binary: string, args: readonly string[], timeoutMs: number) => Promise<CompatibilityProbe>;
export interface ProviderCompatibility {
  readonly state: 'compatible' | 'incompatible' | 'unknown';
  readonly version: string | null;
  readonly reason: string;
}

const HELP: Record<string, readonly { args: readonly string[]; flags: readonly string[] }[]> = {
  agy: [{ args: ['--help'], flags: ['--print', '--output-format', '--model', '--effort', '--print-timeout',
    '--add-dir', '--dangerously-skip-permissions', '--conversation'] }],
  codex: [
    { args: ['exec', '--help'], flags: ['--json', '--skip-git-repo-check', '-C', '--model', '-c', '-s',
      '--add-dir', '--dangerously-bypass-approvals-and-sandbox'] },
    { args: ['exec', 'resume', '--help'], flags: ['--json', '--skip-git-repo-check', '--model', '-c',
      '--dangerously-bypass-approvals-and-sandbox'] },
  ],
  claude: [{ args: ['--help'], flags: ['--print', '--output-format', '--verbose', '--forward-subagent-text',
    '--model', '--effort', '--add-dir', '--permission-mode', '--permission-prompts',
    '--dangerously-skip-permissions', '--allowedTools', '--disallowedTools', '--resume', '--bare', '--setting-sources'] }],
  opencode: [{ args: ['run', '--help'], flags: ['--standalone', '--format', '--model', '--auto', '--session'] }],
};

export const probeCommand: ProbeCommand = (binary, args, timeoutMs) => new Promise(resolve => {
  execFile(binary, [...args], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024,
    encoding: 'utf8' }, (error, stdout, stderr) => {
    const output = `${stdout}\n${stderr}`.trim();
    if (!error) { resolve({ output }); return; }
    const lines = stderr.trim().split('\n');
    const detail = lines.find(line => /\b(EPERM|EACCES|ENOENT)\b/.test(line))
      ?? lines.find(line => /error/i.test(line)) ?? error.message.split('\n')[0] ?? 'probe failed';
    resolve({ output, error: error.killed ? `timed out after ${timeoutMs} ms`
      : detail.replace(/\s+/g, ' ').trim().slice(0, 250) });
  });
});

/** Checks the actual CLI surface, never authenticates or submits a prompt. */
export async function checkCompatibility(provider: string, binary: string,
  options: { timeoutMs?: number; probe?: ProbeCommand } = {}): Promise<ProviderCompatibility> {
  const commands = HELP[provider];
  if (commands === undefined) return { state: 'unknown', version: null, reason: 'no adapter compatibility contract' };
  const probe = options.probe ?? probeCommand;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const run = async (args: readonly string[]): Promise<CompatibilityProbe> => {
    try { return await probe(binary, args, timeoutMs); }
    catch (error) { return { output: '', error: error instanceof Error ? error.message : String(error) }; }
  };
  const [versionProbe, ...help] = await Promise.all([run(['--version']), ...commands.map(command => run(command.args))]);
  const version = versionProbe!.error === undefined
    ? versionProbe!.output.split('\n').find(line => /\d+\.\d+\.\d+/.test(line))?.slice(0, 160) ?? null : null;
  const missing: string[] = [];
  const unknown: string[] = [];
  commands.forEach((command, index) => {
    const result = help[index]!;
    const invocation = `${binary} ${command.args.join(' ')}`;
    if (result.error !== undefined) { unknown.push(`${invocation}: ${result.error}`); return; }
    if (result.output.trim() === '') { unknown.push(`${invocation}: empty help output`); return; }
    // Match whole option names; --permission-mode cannot stand in for --permission-prompts.
    const flags = new Set(result.output.match(/--?[A-Za-z][A-Za-z0-9-]*/g) ?? []);
    const absent = command.flags.filter(flag => !flags.has(flag));
    if (absent.length) missing.push(`${invocation}: missing ${absent.join(', ')}`);
  });
  if (missing.length) return { state: 'incompatible', version, reason: missing.join('; ')
    + (provider === 'claude' && missing.some(reason => reason.includes('--permission-prompts'))
      ? '; --permission-prompts requires Claude Code >=2.1.259; update the configured binary' : '; update the configured binary to support the adapter flags') };
  if (versionProbe!.error !== undefined) unknown.push(`${binary} --version: ${versionProbe!.error}`);
  if (version === null && versionProbe!.error === undefined) unknown.push(`${binary} --version: unrecognized or empty version output`);
  if (unknown.length) return { state: 'unknown', version, reason: unknown.join('; ') };
  return { state: 'compatible', version, reason: 'adapter flags present; authentication and model execution not checked' };
}
