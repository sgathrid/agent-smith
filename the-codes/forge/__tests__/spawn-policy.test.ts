/**
 * spawn-policy.test.ts — closed modes, preamble, read-only, model recording,
 * catalog validation and the agy preflight, all with injected fakes.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { JobResult, ModelCatalog, Provider, SpawnSpec } from '../../providers/types.ts';
import { MODE_PRESETS } from '../modes.ts';
import { ForgeService } from '../service.ts';

interface Fake {
  provider: Provider;
  specs: SpawnSpec[];
}

function fakeProvider(name: string, withSandbox = true): Fake {
  const specs: SpawnSpec[] = [];
  const result = { status: 'SUCCESS', exitCode: 0, text: 'ok' } as unknown as JobResult;
  const provider = {
    name,
    spawn: async (spec: SpawnSpec) => {
      specs.push(spec);
      return { cancel() {}, onEvent: () => () => {}, waitForResult: async () => result };
    },
    ...(withSandbox
      ? {
          describeSandbox: (s: { unrestricted: boolean; readOnly?: boolean }) => ({
            sandbox: `fake ${s.readOnly ? 'ro' : 'rw'}`,
            flags: s.readOnly ? ['--ro'] : [],
            readOnlyEnforced: s.readOnly === true,
          }),
        }
      : {}),
  } as unknown as Provider;
  return { provider, specs };
}

function catalog(over: Partial<ModelCatalog> = {}): ModelCatalog {
  return {
    provider: 'fake',
    models: [
      { id: 'm1', label: 'M1', efforts: ['low', 'high'] },
      { id: 'm2', label: 'M2', efforts: [] },
    ],
    defaultSource: 'unknown',
    source: 'live',
    stale: false,
    verified: true,
    ...over,
  };
}

function svc(
  fake: Fake,
  cat?: ModelCatalog | (() => Promise<ModelCatalog[]>),
  harnessDefaults: (provider: string) => { model?: string } = () => ({}),
) {
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-policy-'));
  const service = new ForgeService({
    repo,
    mirror: false,
    flushMs: 1,
    providerSource: () => fake.provider,
    catalogSource: typeof cat === 'function' ? cat : async () => (cat === undefined ? [] : [cat]),
    harnessDefaults,
  });
  return { service, repo };
}

test('closed mode: blank and unknown modes throw a teaching error', async () => {
  const { service } = svc(fakeProvider('fake'));
  for (const mode of ['', 'task', 'banana']) {
    await assert.rejects(service.spawnJob({ mode, prompt: 'x' }), (e: Error) => {
      assert.match(e.message, /Valid modes/);
      assert.ok(e.message.includes(MODE_PRESETS.review.description));
      return true;
    });
  }
});

test('pipeline stages and resumes keep arbitrary modes, with no preset', async () => {
  const f = fakeProvider('fake');
  const { service } = svc(f);
  const a = await service.spawnJob({ mode: 'custom-stage', prompt: 'p', pipeline: 'pl', stage: 's' });
  assert.equal(a.preambleApplied, false);
  const b = await service.spawnJob({ mode: 'task', prompt: 'p', conversation: 'c1', name: 'n2' });
  assert.equal(b.preambleApplied, false);
  assert.equal(f.specs[0]!.prompt, 'p');
  assert.equal(f.specs[0]!.readOnly, undefined);
});

test('preamble is prepended to the provider prompt, original stored, not doubled', async () => {
  const f = fakeProvider('fake');
  const { service, repo } = svc(f);
  const ack = await service.spawnJob({ mode: 'review', prompt: 'look at it' });
  assert.equal(ack.preambleApplied, true);
  assert.equal(f.specs[0]!.prompt, `${MODE_PRESETS.review.preamble}\n\nlook at it`);
  const manifest = JSON.parse(readFileSync(path.join(ack.dir, 'job.json'), 'utf8'));
  assert.equal(manifest.preambleApplied, true);
  assert.equal(manifest.promptChars, 'look at it'.length);
  void repo;
  await service.spawnJob({ mode: 'review', name: 'again', prompt: `${MODE_PRESETS.review.preamble}\n\nmore` });
  assert.equal(f.specs[1]!.prompt, `${MODE_PRESETS.review.preamble}\n\nmore`);
});

test('read-only comes from the preset and the sandbox is echoed in ack and manifest', async () => {
  const f = fakeProvider('fake');
  const { service } = svc(f);
  const ack = await service.spawnJob({ mode: 'review', prompt: 'x' });
  assert.equal(f.specs[0]!.readOnly, true);
  assert.equal(ack.readOnlyRequested, true);
  assert.equal(ack.readOnlyEnforced, true);
  assert.equal(ack.sandbox, 'fake ro');
  assert.deepEqual(ack.sandboxFlags, ['--ro']);
  const m = JSON.parse(readFileSync(path.join(ack.dir, 'job.json'), 'utf8'));
  assert.equal(m.sandbox, 'fake ro');
  assert.equal(m.readOnlyEnforced, true);

  const open = await service.spawnJob({ mode: 'review', name: 'u', prompt: 'x', unrestricted: true });
  assert.equal(open.readOnlyRequested, false);
  assert.notEqual(f.specs[1]!.readOnly, true);

  const impl = await service.spawnJob({ mode: 'implement', name: 'i', prompt: 'x' });
  assert.equal(impl.readOnlyRequested, false);
});

test('provider without describeSandbox reports sandbox unknown', async () => {
  const { service } = svc(fakeProvider('fake', false));
  const ack = await service.spawnJob({ mode: 'review', prompt: 'x' });
  assert.equal(ack.sandbox, 'unknown');
  assert.equal(ack.readOnlyEnforced, false);
  assert.equal(ack.readOnlyRequested, true);
});

test('model recording: requested, harness-config, unknown', async () => {
  const f = fakeProvider('fake');
  const req = await svc(f, catalog()).service.spawnJob({ mode: 'implement', prompt: 'x', model: 'm1' });
  assert.equal(req.modelRequested, 'm1');
  assert.equal(req.modelResolved, 'm1');
  assert.equal(req.modelSource, 'requested');
  const m = JSON.parse(readFileSync(path.join(req.dir, 'job.json'), 'utf8'));
  assert.equal(m.model, 'm1');
  assert.equal(m.modelSource, 'requested');

  const cfg = await svc(f, catalog(), () => ({ model: 'm2' })).service.spawnJob({ mode: 'implement', prompt: 'x' });
  assert.equal(cfg.modelRequested, null);
  assert.equal(cfg.modelResolved, 'm2');
  assert.equal(cfg.modelSource, 'harness-config');

  const unk = await svc(f, catalog()).service.spawnJob({ mode: 'implement', prompt: 'x' });
  assert.equal(unk.modelResolved, null);
  assert.equal(unk.modelSource, 'unknown');
});

test('catalog validation: fresh catalog rejects unknown model and bad effort', async () => {
  const { service } = svc(fakeProvider('fake'), catalog());
  await assert.rejects(
    service.spawnJob({ mode: 'implement', prompt: 'x', model: 'nope' }),
    (e: Error) => /m1, m2/.test(e.message),
  );
  await assert.rejects(
    service.spawnJob({ mode: 'implement', prompt: 'x', model: 'm1', effort: 'ultra' }),
    (e: Error) => /Valid efforts: low, high/.test(e.message),
  );
  const ok = await service.spawnJob({ mode: 'implement', prompt: 'x', model: 'm1', effort: 'low' });
  assert.equal(ok.warnings, undefined);
  // a model with no efforts list accepts any effort
  await service.spawnJob({ mode: 'implement', name: 'b', prompt: 'x', model: 'm2', effort: 'whatever' });
});

test('agy effort-suffixed ids match a base model', async () => {
  const f = fakeProvider('agy');
  const { service } = svc(f, catalog({ provider: 'agy' }));
  const ack = await service.spawnJob({ mode: 'review', prompt: 'x', model: 'm1-high' });
  assert.equal(ack.modelSource, 'requested');
  await assert.rejects(service.spawnJob({ mode: 'review', name: 'z', prompt: 'x', model: 'zzz-high' }), /unknown model/);
});

test('stale, empty, errored, unverified or throwing catalogs warn instead of rejecting', async () => {
  for (const cat of [
    catalog({ stale: true }),
    catalog({ models: [] }),
    catalog({ error: 'boom' }),
    catalog({ verified: false }),
  ]) {
    const { service } = svc(fakeProvider('fake'), cat);
    const ack = await service.spawnJob({ mode: 'implement', prompt: 'x', model: 'nope' });
    assert.equal(ack.warnings?.length, 1);
    assert.match(ack.warnings![0]!, /could not verify/);
  }
  const { service } = svc(fakeProvider('fake'), async () => {
    throw new Error('not implemented');
  });
  const ack = await service.spawnJob({ mode: 'implement', prompt: 'x', effort: 'high' });
  assert.equal(ack.warnings?.length, 1);
});

test('agy preflight warns when a command-running mode is restricted', async () => {
  const { service } = svc(fakeProvider('agy'));
  const warn = await service.spawnJob({ mode: 'implement', prompt: 'x' });
  assert.ok(warn.warnings?.some((w) => /agy cannot prompt for permission headless/.test(w)));
  const quiet = await service.spawnJob({ mode: 'implement', name: 'q', prompt: 'x', unrestricted: true });
  assert.equal(quiet.warnings, undefined);
  const review = await service.spawnJob({ mode: 'review', name: 'r', prompt: 'x' });
  assert.equal(review.warnings, undefined);
});
