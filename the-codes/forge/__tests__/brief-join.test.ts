import assert from 'node:assert/strict';
import test from 'node:test';
import { joinBrief } from '../brief.ts';

const B = 'BRIEF line 1\nline 2';

test('without a brief the prompt is unchanged', () => {
  assert.equal(joinBrief('', '/swarm go'), '/swarm go');
  assert.equal(joinBrief('', 'plain'), 'plain');
});

test('plain prompts get the brief in front', () => {
  assert.equal(joinBrief(B, 'Review this'), `${B}\n\nReview this`);
  assert.equal(joinBrief(B, 'Look at /usr/bin and /swarm'), `${B}\n\nLook at /usr/bin and /swarm`);
  assert.equal(joinBrief(B, 'Review\n/swarm now'), `${B}\n\nReview\n/swarm now`);
});

test('a leading slash command stays first, brief follows it', () => {
  assert.equal(joinBrief(B, '/swarm Review the PRs'), `/swarm ${B}\n\nReview the PRs`);
  assert.equal(joinBrief(B, '/swarm'), `/swarm ${B}`);
  assert.equal(joinBrief(B, '/plugin:skill-x a b\nc'), `/plugin:skill-x ${B}\n\na b\nc`);
  assert.equal(joinBrief(B, '  \n/swarm_2 go'), `/swarm_2 ${B}\n\ngo`);
  assert.equal(joinBrief(B, '/swarm\n\ngo'), `/swarm ${B}\n\ngo`);
});

test('a path is not a command', () => {
  assert.equal(joinBrief(B, '/Users/x/file.md is broken'), `${B}\n\n/Users/x/file.md is broken`);
  assert.equal(joinBrief(B, '/usr/bin'), `${B}\n\n/usr/bin`);
  assert.equal(joinBrief(B, '/swarm.'), `${B}\n\n/swarm.`);
  assert.equal(joinBrief(B, '/'), `${B}\n\n/`);
});
