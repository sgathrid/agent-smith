import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkCompatibility, probeCommand, type ProbeCommand } from './compatibility.ts';

const help = {
  agy: '--print --output-format --model --effort --print-timeout --add-dir --dangerously-skip-permissions --conversation',
  codex: '--json --skip-git-repo-check -C --model -c -s --add-dir --dangerously-bypass-approvals-and-sandbox',
  claude: '--print --output-format --verbose --forward-subagent-text --model --effort --add-dir --permission-mode --permission-prompts --dangerously-skip-permissions --allowedTools --disallowedTools --resume --bare --setting-sources',
  opencode: '--standalone --format --model --auto --session',
};
const fakeProbe = (provider: keyof typeof help): ProbeCommand => async (_binary, args) =>
  ({ output: args[0] === '--version' ? `${provider} 9.0.0` : help[provider] });

for (const provider of Object.keys(help) as (keyof typeof help)[]) {
  test(`doctor recognizes ${provider} adapter flags from bounded version and help commands`, async () => {
    const calls: string[][] = [];
    const probe: ProbeCommand = async (binary, args, timeout) => {
      assert.equal(binary, '/configured/binary');
      assert.equal(timeout, 123);
      calls.push([...args]);
      return fakeProbe(provider)(binary, args, timeout);
    };
    const result = await checkCompatibility(provider, '/configured/binary', { probe, timeoutMs: 123 });
    assert.equal(result.state, 'compatible');
    assert.equal(result.version, `${provider} 9.0.0`);
    assert.deepEqual(calls, provider === 'codex'
      ? [['--version'], ['exec', '--help'], ['exec', 'resume', '--help']]
      : [['--version'], ...(provider === 'opencode' ? [['run', '--help']] : [['--help']])]);
  });
}

test('Claude missing permission-prompts names the flag and known minimum version', async () => {
  const result = await checkCompatibility('claude', 'old-claude', { probe: async (_binary, args) =>
    ({ output: args[0] === '--version' ? '2.1.200' : help.claude.replace('--permission-prompts', '') }) });
  assert.equal(result.state, 'incompatible');
  assert.match(result.reason, /missing --permission-prompts/);
  assert.match(result.reason, />=2\.1\.259/);
  assert.equal(result.version, '2.1.200');
});

test('Codex resume help is checked separately from exec help', async () => {
  const result = await checkCompatibility('codex', 'codex', { probe: async (_binary, args) =>
    ({ output: args[0] === '--version' ? 'codex 0.1' : args.includes('resume') ? '--json --model' : help.codex }) });
  assert.equal(result.state, 'incompatible');
  assert.match(result.reason, /codex exec resume --help: missing --skip-git-repo-check, -c/);
});

test('OpenCode requires both standalone and auto with whole flag boundaries', async () => {
  const result = await checkCompatibility('opencode', 'opencode', { probe: async (_binary, args) =>
    ({ output: args[0] === '--version' ? '2.0.0' : '--standalone-other --auto-approve --format --model --session' }) });
  assert.equal(result.state, 'incompatible');
  assert.match(result.reason, /missing --standalone, --auto/);
});

for (const phase of ['--version', '--help']) {
  test(`${phase} timeout remains unknown even with other successful probes`, async () => {
    const result = await checkCompatibility('agy', 'agy', { probe: async (binary, args, timeout) =>
      args.includes(phase) ? { output: help.agy, error: 'timed out after 100 ms' } : fakeProbe('agy')(binary, args, timeout) });
    assert.equal(result.state, 'unknown');
    assert.match(result.reason, /timed out/);
  });
}

test('empty or throwing help probes are unknown', async () => {
  for (const probe of [async () => ({ output: '' }), async () => { throw new Error('probe failed'); }]) {
    assert.equal((await checkCompatibility('agy', 'agy', { probe })).state, 'unknown');
  }
});

test('real subprocess help/version probes never send a model prompt', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'compatibility-'));
  const binary = path.join(dir, 'fake-opencode');
  writeFileSync(binary, `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args.join(' ') === '--version') console.log('opencode 2.0.24');\nelse if (args.join(' ') === 'run --help') console.log(${JSON.stringify(help.opencode)});\nelse process.exit(9);\n`);
  chmodSync(binary, 0o755);
  assert.equal((await checkCompatibility('opencode', binary)).state, 'compatible');
});

test('real subprocess timeout is bounded and cannot be a compatible result', async () => {
  const result = await probeCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 50);
  assert.match(result.error ?? '', /timed out after 50 ms/);
});

test('version diagnostics ignore startup warnings and reject an unrelated successful response', async () => {
  const good = await checkCompatibility('codex', 'codex', { probe: async (_binary, args) =>
    ({ output: args[0] === '--version' ? 'Warning: config ignored\ncodex-cli 0.162.1' : help.codex }) });
  assert.equal(good.version, 'codex-cli 0.162.1');
  const unrelated = await checkCompatibility('agy', 'agy', { probe: async (_binary, args) =>
    ({ output: args[0] === '--version' ? 'Successfully installed plugin' : help.agy }) });
  assert.equal(unrelated.state, 'unknown');
  assert.match(unrelated.reason, /unrecognized or empty version/);
});

test('CLI doctor reports adapter compatibility using the configured binaries', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'compatibility-doctor-'));
  const binary = path.join(dir, 'fake-provider');
  writeFileSync(binary, `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args.join(' ') === '--version') console.log('fake 9.0.0');\nelse if (args.at(-1) === '--help') console.log(${JSON.stringify(Object.values(help).join(' '))});\nelse process.exit(9);\n`);
  chmodSync(binary, 0o755);
  const env = { ...process.env };
  for (const name of ['AGY', 'CODEX', 'CLAUDE', 'OPENCODE']) env[`AGENT_SMITH_${name}_BIN`] = binary;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/agent-smith.mjs', import.meta.url)), 'doctor'],
    { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /adapter feature compatibility/);
  for (const provider of Object.keys(help)) assert.match(result.stdout, new RegExp(`${provider} +compatible`));
});
