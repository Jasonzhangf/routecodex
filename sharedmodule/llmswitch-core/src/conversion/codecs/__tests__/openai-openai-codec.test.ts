import {
  runOpenAIRequestCodecDirectNative,
  runOpenAIResponseCodecDirectNative,
} from '../../../../../../tests/sharedmodule/helpers/openai-codec-direct-native.js';

describe('openai-openai codec direct native owner', () => {
  test('request passthrough keeps stream and stringifies tool arguments', async () => {
    const result = runOpenAIRequestCodecDirectNative(
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
      {
        requestId: 'req_openai_codec_request',
        entryEndpoint: '/v1/chat/completions',
        preserveStreamField: true,
      }
    );

    expect((result as any).model).toBe('gpt-4.1');
    expect((result as any).stream).toBe(true);
    expect((result as any).metadata).toBeUndefined();
    expect((result as any).messages[0].tool_calls[0].function.arguments).toBe('{"cmd":"pwd"}');
    expect((result as any).messages[0].tool_calls[0].call_id).toBeUndefined();
    expect((result as any).messages[0].tool_calls[0].tool_call_id).toBeUndefined();
  });

  test('response normalizes tool text and arguments', async () => {
    const result = runOpenAIResponseCodecDirectNative(
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
      {
        requestId: 'req_openai_codec_response_norm',
        entryEndpoint: '/v1/chat/completions'
      }
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
    const result = runOpenAIResponseCodecDirectNative(
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
      {
        requestId: 'req_openai_codec_finalize',
        entryEndpoint: '/v1/chat/completions'
      }
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
