import {
  requestContextFromNativeResult,
  runResponsesOpenAIRequestCodecDirectNative,
  runResponsesOpenAIResponseCodecDirectNative,
} from '../../../../../../tests/sharedmodule/helpers/responses-codec-direct-native.js';
import { buildResponsesPayloadFromChat } from '../../responses/responses-openai-bridge/response-payload.js';

describe('responses-openai codec direct native owner', () => {
  test('request maps responses input into openai chat request', async () => {
    const native = runResponsesOpenAIRequestCodecDirectNative(
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
      {
        requestId: 'req_responses_codec_request',
      }
    );
    const result = native.request as Record<string, unknown>;

    expect((result as any).model).toBe('gpt-4.1');
    expect((result as any).stream).toBeUndefined();
    expect((result as any).messages[0]).toMatchObject({
      role: 'user',
      content: 'run pwd'
    });
    expect((result as any).tools[0]).toMatchObject({
      type: 'function',
      name: 'exec_command'
    });
  });

  test('response maps chat tool calls back to responses required_action payload', async () => {
    const native = runResponsesOpenAIRequestCodecDirectNative(
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
      {
        requestId: 'req_responses_codec_response',
      }
    );
    const nativeContext = requestContextFromNativeResult(native, {
      requestId: 'req_responses_codec_response',
      entryEndpoint: '/v1/responses'
    });

    const result = runResponsesOpenAIResponseCodecDirectNative(
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
      nativeContext
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

  test('responses codec keeps exec_command tool calls cmd-only for declared cmd schema', () => {
    const profile = {
      clientProtocol: 'openai-responses',
      entryEndpoint: '/v1/responses'
    };

    const result = buildResponsesPayloadFromChat(
      {
        id: 'resp_cmd_only_1',
        model: 'deepseek-reasoner',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call_cmd_only_1',
                  function: {
                    name: 'exec_command',
                    arguments: { cmd: "bash -lc 'pwd'" }
                  }
                }
              ]
            }
          }
        ]
      },
      profile,
      {
        requestId: 'req_responses_codec_cmd_only',
        entryEndpoint: '/v1/responses'
      } as any
    );

    expect((result as any).required_action.submit_tool_outputs.tool_calls[0]).toMatchObject({
      id: 'call_cmd_only_1',
      tool_call_id: 'call_cmd_only_1',
      type: 'function',
      name: 'exec_command',
      arguments: '{"cmd":"bash -lc \'pwd\'"}'
    });
    expect((result as any).required_action.submit_tool_outputs.tool_calls[0].arguments).not.toContain(
      '"command"'
    );
    expect((result as any).output[0]).toMatchObject({
      type: 'function_call',
      call_id: 'call_cmd_only_1',
      name: 'exec_command',
      arguments: '{"cmd":"bash -lc \'pwd\'"}'
    });
    expect((result as any).output[0].arguments).not.toContain('"command"');
  });

  test('responses codec normalizes custom tool items into standard function call items', () => {
    const profile = {
      clientProtocol: 'openai-responses',
      entryEndpoint: '/v1/responses'
    };

    const result = buildResponsesPayloadFromChat(
      {
        id: 'resp_custom_tool_1',
        object: 'response',
        status: 'requires_action',
        output: [
          {
            type: 'custom_tool_call',
            call_id: 'call_patch_1',
            name: 'apply_patch',
            input: '*** Begin Patch\n*** End Patch'
          },
          {
            type: 'custom_tool_call_output',
            call_id: 'call_patch_1',
            output: 'Exit code: 0'
          }
        ],
        required_action: {
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_patch_1',
                tool_call_id: 'call_patch_1',
                type: 'function',
                name: 'apply_patch',
                arguments: '{"patch":"*** Begin Patch\\n*** End Patch"}'
              }
            ]
          }
        }
      },
      profile,
      {
        requestId: 'req_responses_codec_custom_tool_output',
        entryEndpoint: '/v1/responses'
      } as any
    );

    expect((result as any).output[0]).toMatchObject({
      type: 'function_call',
      call_id: 'call_patch_1',
      name: 'apply_patch'
    });
    expect((result as any).output[1]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_patch_1',
      output: 'Exit code: 0'
    });
  });

  test('request context is returned explicitly instead of hidden in TS state', async () => {
    const native = runResponsesOpenAIRequestCodecDirectNative(
      { model: 'gpt-4.1', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'one' }] }] },
      { requestId: 'req_responses_codec_context' }
    );
    expect((native as any).context).toMatchObject({ requestId: 'req_responses_codec_context' });
    expect((native as any).__ctxCreatedAt).toBeUndefined();
  });
});
