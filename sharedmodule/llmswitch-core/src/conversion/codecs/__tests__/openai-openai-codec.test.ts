import { OpenAIOpenAIConversionCodec } from '../openai-openai-codec.js';

describe('openai-openai-codec native wrapper', () => {
  const profile = {
    id: 'openai-openai-test',
    incomingProtocol: 'openai-chat',
    outgoingProtocol: 'openai-chat',
    codec: 'openai-openai'
  } as any;

  test('request passthrough keeps stream and stringifies tool arguments', async () => {
    const codec = new OpenAIOpenAIConversionCodec({});
    const result = await codec.convertRequest(
      {
        model: 'gpt-4.1',
        stream: true,
        metadata: { shouldDrop: true },
        messages: [
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_1',
                call_id: 'call_1',
                tool_call_id: 'call_1',
                function: {
                  name: 'exec_command',
                  arguments: { cmd: 'pwd' }
                }
              }
            ]
          }
        ]
      },
      profile,
      {
        requestId: 'req_openai_codec_request',
        entryEndpoint: '/v1/chat/completions'
      } as any
    );

    expect((result as any).model).toBe('gpt-4.1');
    expect((result as any).stream).toBe(true);
    expect((result as any).metadata).toBeUndefined();
    expect((result as any).messages[0].tool_calls[0].function.arguments).toBe('{"cmd":"pwd"}');
    expect((result as any).messages[0].tool_calls[0].call_id).toBeUndefined();
    expect((result as any).messages[0].tool_calls[0].tool_call_id).toBeUndefined();
  });

  test('response normalizes tool text and arguments', async () => {
    const codec = new OpenAIOpenAIConversionCodec({});
    await codec.convertRequest(
      { model: 'gpt-4.1', stream: false, messages: [{ role: 'user', content: 'hi' }] },
      profile,
      {
        requestId: 'req_openai_codec_response_norm',
        entryEndpoint: '/v1/chat/completions'
      } as any
    );

    const result = await codec.convertResponse(
      {
        data: {
          choices: [
            {
              finish_reason: null,
              message: {
                role: 'assistant',
                content: 'Working on it',
                reasoning_content:
                  '<tool_call>{"name":"exec_command","arguments":{"cmd":"pwd"}}</tool_call>'
              }
            }
          ],
          messages: [
            {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call_1',
                  function: {
                    name: 'exec_command',
                    arguments: { cmd: 'pwd' }
                  }
                }
              ]
            },
            {
              role: 'tool',
              tool_call_id: 'call_1',
              content: { ok: true }
            }
          ]
        }
      },
      profile,
      {
        requestId: 'req_openai_codec_response_norm',
        entryEndpoint: '/v1/chat/completions'
      } as any
    );

    expect((result as any).choices[0].finish_reason).toBe('tool_calls');
    expect((result as any).choices[0].message.content).toBeNull();
    expect((result as any).choices[0].message.tool_calls[0].function.arguments).toBe('{"cmd":"pwd"}');
    expect((result as any).messages[1]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_1',
      name: 'exec_command',
      content: '{"ok":true}'
    });
  });

  test('response finalize keeps finish invariants and tool-call completion shape', async () => {
    const codec = new OpenAIOpenAIConversionCodec({});
    await codec.convertRequest(
      { model: 'gpt-4.1', stream: true, messages: [{ role: 'user', content: 'run pwd' }] },
      profile,
      {
        requestId: 'req_openai_codec_finalize',
        entryEndpoint: '/v1/chat/completions'
      } as any
    );

    const result = await codec.convertResponse(
      {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call_final',
                  function: {
                    name: 'exec_command',
                    arguments: { cmd: 'pwd' }
                  }
                }
              ]
            }
          }
        ]
      },
      profile,
      {
        requestId: 'req_openai_codec_finalize',
        entryEndpoint: '/v1/chat/completions'
      } as any
    );

    expect((result as any).choices[0]).toMatchObject({
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_final',
            type: 'function',
            function: {
              name: 'exec_command',
              arguments: '{"cmd":"pwd"}'
            }
          }
        ]
      }
    });
  });
});
