/**
 * notices.spawn.test.ts — runNdjsonWorker notices reach events.jsonl, not just the bus.
 *
 * Non-JSON stdout lines, stderr chunks and agy's recovered-run notice all go
 * through `publish`, so each must appear on the live event stream AND as a
 * record in <stateDir>/events.jsonl. One fake binary serves every adapter; the
 * env vars are assigned BEFORE the dynamic imports because each adapter
 * captures its binary path at module scope.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Provider, ProviderEvent } from './types.ts';

const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'agent-smith-notice-fixture-'));
const fixtureScript = path.join(fixtureDir, 'fake-worker.mjs');
const fixtureBinary = path.join(fixtureDir, 'fake-worker');

writeFileSync(fixtureScript, `
const scenario = process.env.NOTICE_FIXTURE_SCENARIO ?? 'plain';
const out = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
if (scenario === 'stdout') process.stdout.write('FIXTURE BANNER not json\\n');
if (scenario === 'stderr') process.stderr.write('fixture stderr chatter\\n');
if (scenario === 'agy-recovered') {
  out({ event: 'init', init: { model: 'm', conversation_id: 'c1' } });
  out({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 1, state: 'DONE', step_type: 'error_message' } });
  out({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'Done.' } });
  out({ event: 'result', result: { conversation_id: 'c1', status: 'ERROR', response: 'Done.', error: 'API error (attempt 3): RESOURCE_EXHAUSTED (code 429): quota' } });
}
`);
writeFileSync(fixtureBinary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixtureScript)} "$@"\n`);
chmodSync(fixtureBinary, 0o755);

for (const name of ['AGY', 'CODEX', 'CLAUDE', 'OPENCODE']) process.env[`AGENT_SMITH_${name}_BIN`] = fixtureBinary;
const { agyProvider } = await import('./agy.ts');
const { codexProvider } = await import('./codex.ts');
const { claudeProvider } = await import('./claude.ts');
const { opencodeProvider } = await import('./opencode.ts');

const dirs: string[] = [];
test.after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function run(provider: Provider, scenario: string): Promise<{ live: ProviderEvent[]; persisted: ProviderEvent[] }> {
  process.env['NOTICE_FIXTURE_SCENARIO'] = scenario;
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-smith-notice-state-'));
  dirs.push(stateDir);
  const handle = await provider.spawn({
    mode: 'implement',
    prompt: 'do the thing',
    cwd: fixtureDir,
    timeoutMs: 10_000,
    unrestricted: true,
    stateDir,
  });
  const live: ProviderEvent[] = [];
  for await (const event of handle.events) live.push(event);
  await handle.waitForResult();
  const persisted = readFileSync(path.join(stateDir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as ProviderEvent);
  return { live, persisted };
}

const notices = (events: ProviderEvent[], re: RegExp) =>
  events.filter((e) => e.kind === 'notice' && re.test(e.message));

const adapters: Array<[string, Provider]> = [
  ['agy', agyProvider],
  ['codex', codexProvider],
  ['claude', claudeProvider],
  ['opencode', opencodeProvider],
];

for (const [name, provider] of adapters) {
  test(`${name}: a non-JSON stdout line is a warn notice on the bus and in events.jsonl`, async () => {
    const { live, persisted } = await run(provider, 'stdout');
    for (const events of [live, persisted]) {
      const found = notices(events, /stdout \(non-JSON\): FIXTURE BANNER not json/);
      assert.equal(found.length, 1);
      assert.equal(found[0]!.kind === 'notice' && found[0]!.level, 'warn');
    }
  });

  test(`${name}: a stderr chunk is a notice on the bus and in events.jsonl`, async () => {
    const { live, persisted } = await run(provider, 'stderr');
    assert.equal(notices(live, /fixture stderr chatter/).length, 1);
    assert.equal(notices(persisted, /fixture stderr chatter/).length, 1);
  });
}

test('agy: the recovered-run notice (afterResult) is persisted to events.jsonl as well as emitted', async () => {
  const { live, persisted } = await run(agyProvider, 'agy-recovered');
  for (const events of [live, persisted]) {
    const found = notices(events, /^recovered: 429 resource exhausted/);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.kind === 'notice' && found[0]!.level, 'warn');
  }
});
