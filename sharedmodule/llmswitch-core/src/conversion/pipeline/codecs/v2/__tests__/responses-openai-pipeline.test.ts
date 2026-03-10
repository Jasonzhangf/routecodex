import { ResponsesOpenAIPipelineCodec } from '../responses-openai-pipeline.js';

describe('responses-openai-pipeline native shell', () => {
  const profile = {
    id: 'responses-openai-v2-test',
    incomingProtocol: 'openai-responses',
    outgoingProtocol: 'openai-chat',
    codec: 'responses-openai-v2'
  } as any;

  test('request path keeps tool id and openai request shape', async () => {
    const codec = new ResponsesOpenAIPipelineCodec();
    await codec.initialize();

    const result = await codec.convertRequest(
      {
        model: 'gpt-4.1',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'run pwd' }]
          }
        ],
        tools: [
          {
            type: 'function',
            name: 'exec_command',
            parameters: {
              type: 'object',
              properties: { cmd: { type: 'string' } }
            }
          }
        ]
      },
      profile,
      {
        requestId: 'req_responses_pipeline_request',
        entryEndpoint: '/v1/responses',
        endpoint: '/v1/responses',
        metadata: {}
      } as any
    );

    expect((result as any).model).toBe('gpt-4.1');
    expect((result as any).messages[0]).toMatchObject({ role: 'user', content: 'run pwd' });
    expect((result as any).tools[0]).toMatchObject({
      type: 'function',
      function: { name: 'exec_command' }
    });
  });

  test('response path replays stored responses context into required_action payload', async () => {
    const codec = new ResponsesOpenAIPipelineCodec();
    await codec.initialize();

    await codec.convertRequest(
      {
        model: 'gpt-4.1',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'run pwd' }]
          }
        ],
        tools: [
          {
            type: 'function',
            name: 'exec_command',
            parameters: {
              type: 'object',
              properties: { cmd: { type: 'string' } }
            }
          }
        ]
      },
      profile,
      {
        requestId: 'req_responses_pipeline_response',
        entryEndpoint: '/v1/responses',
        endpoint: '/v1/responses',
        metadata: {}
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
        requestId: 'req_responses_pipeline_response',
        entryEndpoint: '/v1/responses',
        endpoint: '/v1/responses',
        metadata: {}
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
