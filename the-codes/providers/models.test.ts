import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildArgv as agyArgv, listAgyModels, parseAgyModels, agyProvider } from './agy.ts';
import { buildArgv as codexArgv, listCodexModels, parseCodexModels, parseTomlTopLevel, codexProvider } from './codex.ts';
import { buildArgv as claudeArgv, listClaudeModels, claudeProvider } from './claude.ts';
import { buildArgv as opencodeArgv, listOpencodeModels, opencodeProvider } from './opencode.ts';
import { getCatalogs, resetCatalogCacheForTest } from './catalog.ts';
import type { RunFn } from './discovery.ts';
import type { ModelCatalog, Provider, SpawnSpec } from './types.ts';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'as-models-'));
  dirs.push(d);
  return d;
};
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  resetCatalogCacheForTest();
});

const spec = (o: Partial<SpawnSpec> = {}): SpawnSpec => ({
  mode: 'implement', prompt: 'p', cwd: '/tmp', timeoutMs: 5000, unrestricted: false, ...o,
});
const ok = (stdout: string): RunFn => async () => ({ stdout });

const AGY_OUT = `Fetching available models...
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)
gemini-3.1-pro-low\tGemini 3.1 Pro (Low)
gemini-3.1-pro-high\tGemini 3.1 Pro (High)
`;

test('agy models group into base ids with efforts', async () => {
  const m = parseAgyModels(AGY_OUT);
  assert.deepEqual(m.map((x) => x.id), ['gemini-3.8-flash', 'gemini-3.1-pro']);
  assert.deepEqual(m[0]!.efforts, ['low', 'medium', 'high']);
  assert.deepEqual(m[1]!.efforts, ['low', 'high']);
  assert.equal(m[0]!.label, 'Gemini 3.8 Flash');
  const cat = await listAgyModels(ok(AGY_OUT));
  assert.equal(cat.defaultSource, 'unknown');
  assert.equal(cat.error, undefined);
  const bad = await listAgyModels(async () => ({ stdout: '', error: 'boom' }));
  assert.equal(bad.error, 'boom');
  const throwing = await listAgyModels(async () => { throw new Error('x'); });
  assert.equal(throwing.error, 'x');
});

test('agy spawn composes <base>-<effort> and keeps suffixed ids working', () => {
  const a = agyArgv(spec({ model: 'gemini-3.8-flash', effort: 'high' }));
  assert.equal(a[a.indexOf('--model') + 1], 'gemini-3.8-flash-high');
  assert.ok(!a.includes('--effort'));
  const b = agyArgv(spec({ model: 'gemini-3.8-flash-high', effort: 'high' }));
  assert.equal(b[b.indexOf('--model') + 1], 'gemini-3.8-flash-high');
  assert.ok(!b.includes('--effort'));
  assert.throws(() => agyArgv(spec({ model: 'gemini-3.8-flash-low', effort: 'high' })), /conflicting/);
  const c = agyArgv(spec({ model: 'gemini-3.8-flash', effort: 'max' }));
  assert.equal(c[c.indexOf('--model') + 1], 'gemini-3.8-flash');
  assert.equal(c[c.indexOf('--effort') + 1], 'max');
});

const CODEX_JSON = JSON.stringify({
  identity: { secret: 'nope' },
  models: [
    { slug: 'gpt-6', display_name: 'GPT 6', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'ultra' }] },
    { slug: 'gpt-mini', supported_reasoning_levels: [] },
  ],
});

test('codex parses models, drops identity, reads config defaults', async () => {
  const m = parseCodexModels(CODEX_JSON)!;
  assert.equal(JSON.stringify(m).includes('nope'), false);
  assert.deepEqual(m[0], { id: 'gpt-6', label: 'GPT 6', efforts: ['low', 'medium', 'ultra'], defaultEffort: 'medium' });
  assert.equal(parseCodexModels('not json'), undefined);
  const home = tmp();
  writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6"\nmodel_reasoning_effort = "high" # c\n[profiles.x]\nmodel = "other"\n');
  assert.deepEqual(parseTomlTopLevel('model = "a"\n[t]\nmodel="b"'), { model: 'a' });
  const cat = await listCodexModels(ok(CODEX_JSON), undefined, home);
  assert.equal(cat.defaultModel, 'gpt-6');
  assert.equal(cat.defaultEffort, 'high');
  assert.equal(cat.defaultSource, 'harness-config');
  assert.equal(cat.source, 'live');
});

