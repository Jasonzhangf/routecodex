import { buildAnthropicSdkCallOptions } from '../../../../src/providers/core/runtime/vercel-ai-sdk/anthropic-sdk-transport.js';

describe('buildAnthropicSdkCallOptions', () => {
  it('maps anthropic thinking, effort, tools, and tool results into AI SDK call options', () => {
    const options = buildAnthropicSdkCallOptions(
      {
        model: 'glm-5',
        max_tokens: 1024,
        system: 'You are terse.',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'bash',
                input: { command: 'pwd' }
              }
            ]
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: 'ok'
              },
              {
                type: 'text',
                text: 'continue'
              }
            ]
          }
        ],
        tools: [
          {
            name: 'bash',
            description: 'run shell',
            input_schema: {
              type: 'object',
              properties: {
                command: { type: 'string' }
              },
              required: ['command']
            }
          }
        ],
        tool_choice: { type: 'any' },
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' }
      },
      {
        'anthropic-beta': 'claude-code'
      }
    );

    expect(options.maxOutputTokens).toBe(1024);
    expect(options.toolChoice).toEqual({ type: 'required' });
    expect(options.tools).toEqual([
      {
        type: 'function',
        name: 'bash',
        description: 'run shell',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string' }
          },
          required: ['command']
        }
      }
    ]);
    expect(options.providerOptions).toEqual({
      anthropic: {
        thinking: { type: 'adaptive' },
        effort: 'high'
      }
    });
    expect(options.prompt).toEqual([
      { role: 'system', content: 'You are terse.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'toolu_1',
            toolName: 'bash',
            input: { command: 'pwd' },
            providerExecuted: undefined
          }
        ]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'toolu_1',
            toolName: 'bash',
            output: { type: 'text', value: 'ok' }
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'continue'
          }
        ]
      }
    ]);
  });
});
