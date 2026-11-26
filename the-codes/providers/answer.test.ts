import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnswer, emptyResponseVerdict } from './answer.ts';

test('answer rule table', async (t) => {
  await t.test('1. prose, real tool, final prose -> final prose; success', () => {
    const a = createAnswer('claude');
    a.text('earlier');
    a.tool('Bash');
    a.text('final');
    assert.equal(a.value(), 'final');
    assert.equal(emptyResponseVerdict(a.value(), ''), undefined);
  });

  await t.test('2. prose, real tool, nothing after -> empty; not success', () => {
    const a = createAnswer('claude');
    a.text('earlier');
    a.tool('Bash');
    assert.equal(a.value(), '');
    assert.equal(emptyResponseVerdict(a.value(), '')?.status, 'malformed');
  });

  await t.test('3. prose, real tool, empty final message -> empty; not success', () => {
    const a = createAnswer('claude');
    a.text('earlier');
    a.tool('Bash');
    a.emptyMessage();
    assert.equal(a.value(), '');
    assert.equal(emptyResponseVerdict(a.value(), '')?.status, 'malformed');
  });

  await t.test('4. prose, then empty final message with no tool -> empty; not success', () => {
    const a = createAnswer('claude');
    a.text('Narration');
    a.text('   ');
    assert.equal(a.value(), '');
    assert.equal(emptyResponseVerdict(a.value(), '')?.status, 'malformed');

    const b = createAnswer('claude');
    b.text('Narration');
    b.emptyMessage();
    assert.equal(b.value(), '');
  });

  await t.test('5. answer, then only bookkeeping tool -> answer; real tool clears it', () => {
    for (const [provider, toolName] of [
      ['opencode', 'todowrite'],
      ['kimi', 'SetTodoList'],
      ['claude', 'TodoWrite'],
      ['codex', 'todo_list'],
    ] as const) {
      const a = createAnswer(provider);
      a.text('answer');
      a.tool(toolName);
      assert.equal(a.value(), 'answer', `${provider}:${toolName} must preserve answer`);
      assert.equal(emptyResponseVerdict(a.value(), ''), undefined);
    }

    const real = createAnswer('claude');
    real.text('answer');
    real.tool('Bash');
    assert.equal(real.value(), '');
    assert.equal(emptyResponseVerdict(real.value(), '')?.status, 'malformed');

    const agyTodo = createAnswer('agy');
    agyTodo.text('answer');
    agyTodo.tool('todo_list');
    assert.equal(agyTodo.value(), '');
  });

  await t.test('6. one message in several fragments with same key -> joined without separator', () => {
    const a = createAnswer('opencode');
    a.text('First part. ', 'm1');
    a.text('Second part.', 'm1');
    assert.equal(a.value(), 'First part. Second part.');

    a.text('First', 'm2');
    a.text('Second', 'm3');
    assert.equal(a.value(), 'Second');
  });

  await t.test('7. final field four-bullet contract', () => {
    const emptyField = createAnswer('claude');
    emptyField.text('earlier');
    emptyField.providerFinal('   ', 'final-message');
    assert.equal(emptyField.value(), '');

    const blocked = createAnswer('claude');
    blocked.text('narration');
    blocked.tool('Bash');
    blocked.providerFinal('narration', 'final-message');
    assert.equal(blocked.value(), '');

    const blockedRunProse = createAnswer('agy');
    blockedRunProse.text('narration');
    blockedRunProse.tool('run_command');
    blockedRunProse.providerFinal('narration', 'run-prose');
    assert.equal(blockedRunProse.value(), '');

    const noText = createAnswer('agy');
    noText.providerFinal('only in field', 'run-prose');
    assert.equal(noText.value(), 'only in field');

    const shortWithLongerField = createAnswer('claude');
    shortWithLongerField.text('Short final');
    shortWithLongerField.providerFinal('Full authoritative report', 'final-message');
    assert.equal(shortWithLongerField.value(), 'Full authoritative report');

    const streamedStands = createAnswer('agy');
    streamedStands.text('final');
    streamedStands.providerFinal('earlier\nfinal', 'run-prose');
    assert.equal(streamedStands.value(), 'final');
  });

  await t.test('8. empty fragment contributes nothing and does not block providerFinal fallback', () => {
    const emptyDelta = createAnswer('agy');
    emptyDelta.text('', 's1');
    emptyDelta.providerFinal('Report from response', 'run-prose');
    assert.equal(emptyDelta.value(), 'Report from response');

    const keepsExisting = createAnswer('opencode');
    keepsExisting.text('answer', 'm1');
    keepsExisting.text('', 'm2');
    assert.equal(keepsExisting.value(), 'answer');

    const whitespaceBlocks = createAnswer('agy');
    whitespaceBlocks.text('   ', 's1');
    whitespaceBlocks.providerFinal('Should not restore', 'run-prose');
    assert.equal(whitespaceBlocks.value(), '');

    const explicitEmptyBlocks = createAnswer('agy');
    explicitEmptyBlocks.emptyMessage();
    explicitEmptyBlocks.providerFinal('Should not restore', 'run-prose');
    assert.equal(explicitEmptyBlocks.value(), '');
  });
});
