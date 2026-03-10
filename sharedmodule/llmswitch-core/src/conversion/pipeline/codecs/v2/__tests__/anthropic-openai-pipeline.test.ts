import { AnthropicOpenAIPipelineCodec } from '../anthropic-openai-pipeline.js';

describe('anthropic-openai-pipeline native shell', () => {
  const profile = {
    id: 'anthropic-openai-v2-test',
    incomingProtocol: 'anthropic-messages',
    outgoingProtocol: 'openai-chat',
    codec: 'anthropic-openai-v2'
  } as any;

  test('request path uses native anthropic->openai mapping and keeps tool ids', async () => {
    const codec = new AnthropicOpenAIPipelineCodec();
    await codec.initialize();

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
            role: 'assistant',
            content: [
              { type: 'thinking', text: 'inspect cwd' },
              { type: 'text', text: 'Running pwd.' },
              { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { cmd: 'pwd' } }
            ]
          }
        ]
      },
      profile,
      {
        requestId: 'req_anthropic_pipeline_request',
        entryEndpoint: '/v1/messages',
        endpoint: '/v1/messages',
        metadata: {}
      } as any
    );

    expect((result as any).messages[0]).toMatchObject({ role: 'system', content: 'You are helpful' });
    expect((result as any).messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Running pwd.'
    });
    expect((result as any).messages[1].tool_calls[0]).toMatchObject({
      id: 'toolu_1',
      function: {
        name: 'bash',
        arguments: '{"cmd":"pwd"}'
      }
    });
    expect((result as any).tools[0]).toMatchObject({
      type: 'function',
      function: { name: 'bash' }
    });
  });

  test('response path uses stored alias map to map chat response back to anthropic', async () => {
    const codec = new AnthropicOpenAIPipelineCodec();
    await codec.initialize();

    await codec.convertRequest(
      {
        model: 'claude-3-7-sonnet',
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
        messages: [{ role: 'user', content: [{ type: 'text', text: 'pwd' }] }]
      },
      profile,
      {
        requestId: 'req_anthropic_pipeline_response',
        entryEndpoint: '/v1/messages',
        endpoint: '/v1/messages',
        metadata: {}
      } as any
    );

    const result = await codec.convertResponse(
      {
        id: 'chatcmpl_1',
        model: 'gpt-4.1',
        choices: [
          {
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
        requestId: 'req_anthropic_pipeline_response',
        entryEndpoint: '/v1/messages',
        endpoint: '/v1/messages',
        metadata: {}
      } as any
    );

    expect((result as any).type).toBe('message');
    expect((result as any).stop_reason).toBe('tool_use');
    expect((result as any).usage).toMatchObject({ input_tokens: 10, output_tokens: 6 });
    expect((result as any).content[0]).toEqual({
      type: 'tool_use',
      id: 'call_exec',
      name: 'Bash',
      input: { cmd: 'pwd' }
    });
  });
});
