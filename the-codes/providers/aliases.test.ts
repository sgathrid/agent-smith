import assert from 'node:assert/strict';
import test from 'node:test';
import { describeAliases, loadModelConfig, resolveRequest, type ConfigFs } from './aliases.ts';

const fsOf = (files: Record<string, string>): ConfigFs => ({ readFile: (p) => files[p] });
const U = '/h/.agent-smith/models.json';
const P = '/r/.agent-smith/models.json';
const load = (files: Record<string, string>) => loadModelConfig({ repo: '/r', home: '/h', fs: fsOf(files) });
const user = JSON.stringify({ aliases: { 'sol-high': { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, shared: { provider: 'agy', model: 'u' } }, roleDefaults: { review: 'sol-high' } });
const proj = JSON.stringify({ aliases: { shared: { provider: 'claude' }, 'flash-med': { provider: 'agy', model: 'gemini-3.8-flash', effort: 'medium' } } });

test('project overrides user wholesale; scopes reported', () => {
  const cfg = load({ [U]: user, [P]: proj });
  assert.deepEqual(cfg.errors, []);
  assert.deepEqual(cfg.aliases.shared, { provider: 'claude' });
  const d = describeAliases(cfg);
  assert.equal(d.aliases.find((a) => a.name === 'shared')!.scope, 'project');
  assert.equal(d.aliases.find((a) => a.name === 'sol-high')!.scope, 'user');
  assert.equal(d.roleDefaults.review, 'sol-high');
});

test('call args beat roleDefault; roleDefault applies when nothing given', () => {
  const cfg = load({ [U]: user });
  assert.equal(resolveRequest({ mode: 'review' }, cfg).source, 'roleDefault');
  assert.equal(resolveRequest({ mode: 'review' }, cfg).model, 'gpt-6.1-sol');
  const r = resolveRequest({ mode: 'review', model: 'x' }, cfg);
  assert.deepEqual([r.source, r.model, r.provider], ['call', 'x', undefined]);
});

test('alias expansion; explicit effort wins', () => {
  const cfg = load({ [U]: user });
  const r = resolveRequest({ model: 'sol-high', effort: 'low', provider: 'codex' }, cfg);
  assert.deepEqual([r.provider, r.model, r.effort, r.appliedAlias, r.source], ['codex', 'gpt-6.1-sol', 'low', 'sol-high', 'alias']);
});

test('conflicting provider throws', () => {
  assert.throws(() => resolveRequest({ model: 'sol-high', provider: 'agy' }, load({ [U]: user })), /belongs to provider "codex"/);
});

test('dangling roleDefault is an error and ignored', () => {
  const cfg = load({ [P]: JSON.stringify({ roleDefaults: { verify: 'nope', bogus: 'x' } }) });
  assert.equal(cfg.errors.length, 2);
  assert.equal(cfg.roleDefaults.verify, undefined);
  assert.equal(resolveRequest({ mode: 'verify' }, cfg).source, 'none');
});

test('bad JSON and bad shapes yield errors, good parts survive', () => {
  const cfg = load({ [U]: '{nope', [P]: JSON.stringify({ aliases: { Bad: { provider: 'codex' }, ok: { provider: 'codex' }, p: { provider: 'x' } } }) });
  assert.equal(cfg.errors.length, 3);
  assert.deepEqual(Object.keys(cfg.aliases), ['ok']);
});

test('passthrough when nothing configured', () => {
  const cfg = load({});
  assert.deepEqual(resolveRequest({ provider: 'codex', model: 'm', effort: 'high' }, cfg), { provider: 'codex', model: 'm', effort: 'high', source: 'call', warnings: [] });
  assert.equal(resolveRequest({}, cfg).source, 'none');
});

test('alias colliding with a real model id warns, alias wins', () => {
  const cfg = load({ [P]: JSON.stringify({ aliases: { 'gpt-5': { provider: 'agy', model: 'z' } } }) });
  const r = resolveRequest({ model: 'gpt-5' }, cfg);
  assert.equal(r.provider, 'agy');
  assert.equal(r.warnings.length, 1);
});
