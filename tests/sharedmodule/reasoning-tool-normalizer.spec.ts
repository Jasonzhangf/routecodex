import { describe, expect, test } from '@jest/globals';
import { normalizeMessageReasoningToolsWithNative } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-bridge-action-semantics.js';

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

    const result = normalizeMessageReasoningToolsWithNative(message, 'reasoning_test');

    expect(result.toolCallsAdded).toBe(1);
    expect(Array.isArray(result.message.tool_calls)).toBe(true);
    expect(result.message.tool_calls).toEqual([
      {
        id: 'call_reasoning_1',
        type: 'function',
        function: {
          name: 'exec_command',
          arguments: `{"cmd":"bash -lc 'pwd'"}`
        }
      }
    ]);
    expect(typeof result.message.reasoning_content).toBe('string');
    expect(String(result.message.reasoning_content)).not.toContain('<tool_call>');
  });
});