test('codex falls back to models_cache.json when the CLI fails', async () => {
  const home = tmp();
  writeFileSync(path.join(home, 'models_cache.json'), CODEX_JSON);
  const cat = await listCodexModels(async () => ({ stdout: '', error: 'no codex' }), undefined, home);
  assert.equal(cat.source, 'cache');
  assert.equal(cat.models.length, 2);
  assert.equal(cat.defaultSource, 'unknown');
  const none = await listCodexModels(async () => ({ stdout: '', error: 'no codex' }), undefined, tmp());
  assert.equal(none.models.length, 0);
  assert.equal(none.error, 'no codex');
});

test('opencode: parses provider/model lines; empty output is an informative error', async () => {
  const cat = await listOpencodeModels(ok('anthropic/claude-x\nopenai/gpt-5\nanthropic/claude-x\n'));
  assert.deepEqual(cat.models.map((m) => m.id), ['anthropic/claude-x', 'openai/gpt-5']);
  assert.equal(cat.verified, false);
  const empty = await listOpencodeModels(ok(''));
  assert.equal(empty.models.length, 0);
  assert.match(empty.error!, /no recognizable models/);
});

test('claude: static aliases, default from settings.json', async () => {
  const home = tmp();
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ model: 'opus' }));
  const cat = await listClaudeModels(undefined, home);
  assert.deepEqual(cat.models.map((m) => m.id), ['fable', 'opus', 'sonnet', 'haiku']);
  assert.equal(cat.source, 'static');
  assert.equal(cat.defaultModel, 'opus');
  assert.equal(cat.defaultSource, 'harness-config');
  const none = await listClaudeModels(undefined, tmp());
  assert.equal(none.defaultSource, 'unknown');
  writeFileSync(path.join(home, 'settings.json'), '{bad');
  assert.match((await listClaudeModels(undefined, home)).error!, /settings\.json/);
});

test('codex sandbox: readOnly, unrestricted, default, resume, env override', () => {
  const saved = process.env['AGENT_SMITH_CODEX_SANDBOX'];
  delete process.env['AGENT_SMITH_CODEX_SANDBOX'];
  try {
    const ro = codexProvider.describeSandbox!({ unrestricted: false, readOnly: true });
    assert.deepEqual(ro.flags, ['-s', 'read-only']);
    assert.equal(ro.readOnlyEnforced, true);
    const ws = codexProvider.describeSandbox!({ unrestricted: false });
    assert.deepEqual(ws.flags, ['-s', 'workspace-write']);
    assert.equal(ws.readOnlyEnforced, false);
    const un = codexProvider.describeSandbox!({ unrestricted: true, readOnly: true });
    assert.deepEqual(un.flags, ['--dangerously-bypass-approvals-and-sandbox']);
    assert.equal(un.readOnlyEnforced, false);
    // describeSandbox flags are literally in argv
    const argv = codexArgv(spec({ readOnly: true }));
    assert.equal(argv[argv.indexOf('-s') + 1], 'read-only');
    const resumed = codexArgv(spec({ readOnly: true, conversation: 't1' }));
    assert.ok(resumed.includes('sandbox_mode="read-only"'));
    assert.ok(!resumed.includes('-s'));
    process.env['AGENT_SMITH_CODEX_SANDBOX'] = 'danger-full-access';
    const env = codexArgv(spec({ readOnly: true }));
    assert.equal(env.filter((a) => a === '-s').length, 1);
    assert.equal(env[env.indexOf('-s') + 1], 'danger-full-access');
    assert.deepEqual(codexProvider.describeSandbox!({ unrestricted: false, readOnly: true }).flags, ['-s', 'danger-full-access']);
  } finally {
    if (saved === undefined) delete process.env['AGENT_SMITH_CODEX_SANDBOX'];
    else process.env['AGENT_SMITH_CODEX_SANDBOX'] = saved;
  }
});

