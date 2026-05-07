import { applyDeepSeekWebResponseTransform } from '../../sharedmodule/llmswitch-core/src/conversion/compat/actions/deepseek-web-response.js';

describe('deepseek-web text tool-call harvest', () => {
  it('harvests explicit <tool_call> json wrapper into exec_command tool_call', () => {
    const payload: any = {
      id: 'chatcmpl_deepseek_tool_call_wrapper_1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: [
              '准备执行。',
              '<tool_call>',
              '{"name":"exec_command","arguments":{"cmd":"bash -lc \\"pwd\\"","workdir":"/Users/fanzhang/Documents/github/routecodex"}}',
              '</tool_call>'
            ].join('\n'),
            tool_calls: []
          },
          finish_reason: 'stop'
        }
      ]
    };

    const out: any = applyDeepSeekWebResponseTransform(payload, {
      compatibilityProfile: 'chat:deepseek-web',
      providerProtocol: 'openai-chat',
      capturedChatRequest: {
        tools: [{ type: 'function', function: { name: 'exec_command' } }],
        tool_choice: 'required'
      }
    } as any);

    const call = out.choices?.[0]?.message?.tool_calls?.[0];
    expect(out.choices?.[0]?.finish_reason).toBe('tool_calls');
    expect(call?.function?.name).toBe('exec_command');
    expect(JSON.parse(String(call?.function?.arguments || '{}'))).toEqual({
      cmd: 'bash -lc "pwd"',
      workdir: '/Users/fanzhang/Documents/github/routecodex'
    });
  });

  it('harvests explicit <function_calls> wrapper into normalized exec_command tool_call', () => {
    const payload: any = {
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            tool_calls: [],
            content:
              '<function_calls>{"tool_calls":[{"id":"call_deepseek_1","type":"function","function":{"name":"shell_command","arguments":{"command":"pwd","cwd":"/tmp"}}}]}</function_calls>'
          }
        }
      ]
    };

    const out: any = applyDeepSeekWebResponseTransform(payload, {
      requestId: 'req_deepseek_wrapper_function_calls',
      compatibilityProfile: 'chat:deepseek-web',
      providerProtocol: 'openai-chat'
    } as any);

    expect(out.choices?.[0]?.finish_reason).toBe('tool_calls');
    expect(out.choices?.[0]?.message?.tool_calls).toHaveLength(1);
    expect(out.choices?.[0]?.message?.tool_calls?.[0]?.function?.name).toBe('exec_command');
  });

  it('fails fast for RCC wrapper with truncated closing boundary', () => {
    const payload: any = {
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            tool_calls: [],
            content: '<<RCC_TOOL_CALLS_JSON\n{"tool_calls":[{"name":"exec_command","input":{"cmd":"pwd"}}]}'
          }
        }
      ]
    };

    expect(() =>
      applyDeepSeekWebResponseTransform(payload, {
        requestId: 'req_deepseek_wrapper_rcc_truncated',
        compatibilityProfile: 'chat:deepseek-web',
        providerProtocol: 'openai-chat',
        capturedChatRequest: {
          tools: [{ type: 'function', function: { name: 'exec_command' } }],
          tool_choice: 'required'
        }
      } as any)
    ).toThrow('DeepSeek declared tools present but no valid tool call was produced');
  });

  it('harvests SSE-style fenced <tool_call> wrappers', () => {
    const content = [
      '```xml',
      '<tool_call>',
      '{"name":"update_plan","arguments":{"plan":[{"step":"验证 deepseek-web wrapper-only 收割","status":"completed"}]}}',
      '</tool_call>',
      '```',
      '```xml',
      '<tool_call>',
      '{"name":"exec_command","arguments":{"cmd":"bash -lc \\"pwd\\""}}',
      '</tool_call>',
      '```'
    ].join('\n');

    const payload: any = {
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            tool_calls: [],
            content
          }
        }
      ]
    };

    const out: any = applyDeepSeekWebResponseTransform(payload, {
      requestId: 'req_deepseek_wrapper_fenced',
      compatibilityProfile: 'chat:deepseek-web',
      providerProtocol: 'openai-chat',
      capturedChatRequest: {
        tools: [
          { type: 'function', function: { name: 'update_plan' } },
          { type: 'function', function: { name: 'exec_command' } }
        ],
        tool_choice: 'required'
      }
    } as any);

    expect(out.choices?.[0]?.finish_reason).toBe('tool_calls');
    expect(out.choices?.[0]?.message?.tool_calls).toHaveLength(2);
    expect(out.choices?.[0]?.message?.tool_calls?.[0]?.function?.name).toBe('update_plan');
    expect(out.choices?.[0]?.message?.tool_calls?.[1]?.function?.name).toBe('exec_command');
  });

  it('fails fast for prose plus top-level json outside wrapper', () => {
    const payload: any = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: '我将按以下步骤执行：\n\n{"tool_calls":[{"name":"exec_command","input":{"command":"bd --no-db ready"}}]}'
          },
          finish_reason: 'stop'
        }
      ]
    };

    expect(() =>
      applyDeepSeekWebResponseTransform(payload, {
        compatibilityProfile: 'chat:deepseek-web',
        providerProtocol: 'openai-chat',
        capturedChatRequest: {
          tools: [{ type: 'function', function: { name: 'exec_command' } }],
          tool_choice: 'required'
        }
      } as any)
    ).toThrow('DeepSeek declared tools present but no valid tool call was produced');
  });

  it('fails fast for quote-wrapped tool json outside wrapper', () => {
    const payload: any = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: '原文是：<quote>{"tool_calls":[{"name":"exec_command","input":{"cmd":"git status"}}]}</quote>'
          },
          finish_reason: 'stop'
        }
      ]
    };

    expect(() =>
      applyDeepSeekWebResponseTransform(payload, {
        compatibilityProfile: 'chat:deepseek-web',
        providerProtocol: 'openai-chat',
        capturedChatRequest: {
          tools: [{ type: 'function', function: { name: 'exec_command' } }],
          tool_choice: 'required'
        }
      } as any)
    ).toThrow('DeepSeek declared tools present but no valid tool call was produced');
  });

  it('fails fast for mimoweb-style invoke XML transport markup', () => {
    const payload: any = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: [
              '<function_calls>',
              '<invoke name="exec_command">',
              '<parameter name="cmd">bash -lc "ls -la"</parameter>',
              '</invoke>',
              '</function_calls>'
            ].join('\n')
          },
          finish_reason: 'stop'
        }
      ]
    };

    expect(() =>
      applyDeepSeekWebResponseTransform(payload, {
        compatibilityProfile: 'chat:deepseek-web',
        providerProtocol: 'openai-chat',
        capturedChatRequest: {
          tools: [{ type: 'function', function: { name: 'exec_command' } }],
          tool_choice: 'required'
        }
      } as any)
    ).toThrow('forbidden hidden tool transport markup');
  });
});
