import { describe, expect, test } from '@jest/globals';

import { applyToolSessionCompat } from '../../src/conversion/hub/tool-session-compat.js';

describe('tool-session compat native normalization', () => {
  test('reorders tool messages, injects unknown placeholders, and filters stray tool outputs', async () => {
    const chat: any = {
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'toolA' } },
            { id: 'call_b', type: 'function', function: { name: 'toolB' } }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_b',
          name: 'toolB',
          content: 'ok'
        }
      ],
      toolOutputs: [
        { tool_call_id: 'call_b', content: 'keep' },
        { tool_call_id: 'call_drop', content: 'drop' }
      ],
      metadata: {}
    };

    await applyToolSessionCompat(chat, {
      entryEndpoint: '/v1/chat/completions'
    } as any);

    expect(chat.messages).toHaveLength(3);
    expect(chat.messages[1].role).toBe('tool');
    expect(chat.messages[1].tool_call_id).toBe('call_a');
    expect(String(chat.messages[1].content || '')).toContain('[RouteCodex] Tool call result unknown');
    expect(chat.messages[2].tool_call_id).toBe('call_b');

    expect(Array.isArray(chat.toolOutputs)).toBe(true);
    expect(chat.toolOutputs).toHaveLength(1);
    expect(chat.toolOutputs[0].tool_call_id).toBe('call_b');
  });
});
