import { ResponsesOpenAIConversionCodec } from '../responses-openai-codec.js';

describe('responses-openai-codec native wrapper', () => {
  const profile = {
    id: 'responses-openai-test',
    incomingProtocol: 'openai-responses',
    outgoingProtocol: 'openai-chat',
    codec: 'responses-openai'
  } as any;

  test('request maps responses input into openai chat request', async () => {
    const codec = new ResponsesOpenAIConversionCodec({});
    const result = await codec.convertRequest(
      {
        model: 'gpt-4.1',
        stream: true,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'run pwd' }
            ]
          }
        ],
        tools: [
          {
            type: 'function',
            name: 'exec_command',
            parameters: {
              type: 'object',
              properties: {
                cmd: { type: 'string' }
              }
            }
          }
        ]
      },
      profile,
      {
        requestId: 'req_responses_codec_request',
        entryEndpoint: '/v1/responses'
      } as any
    );

    expect((result as any).model).toBe('gpt-4.1');
    expect((result as any).stream).toBeUndefined();
    expect((result as any).messages[0]).toMatchObject({
      role: 'user',
      content: 'run pwd'
    });
    expect((result as any).tools[0]).toMatchObject({
      type: 'function',
      function: {
        name: 'exec_command'
      }
    });
  });

  test('response maps chat tool calls back to responses required_action payload', async () => {
    const codec = new ResponsesOpenAIConversionCodec({});
    await codec.convertRequest(
      {
        model: 'gpt-4.1',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'run pwd' }
            ]
          }
        ],
        tools: [
          {
            type: 'function',
            name: 'exec_command',
            parameters: {
              type: 'object',
              properties: {
                cmd: { type: 'string' }
              }
            }
          }
        ]
      },
      profile,
      {
        requestId: 'req_responses_codec_response',
        entryEndpoint: '/v1/responses'
      } as any
    );

    const result = await codec.convertResponse(
      {
        choices: [
          {
            finish_reason: null,
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call_demo_exec',
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
        requestId: 'req_responses_codec_response',
        entryEndpoint: '/v1/responses'
      } as any
    );

    expect((result as any).object).toBe('response');
    expect((result as any).status).toBe('requires_action');
    expect((result as any).required_action.submit_tool_outputs.tool_calls[0]).toMatchObject({
      id: 'call_demo_exec',
      tool_call_id: 'call_demo_exec',
      type: 'function',
      name: 'exec_command',
      arguments: '{"cmd":"pwd"}'
    });
    expect((result as any).output[0]).toMatchObject({
      type: 'function_call',
      call_id: 'call_demo_exec',
      name: 'exec_command',
      arguments: '{"cmd":"pwd"}'
    });
  });
});
