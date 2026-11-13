/** How a native agent hands back: a tool on harnesses that ask for one, else its final text. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handbackByTool, toDriverMessages } from '../hooks/agent-driver.ts';

test('handback: final text by default; the tool only when the host asks; never after the tool failed', () => {
  const task = { role: 'user' as const, text: 'Review it.', toolUses: [] };
  assert.equal(handbackByTool([task]), false);
  const asked = { role: 'user' as const, text: '<system-reminder>Your final report is delivered through SubagentHandback: call it last.</system-reminder>', toolUses: [] };
  assert.equal(handbackByTool([task, asked]), true);
  const failed = { role: 'assistant' as const, text: '', toolUses: [{ id: 'h', name: 'SubagentHandback', input: {}, resultText: 'No such tool available: SubagentHandback', isError: true }] };
  assert.equal(handbackByTool([task, asked, failed]), false);
});

test('toDriverMessages pairs tool results with their calls and keeps errors', () => {
  const msgs = toDriverMessages([
    { role: 'user', content: 'Task' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'SubagentHandback', input: { message: 'x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'No such tool available: SubagentHandback' }] }] },
  ]);
  assert.equal(msgs[1]!.toolUses[0]!.isError, true);
  assert.match(String(msgs[1]!.toolUses[0]!.resultText), /No such tool/);
});
