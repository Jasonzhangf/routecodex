import { normalizeOpenaiChatRequestWithNative } from './helpers/native-shared-conversion-direct-native.js';

function normalizeChatRequest(payload: unknown): unknown {
  return normalizeOpenaiChatRequestWithNative(payload, false);
}

describe('normalizeChatRequest', () => {
  it('fails fast when chat messages contain synthetic RouteCodex local control text', () => {
    const payload = {
      model: 'gpt-test',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '[RouteCodex] assistant response became empty after response sanitization.' }
      ]
    };

    expect(() => normalizeChatRequest(payload)).toThrow(/synthetic RouteCodex local control text/i);
  });

  it('fails fast when assistant tool_calls has no matching tool result', () => {
    const payload = {
      model: 'gpt-test',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_missing_1',
              type: 'function',
              function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' }
            }
          ]
        },
        { role: 'assistant', content: 'next turn' }
      ]
    };

    expect(() => normalizeChatRequest(payload)).toThrow(/dangling_tool_call/i);
  });

  it('fails fast when tool result references unknown tool_call_id', () => {
    const payload = {
      model: 'gpt-test',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'tool', tool_call_id: 'call_orphan_1', content: '' }
      ]
    };

    expect(() => normalizeChatRequest(payload)).toThrow(/orphan_tool_result/i);
  });
});
