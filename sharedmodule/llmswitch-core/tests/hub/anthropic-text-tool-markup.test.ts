import { describe, expect, test } from '@jest/globals';

import { buildOpenAIChatFromAnthropicMessage } from '../../src/conversion/hub/response/response-runtime.js';

describe('anthropic text tool markup extraction', () => {
  test('extracts tool_calls from <tool_call> markup in text blocks', () => {
    const payload: any = {
      id: 'msg_tool_markup_1',
      type: 'message',
      role: 'assistant',
      model: 'glm-5',
      content: [
        {
          type: 'text',
          text: 'Before <tool_call name="apply_patch">{\"name\":\"apply_patch\",\"arguments\":{\"input\":\"*** Begin Patch\\n*** End Patch\"}}</tool_call> After'
        }
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 }
    };

    const chat = buildOpenAIChatFromAnthropicMessage(payload);
    const message = (chat as any).choices?.[0]?.message;
    expect(message).toBeDefined();
    expect(Array.isArray(message.tool_calls)).toBe(true);
    expect(message.tool_calls).toHaveLength(1);
    expect(message.tool_calls[0].function?.name).toBe('apply_patch');
    expect(typeof message.content).toBe('string');
    expect(message.content).not.toContain('<tool_call');
    expect(message.content).toContain('Before');
    expect(message.content).toContain('After');
  });
});
