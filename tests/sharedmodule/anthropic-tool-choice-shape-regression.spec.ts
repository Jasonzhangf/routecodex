import { buildAnthropicFromOpenAIChatDirectNative as buildAnthropicRequestFromOpenAIChat } from './helpers/anthropic-codec-direct-native.js';

describe('anthropic tool_choice shape regression', () => {
  it('maps OpenAI function selector to Anthropic tool selector', () => {
    const payload = {
      model: 'claude-sonnet',
      messages: [{ role: 'user', content: 'run exec_command' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: {
              type: 'object',
              properties: { cmd: { type: 'string' } },
              required: ['cmd']
            }
          }
        }
      ],
      tool_choice: {
        type: 'function',
        function: { name: 'exec_command' }
      }
    } as any;

    const out = buildAnthropicRequestFromOpenAIChat(payload);
    expect((out as any).tool_choice).toEqual({ type: 'tool', name: 'exec_command' });
  });
});
