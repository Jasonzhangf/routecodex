import { applyDeepSeekWebResponseTransform } from '../../src/conversion/compat/actions/deepseek-web-response.js';

describe('responses deepseek web response compat', () => {
  test('propagates business envelope errors', () => {
    expect(() =>
      applyDeepSeekWebResponseTransform({
        code: 500,
        msg: 'Internal server error',
        data: null
      } as any)
    ).toThrow('[deepseek-web] upstream business error:');
  });

  test('harvests tool calls and usage through native compat', () => {
    const result = applyDeepSeekWebResponseTransform(
      {
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              tool_calls: [],
              content:
                '<function_calls>{"tool_calls":[{"name":"shell_command","arguments":{"command":"pwd"}}]}</function_calls>'
            }
          }
        ]
      } as any,
      {
        requestId: 'req_responses_deepseek_web_spec',
        compatibilityProfile: 'chat:deepseek-web',
        providerProtocol: 'openai-chat',
        estimatedInputTokens: 24,
        capturedChatRequest: {
          tools: [{ function: { name: 'exec_command' } }]
        }
      } as any
    );

    expect((result as any).choices[0].message.tool_calls[0].function.name).toBe('exec_command');
    expect((result as any).metadata.deepseek).toMatchObject({
      toolCallState: 'text_tool_calls',
      toolCallSource: 'fallback'
    });
    expect((result as any).usage.prompt_tokens).toBe(24);
  });

  test('harvests nameless tool_calls payload by inferring exec_command from input.cmd', () => {
    const result = applyDeepSeekWebResponseTransform(
      {
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              tool_calls: [],
              content:
                '{"tool_calls":[{"input":{"cmd":"cd /Users/fanzhang/Documents/github/webauto && node bin/webauto.mjs daemon status --json","justification":"检查daemon状态"}}]}'
            }
          }
        ]
      } as any,
      {
        requestId: 'req_responses_deepseek_web_nameless_spec',
        compatibilityProfile: 'chat:deepseek-web',
        providerProtocol: 'openai-chat',
        estimatedInputTokens: 24,
        capturedChatRequest: {
          tools: [{ function: { name: 'exec_command' } }]
        }
      } as any
    );

    expect((result as any).choices[0].finish_reason).toBe('tool_calls');
    expect((result as any).choices[0].message.tool_calls[0].function.name).toBe('exec_command');
    const args = JSON.parse((result as any).choices[0].message.tool_calls[0].function.arguments);
    expect(String(args.cmd || '')).toContain('node bin/webauto.mjs daemon status --json');
  });

  test('harvests markdown-bullet tool_calls payload shape', () => {
    const result = applyDeepSeekWebResponseTransform(
      {
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              tool_calls: [],
              content:
                '• {"tool_calls":[{"input":{"cmd":"cd /Users/fanzhang/Documents/github/webauto && node bin/webauto.mjs daemon start 2>&1"},"name":"exec_command"}]}'
            }
          }
        ]
      } as any,
      {
        requestId: 'req_responses_deepseek_web_markdown_bullet_spec',
        compatibilityProfile: 'chat:deepseek-web',
        providerProtocol: 'openai-chat',
        estimatedInputTokens: 24,
        capturedChatRequest: {
          tools: [{ function: { name: 'exec_command' } }]
        }
      } as any
    );

    expect((result as any).choices[0].finish_reason).toBe('tool_calls');
    expect((result as any).choices[0].message.tool_calls[0].function.name).toBe('exec_command');
  });

});
