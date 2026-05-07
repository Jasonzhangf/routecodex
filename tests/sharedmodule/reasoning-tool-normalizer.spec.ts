import { describe, expect, test } from '@jest/globals';
import { normalizeMessageReasoningTools } from '../../sharedmodule/llmswitch-core/src/conversion/shared/reasoning-tool-normalizer.js';

describe('reasoning-tool-normalizer', () => {
  test('writes normalized native message back into original record', () => {
    const message: Record<string, unknown> = {
      role: 'assistant',
      reasoning_content: [
        '先分析上下文。',
        '',
        '<tool_call>',
        `{"name":"exec_command","id":"call_reasoning_1","arguments":{"cmd":"bash -lc 'pwd'"}}`,
        '</tool_call>'
      ].join('\n')
    };

    const result = normalizeMessageReasoningTools(message, {
      idPrefix: 'reasoning_test'
    });

    expect(result.toolCallsAdded).toBe(1);
    expect(Array.isArray(message.tool_calls)).toBe(true);
    expect(message.tool_calls).toEqual([
      {
        id: 'call_reasoning_1',
        type: 'function',
        function: {
          name: 'exec_command',
          arguments: `{"cmd":"bash -lc 'pwd'"}`
        }
      }
    ]);
    expect(typeof message.reasoning_content).toBe('string');
    expect(String(message.reasoning_content)).not.toContain('<tool_call>');
  });
});