test('agy/opencode/claude describeSandbox matches argv and never claims read-only', () => {
  for (const [p, build] of [[agyProvider, agyArgv], [opencodeProvider, opencodeArgv], [claudeProvider, claudeArgv]] as const) {
    for (const unrestricted of [false, true]) {
      const s = { unrestricted, readOnly: true };
      const info = p.describeSandbox!(s);
      assert.equal(info.readOnlyEnforced, false);
      const argv = build(spec(s));
      const at = info.flags.length === 0 ? 0 : argv.indexOf(info.flags[0]!);
      assert.ok(at >= 0, `${p.name} flags in argv`);
      assert.deepEqual(argv.slice(at, at + info.flags.length), info.flags);
    }
  }
  assert.deepEqual(claudeProvider.describeSandbox!({ unrestricted: false }).flags, ['--permission-mode', 'dontAsk', '--permission-prompts', 'none']);
  assert.deepEqual(agyProvider.describeSandbox!({ unrestricted: false }).flags, []);
});

// ---- catalog ----

function fakeProvider(name: string, impl: () => Promise<ModelCatalog>, available = true): Provider & { calls: number } {
  const p = {
    name, calls: 0,
    available: async () => available,
    spawn: async () => { throw new Error('unused'); },
    listModels: async () => { p.calls++; return impl(); },
  };
  return p as unknown as Provider & { calls: number };
}
const good = (name: string): ModelCatalog => ({
  provider: name, models: [{ id: 'm', label: 'm', efforts: [] }], defaultSource: 'unknown', source: 'live', stale: false, verified: true,
});

test('catalog: TTL cache, refresh bypass, availability filter', async () => {
  let t = 1000;
  const a = fakeProvider('a', async () => good('a'));
  const b = fakeProvider('b', async () => good('b'), false);
  resetCatalogCacheForTest({ now: () => t, providers: () => [a, b] });
  let r = await getCatalogs();
  assert.deepEqual(r.map((c) => c.provider), ['a']);
  assert.equal(r[0]!.source, 'live');
  r = await getCatalogs();
  assert.equal(a.calls, 1);
  assert.equal(r[0]!.source, 'cache');
  await getCatalogs({ refresh: true });
  assert.equal(a.calls, 2);
  t += 5 * 60_000 + 1;
  await getCatalogs();
  assert.equal(a.calls, 3);
  r = await getCatalogs({ providers: ['b'] });
  assert.equal(r[0]!.provider, 'b');
  r = await getCatalogs({ providers: ['nope'] });
  assert.match(r[0]!.error!, /unknown provider/);
});

test('catalog: stale-on-error and isolation of failing providers', async () => {
  let fail = false;
  const a = fakeProvider('a', async () => {
    if (fail) throw new Error('down');
    return good('a');
  });
  const c = fakeProvider('c', async () => ({ ...good('c'), models: [], error: 'cli missing' }));
  resetCatalogCacheForTest({ providers: () => [a, c] });
  await getCatalogs();
  fail = true;
  const r = await getCatalogs({ refresh: true });
  const ra = r.find((x) => x.provider === 'a')!;
  assert.equal(ra.stale, true);
  assert.equal(ra.error, 'down');
  assert.equal(ra.models.length, 1);
  const rc = r.find((x) => x.provider === 'c')!;
  assert.equal(rc.error, 'cli missing');
  assert.equal(rc.stale, false);
  // a never-good provider that throws gives an error catalog, not a rejection
  const d = fakeProvider('d', async () => { throw new Error('kaboom'); });
  resetCatalogCacheForTest({ providers: () => [d] });
  const rd = await getCatalogs();
  assert.equal(rd[0]!.error, 'kaboom');
});
