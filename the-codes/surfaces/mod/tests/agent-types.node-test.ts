/** Native subagent type generation and registration spec mapping. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadModelConfig } from '../../../providers/aliases.ts';
import {
  AGENT_DRIVER_PROMPT,
  HEADER_HINT,
  MAX_AGENT_NAME_LENGTH,
  MAX_AGENT_TYPES,
  agentSpec,
  agentTypes,
  sanitizeAgentName,
} from '../hooks/agent-types.ts';

test('returns aliases first then available providers in input order, skipping unavailable ones', () => {
  const types = agentTypes({
    providers: [
      { name: 'codex', available: true, defaultModel: 'gpt-5.4' },
      { name: 'kimi', available: false, defaultModel: 'kimi-k2' },
      { name: 'agy', available: true, defaultModel: 'gemini-4-hydrogen' },
      { name: 'opencode', available: true, defaultModel: null },
    ],
    aliases: {
      fast: { provider: 'agy', model: 'gemini-4-hydrogen' },
      offline: { provider: 'kimi', model: 'kimi-k2' },
      deep: { provider: 'codex', model: 'gpt-5.4', effort: 'high' },
    },
  });

  assert.deepEqual(
    types.map((t) => t.name),
    ['fast', 'deep', 'codex', 'agy', 'opencode'],
  );

  assert.deepEqual(types[0], {
    name: 'fast',
    description: `External worker: agy · gemini-4-hydrogen (alias). ${HEADER_HINT}`,
    defaults: { provider: 'agy', model: 'gemini-4-hydrogen' },
  });
  assert.deepEqual(types[1], {
    name: 'deep',
    description: `External worker: codex · gpt-5.4 · effort high (alias). ${HEADER_HINT}`,
    defaults: { provider: 'codex', model: 'gpt-5.4', effort: 'high' },
  });
  assert.deepEqual(types[2], {
    name: 'codex',
    description: `External worker: codex · gpt-5.4. ${HEADER_HINT}`,
    defaults: { provider: 'codex', model: 'gpt-5.4' },
  });
  assert.deepEqual(types[4], {
    name: 'opencode',
    description: `External worker: opencode. ${HEADER_HINT}`,
    defaults: { provider: 'opencode' },
  });

  for (const t of types) {
    assert.equal(t.description.includes('\n'), false, 'description must be a single line');
    assert.equal(t.description.endsWith(HEADER_HINT), true, 'header hint must be identical across types');
  }
});

test('when an alias name collides with a provider name, the alias wins and the provider type is dropped', () => {
  const types = agentTypes({
    providers: [
      { name: 'codex', available: true, defaultModel: 'gpt-5.1' },
      { name: 'agy', available: true, defaultModel: 'gemini-4-hydrogen' },
      { name: 'kimi', available: false },
    ],
    aliases: {
      codex: { provider: 'codex', model: 'gpt-5.4', effort: 'xhigh' },
      // An alias whose provider is unavailable is skipped, so it must not shadow an available provider.
      agy: { provider: 'kimi', model: 'kimi-k2' },
    },
  });

  assert.deepEqual(
    types.map((t) => t.name),
    ['codex', 'agy'],
  );
  assert.deepEqual(types[0]?.defaults, { provider: 'codex', model: 'gpt-5.4', effort: 'xhigh' });
  assert.match(types[0]?.description ?? '', /\(alias\)\./);
  assert.deepEqual(types[1]?.defaults, { provider: 'agy', model: 'gemini-4-hydrogen' });
  assert.doesNotMatch(types[1]?.description ?? '', /\(alias\)\./);
});

test('sanitizes names to <=40 [a-z0-9-] chars and drops duplicates after sanitizing (first wins)', () => {
  assert.equal(sanitizeAgentName('Fast.Review_V2'), 'fast-review-v2');
  assert.equal(sanitizeAgentName('a'.repeat(55)), 'a'.repeat(MAX_AGENT_NAME_LENGTH));
  assert.equal(sanitizeAgentName(`${'a'.repeat(39)}.tail`).length <= MAX_AGENT_NAME_LENGTH, true);
  assert.equal(sanitizeAgentName('...'), '');

  const longPrefix = 'x'.repeat(40);
  const types = agentTypes({
    providers: [
      { name: 'Open_Code', available: true, defaultModel: 'm1' },
      { name: 'open.code', available: true, defaultModel: 'm2' },
      { name: 'agy', available: true },
    ],
    aliases: {
      'fast.review': { provider: 'agy', model: 'first-model' },
      'fast_review': { provider: 'agy', model: 'second-model' },
      'FAST/REVIEW': { provider: 'agy', model: 'third-model' },
      [`${longPrefix}-one`]: { provider: 'agy', model: 'long-first' },
      [`${longPrefix}-two`]: { provider: 'agy', model: 'long-second' },
    },
  });

  assert.deepEqual(
    types.map((t) => t.name),
    ['fast-review', longPrefix, 'open-code', 'agy'],
  );
  assert.equal(types[0]?.defaults.model, 'first-model');
  assert.equal(types[1]?.defaults.model, 'long-first');
  assert.equal(types[2]?.defaults.provider, 'Open_Code');
  assert.equal(types[2]?.defaults.model, 'm1');
  for (const t of types) {
    assert.match(t.name, /^[a-z0-9-]+$/);
    assert.ok(t.name.length <= MAX_AGENT_NAME_LENGTH);
  }
});

test('caps the list at 24 types with aliases taking priority before providers', () => {
  const aliases: Record<string, { provider: string; model: string }> = {};
  for (let i = 1; i <= 22; i++) {
    aliases[`alias-${String(i).padStart(2, '0')}`] = { provider: 'agy', model: `m-${i}` };
  }
  const mixed = agentTypes({
    providers: [
      { name: 'agy', available: true },
      { name: 'codex', available: true },
      { name: 'opencode', available: true },
      { name: 'claude', available: true },
    ],
    aliases,
  });

  assert.equal(mixed.length, MAX_AGENT_TYPES);
  assert.equal(mixed.slice(0, 22).every((t) => t.name.startsWith('alias-')), true);
  assert.deepEqual(mixed.slice(22).map((t) => t.name), ['agy', 'codex']);

  const allAliases: Record<string, { provider: string }> = {};
  for (let i = 1; i <= 30; i++) {
    allAliases[`a-${i}`] = { provider: 'agy' };
  }
  const cappedAliases = agentTypes({
    providers: [{ name: 'agy', available: true }, { name: 'codex', available: true }],
    aliases: allAliases,
  });
  assert.equal(cappedAliases.length, MAX_AGENT_TYPES);
  assert.equal(cappedAliases.at(-1)?.name, 'a-24');
});

test('accepts ModelConfig.aliases from providers/aliases.ts directly', () => {
  const cfg = loadModelConfig({
    repo: '/repo',
    home: '/home',
    fs: {
      readFile(p) {
        if (p === '/repo/.agent-smith/models.json') {
          return JSON.stringify({
            aliases: {
              reviewer: { provider: 'agy', model: 'gemini-4-hydrogen', effort: 'high' },
            },
          });
        }
        return undefined;
      },
    },
  });

  const types = agentTypes({
    providers: [{ name: 'agy', available: true, defaultModel: 'gemini-4-flash' }],
    aliases: cfg.aliases,
  });
  assert.deepEqual(types.map((t) => t.name), ['reviewer', 'agy']);
});

test('agentSpec builds the $.agent.register payload with the given toolPrefix', () => {
  const [spec] = agentTypes({
    providers: [{ name: 'agy', available: true, defaultModel: 'gemini-4-hydrogen' }],
    aliases: { hydrogen: { provider: 'agy', model: 'gemini-4-hydrogen' } },
  });
  assert.ok(spec);

  const prefix = 'mcp__plugin_agent-smith_agent-smith__';
  assert.deepEqual(agentSpec(spec, prefix), {
    name: 'hydrogen',
    description: `External worker: agy · gemini-4-hydrogen (alias). ${HEADER_HINT}`,
    prompt: AGENT_DRIVER_PROMPT,
    tools: [
      'SubagentHandback',
      'mcp__plugin_agent-smith_agent-smith__spawn_job',
      'mcp__plugin_agent-smith_agent-smith__status',
      'mcp__plugin_agent-smith_agent-smith__steer_job',
      'mcp__plugin_agent-smith_agent-smith__resume_job',
      'mcp__plugin_agent-smith_agent-smith__cancel',
    ],
    model: 'haiku',
    maxTurns: 1000,
  });

  assert.deepEqual(agentSpec(spec, 'mcp__agent-smith__').tools, [
    'SubagentHandback',
    'mcp__agent-smith__spawn_job',
    'mcp__agent-smith__status',
    'mcp__agent-smith__steer_job',
    'mcp__agent-smith__resume_job',
    'mcp__agent-smith__cancel',
  ]);
});
