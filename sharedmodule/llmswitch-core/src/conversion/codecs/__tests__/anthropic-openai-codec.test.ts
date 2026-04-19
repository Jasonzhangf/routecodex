import {
  AnthropicOpenAIConversionCodec,
  buildAnthropicFromOpenAIChat,
  buildAnthropicRequestFromOpenAIChat,
  buildOpenAIChatFromAnthropic
} from '../anthropic-openai-codec.js';

const profile = {
  id: 'anthropic-openai-test',
  incomingProtocol: 'anthropic-messages',
  outgoingProtocol: 'openai-chat',
  codec: 'anthropic-openai'
} as any;

describe('anthropic-openai-codec native wrapper', () => {
  test('writes anthropicToolNameMap and maps anthropic tools into OpenAI chat request', async () => {
    const codec = new AnthropicOpenAIConversionCodec({});
    const context = { requestId: 'req_codec_alias', metadata: {} } as any;

    const result = await codec.convertRequest(
      {
        model: 'claude-3-7-sonnet',
        system: [{ type: 'text', text: 'You are helpful' }],
        tools: [
          {
            name: 'Bash',
            description: 'Run shell commands',
            input_schema: {
              type: 'object',
              properties: { cmd: { type: 'string' } },
              required: ['cmd']
            }
          }
        ],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'pwd' },
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'Bash',
                input: { cmd: 'pwd' }
              }
            ]
          }
        ]
      },
      profile,
      context
    );

    expect((context.metadata as any).anthropicToolNameMap).toEqual({
      bash: 'Bash'
    });
    expect((result as any).messages[0]).toMatchObject({ role: 'system', content: 'You are helpful' });
    expect((result as any).tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run shell commands',
          parameters: {
            type: 'object',
            properties: { cmd: { type: 'string' } },
            required: ['cmd']
          }
        }
      }
    ]);
    expect((result as any).messages[1].tool_calls[0]).toMatchObject({
      id: 'toolu_1',
      call_id: 'toolu_1',
      tool_call_id: 'toolu_1',
      type: 'function',
      function: {
        name: 'bash',
        arguments: '{"cmd":"pwd"}'
      }
    });
  });

  test('buildOpenAIChatFromAnthropic returns native request payload', () => {
    const result = buildOpenAIChatFromAnthropic(
      {
        model: 'claude-3-7-sonnet',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', text: 'I should inspect the cwd.' },
              { type: 'text', text: 'Running pwd.' },
              {
                type: 'tool_use',
                id: 'toolu_2',
                name: 'exec_command',
                input: { cmd: 'pwd' }
              }
            ]
          }
        ]
      } as any,
      { includeToolCallIds: true }
    );

    expect((result as any).model).toBe('claude-3-7-sonnet');
    expect((result as any).messages[0]).toMatchObject({
      role: 'assistant',
      content: 'Running pwd.',
      reasoning_content: 'I should inspect the cwd.'
    });
    expect((result as any).messages[0].tool_calls[0]).toMatchObject({
      id: 'toolu_2',
      call_id: 'toolu_2',
      tool_call_id: 'toolu_2'
    });
  });

  test('preserves blank lines when converting anthropic request into openai chat', () => {
    const result = buildOpenAIChatFromAnthropic(
      {
        model: 'claude-3-7-sonnet',
        system: [{ type: 'text', text: 'system line 1\n\nsystem line 2\n' }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'alpha\n\nbeta' },
              { type: 'text', text: '\n\ngamma' }
            ]
          }
        ]
      } as any
    );

    expect((result as any).messages[0]).toMatchObject({
      role: 'system',
      content: 'system line 1\n\nsystem line 2\n'
    });
    expect((result as any).messages[1]).toMatchObject({
      role: 'user',
      content: 'alpha\n\nbeta\n\ngamma'
    });
  });

  test('preserves blank lines when converting openai chat back to anthropic request', () => {
    const result = buildAnthropicRequestFromOpenAIChat(
      {
        model: 'claude-3-7-sonnet',
        messages: [
          { role: 'system', content: 'system line 1\n\nsystem line 2\n' },
          { role: 'user', content: 'alpha\n\nbeta\n\ngamma' }
        ]
      } as any
    );

    expect((result as any).system).toEqual([
      { type: 'text', text: 'system line 1\n\nsystem line 2\n' }
    ]);
    expect((result as any).messages).toEqual([
      {
        role: 'user',
        content: 'alpha\n\nbeta\n\ngamma'
      }
    ]);
  });

  test('converts governed chat response back to anthropic using stored alias map', async () => {
    const codec = new AnthropicOpenAIConversionCodec({});
    const result = await codec.convertResponse(
      {
        id: 'chatcmpl_1',
        model: 'gpt-4.1',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: 'Command ready',
              tool_calls: [
                {
                  id: 'call_exec',
                  type: 'function',
                  function: {
                    name: 'bash',
                    arguments: '{"cmd":"pwd"}'
                  }
                }
              ]
            }
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 6
        }
      },
      profile,
      {
        requestId: 'req_codec_response',
        entryEndpoint: '/v1/messages',
        metadata: {
          anthropicToolNameMap: {
            bash: 'Bash'
          }
        }
      } as any
    );

    expect((result as any).type).toBe('message');
    expect((result as any).stop_reason).toBe('tool_use');
    expect((result as any).usage).toMatchObject({ input_tokens: 10, output_tokens: 6 });
    expect((result as any).content).toEqual([
      { type: 'text', text: 'Command ready' },
      {
        type: 'tool_use',
        id: 'call_exec',
        name: 'Bash',
        input: { cmd: 'pwd' }
      }
    ]);
  });

  test('buildAnthropicFromOpenAIChat roundtrips tool alias map directly', () => {
    const result = buildAnthropicFromOpenAIChat(
      {
        id: 'chatcmpl_direct',
        model: 'gpt-4.1',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: 'Run it',
              tool_calls: [
                {
                  id: 'call_direct',
                  type: 'function',
                  function: { name: 'bash', arguments: '{"cmd":"pwd"}' }
                }
              ]
            }
          }
        ]
      } as any,
      {
        toolNameMap: { bash: 'Bash' },
        requestId: 'req_direct'
      }
    );

    expect((result as any).id).toBe('chatcmpl_direct');
    expect((result as any).content[1]).toEqual({
      type: 'tool_use',
      id: 'call_direct',
      name: 'Bash',
      input: { cmd: 'pwd' }
    });
  });
});
