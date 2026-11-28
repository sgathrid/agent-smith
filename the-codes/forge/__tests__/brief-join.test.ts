import assert from 'node:assert/strict';
import test from 'node:test';
import { expandsSlashCommands, joinBrief, type JoinOptions } from '../brief.ts';

const B = 'BRIEF line 1\nline 2';
const EXISTING = new Set(['/tmp', '/usr']);
const opts = (provider: string): JoinOptions => ({ slashCommands: expandsSlashCommands(provider), isPath: (t) => EXISTING.has(t) });
const agy = opts('agy');

test('without a brief the prompt is unchanged', () => {
  assert.equal(joinBrief('', '/swarm go', agy), '/swarm go');
  assert.equal(joinBrief('', 'plain', agy), 'plain');
});

test('plain prompts get the brief in front', () => {
  assert.equal(joinBrief(B, 'Review this', agy), `${B}\n\nReview this`);
  assert.equal(joinBrief(B, 'Look at /usr/bin and /swarm', agy), `${B}\n\nLook at /usr/bin and /swarm`);
  assert.equal(joinBrief(B, 'Review\n/swarm now', agy), `${B}\n\nReview\n/swarm now`);
});

test('a leading slash command stays first for agy and claude, brief follows it', () => {
  for (const provider of ['agy', 'claude']) assert.equal(joinBrief(B, '/swarm Review the PRs', opts(provider)), `/swarm ${B}\n\nReview the PRs`);
  assert.equal(joinBrief(B, '/swarm', agy), `/swarm ${B}`);
  assert.equal(joinBrief(B, '/plugin:skill-x a b\nc', agy), `/plugin:skill-x ${B}\n\na b\nc`);
  assert.equal(joinBrief(B, '  \n/swarm_2 go', agy), `/swarm_2 ${B}\n\ngo`);
  assert.equal(joinBrief(B, '/swarm\n\ngo', agy), `/swarm ${B}\n\ngo`);
});

test('providers that do not expand slash commands never move one', () => {
  for (const provider of ['codex', 'opencode', 'kimi']) assert.equal(joinBrief(B, '/swarm Review the PRs', opts(provider)), `${B}\n\n/swarm Review the PRs`);
});

test('a path is not a command', () => {
  assert.equal(joinBrief(B, '/tmp is full, find out why', agy), `${B}\n\n/tmp is full, find out why`);
  assert.equal(joinBrief(B, '/usr', opts('claude')), `${B}\n\n/usr`);
  assert.equal(joinBrief(B, '/Users/x/file.md is broken', agy), `${B}\n\n/Users/x/file.md is broken`);
  assert.equal(joinBrief(B, '/usr/bin', agy), `${B}\n\n/usr/bin`);
  assert.equal(joinBrief(B, '/swarm.', agy), `${B}\n\n/swarm.`);
  assert.equal(joinBrief(B, '/', agy), `${B}\n\n/`);
});
