import { applyDeepSeekWebResponseTransform } from '../actions/deepseek-web-response.js';

describe('deepseek-web-response compat wrapper', () => {
  test('throws when native compat reports required tool missing', () => {
    const payload = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'I will help you with that.'
          },
          finish_reason: 'stop'
        }
      ]
    };

    const adapterContext = {
      capturedChatRequest: {
        tools: [{ function: { name: 'exec_command' } }],
        tool_choice: 'required'
      },
      deepseek: {
        strictToolRequired: true,
        toolProtocol: 'native'
      }
    };

    expect(() =>
      applyDeepSeekWebResponseTransform(payload as any, adapterContext as any)
    ).toThrow('DeepSeek declared tools present but no valid tool call was produced');
  });

  test('throws business errors from upstream envelope', () => {
    const payload = {
      code: 500,
      msg: 'Internal server error',
      data: null
    };

    expect(() => applyDeepSeekWebResponseTransform(payload as any)).toThrow(
      '[deepseek-web] upstream business error:'
    );
  });

  test('fails fast when payload is missing required response shape', () => {
    expect(() =>
      applyDeepSeekWebResponseTransform(
        {
          code: 0,
          data: {
            ok: true
          }
        } as any,
        {
          requestId: 'req_deepseek_missing_fields'
        } as any
      )
    ).toThrow(/deepseek-web/i);
  });

  test('preserves native tool calls and deepseek metadata', () => {
    const payload = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_123',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: '{"cmd": "ls"}'
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    };

    const result = applyDeepSeekWebResponseTransform(payload as any);
    expect((result as any).choices[0].message.tool_calls).toHaveLength(1);
    expect((result as any).metadata.deepseek).toMatchObject({
      toolCallState: 'native_tool_calls',
      toolCallSource: 'native'
    });
  });

  test('supports text tool protocol and records fallback state', () => {
    const payload = {
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            tool_calls: [],
            content:
              '<function_calls>{"tool_calls":[{"name":"exec_command","arguments":{"cmd":"ls"}}]}</function_calls>'
          }
        }
      ]
    };

    const result = applyDeepSeekWebResponseTransform(payload as any, {
      providerProtocol: 'openai-chat',
      compatibilityProfile: 'chat:deepseek-web',
      deepseek: {
        toolProtocol: 'text'
      }
    } as any);

    expect((result as any).choices[0].message.tool_calls).toHaveLength(1);
    expect((result as any).metadata.deepseek).toMatchObject({
      toolCallState: 'text_tool_calls',
      toolCallSource: 'fallback'
    });
  });
});
