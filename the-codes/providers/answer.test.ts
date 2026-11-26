import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnswer, emptyResponseVerdict, isBookkeepingTool } from './answer.ts';

test('answer rule table', async (t) => {
  await t.test('1. prose, real tool, final prose -> final prose; success', () => {
    const a = createAnswer();
    a.text('earlier');
    a.work();
    a.text('final');
    assert.equal(a.value(), 'final');
    assert.equal(emptyResponseVerdict(a.value(), ''), undefined);
  });

  await t.test('2. prose, real tool, nothing after -> empty; not success', () => {
    const a = createAnswer();
    a.text('earlier');
    a.work();
    assert.equal(a.value(), '');
    assert.equal(emptyResponseVerdict(a.value(), '')?.status, 'malformed');
  });

  await t.test('3. prose, real tool, empty final message -> empty; not success', () => {
    const a = createAnswer();
    a.text('earlier');
    a.work();
    a.text('');
    assert.equal(a.value(), '');
    assert.equal(emptyResponseVerdict(a.value(), '')?.status, 'malformed');
  });

  await t.test('4. prose, then empty final message with no tool -> empty; not success', () => {
    const a = createAnswer();
    a.text('Narration');
    a.text('   ');
    assert.equal(a.value(), '');
    assert.equal(emptyResponseVerdict(a.value(), '')?.status, 'malformed');
  });

  await t.test('5. answer, then only bookkeeping tool -> answer; success', () => {
    const a = createAnswer();
    a.text('answer');
    assert.equal(isBookkeepingTool('opencode', 'todowrite'), true);
    assert.equal(isBookkeepingTool('kimi', 'SetTodoList'), true);
    assert.equal(isBookkeepingTool('claude', 'TodoWrite'), true);
    assert.equal(isBookkeepingTool('codex', 'todo_list'), true);
    assert.equal(isBookkeepingTool('claude', 'Bash'), false);
    assert.equal(a.value(), 'answer');
    assert.equal(emptyResponseVerdict(a.value(), ''), undefined);
  });

  await t.test('6. one message in several fragments with same key -> joined without separator', () => {
    const a = createAnswer();
    a.text('First part. ', 'm1');
    a.text('Second part.', 'm1');
    assert.equal(a.value(), 'First part. Second part.');

    a.text('First', 'm2');
    a.text('Second', 'm3');
    assert.equal(a.value(), 'Second');
  });

  await t.test('7. tool denied after prose with repeated final field -> empty; unstreamed suffix still works', () => {
    const a = createAnswer();
    a.text('I will try the tool.');
    a.work();
    a.providerFinal('I will try the tool.', 'includes-streamed');
    assert.equal(a.value(), '');

    const b = createAnswer();
    b.text('Running the test suite to verify.');
    b.work();
    b.providerFinal('Done.\n\n### Summary\nAll 956 tests passed.', 'includes-streamed');
    assert.equal(b.value(), 'Done.\n\n### Summary\nAll 956 tests passed.');

    const c = createAnswer();
    c.text('earlier');
    c.providerFinal('', 'authoritative');
    assert.equal(c.value(), '');
    c.providerFinal('from result', 'authoritative');
    assert.equal(c.value(), 'from result');
    c.providerFinal(undefined, 'authoritative');
    assert.equal(c.value(), 'from result');
  });

  await t.test('8. subagent text is never passed to text()', () => {
    const a = createAnswer();
    assert.equal(a.value(), '');
    assert.equal(emptyResponseVerdict(a.value(), '')?.status, 'malformed');
  });
});
