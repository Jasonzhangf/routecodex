import { applyDeepSeekWebResponseTransform } from '../deepseek-web-response.js';

describe('deepseek-web-response action wrapper', () => {
  test('throws business envelope errors from native compat', () => {
    const payload = {
      code: 500,
      msg: 'Internal server error',
      data: null
    };

    expect(() => applyDeepSeekWebResponseTransform(payload as any)).toThrow(
      '[deepseek-web] upstream business error:'
    );
  });

  test('throws when declared tools are present but no valid tool call is produced', () => {
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

  test('backfills usage from estimated input tokens through native compat', () => {
    const payload = {
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'hello from deepseek usage estimation'
          }
        }
      ]
    };

    const result = applyDeepSeekWebResponseTransform(payload as any, {
      requestId: 'req_deepseek_usage_wrapper',
      compatibilityProfile: 'chat:deepseek-web',
      providerProtocol: 'openai-chat',
      estimatedInputTokens: 42,
      modelId: 'deepseek-chat'
    } as any);

    expect((result as any).usage).toMatchObject({
      prompt_tokens: 42,
      input_tokens: 42
    });
    expect((result as any).usage.completion_tokens).toBeGreaterThan(0);
    expect((result as any).usage.total_tokens).toBe(
      (result as any).usage.prompt_tokens + (result as any).usage.completion_tokens
    );
  });

  test('harvests text tool calls through native compat', () => {
    const payload = {
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

    const result = applyDeepSeekWebResponseTransform(payload as any, {
      requestId: 'req_deepseek_harvest_wrapper',
      compatibilityProfile: 'chat:deepseek-web',
      providerProtocol: 'openai-chat'
    } as any);

    expect((result as any).choices[0].finish_reason).toBe('tool_calls');
    expect((result as any).choices[0].message.tool_calls).toHaveLength(1);
    expect((result as any).choices[0].message.tool_calls[0].function.name).toBe('shell_command');
    expect((result as any).metadata.deepseek).toMatchObject({
      toolCallState: 'text_tool_calls',
      toolCallSource: 'fallback'
    });
  });

  test('harvests bullet-prefixed RCC heredoc tool calls through native compat', () => {
    const payload = {
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            tool_calls: [],
            content:
              '• <<RCC_TOOL_CALLS_JSON\n' +
              '{"tool_calls":[{"input":{"cmd":"sshpass -p password ssh -o ConnectTimeout=10 root@192.168.5.1 \\"echo ok\\""},"name":"exec_command"}]}\n' +
              'RCC_TOOL_CALLS_JSON'
          }
        }
      ]
    };

    const result = applyDeepSeekWebResponseTransform(payload as any, {
      requestId: 'req_deepseek_bullet_heredoc_wrapper',
      compatibilityProfile: 'chat:deepseek-web',
      providerProtocol: 'openai-chat',
      capturedChatRequest: {
        tools: [{ type: 'function', function: { name: 'exec_command' } }],
        tool_choice: 'auto'
      }
    } as any);

    expect((result as any).choices[0].finish_reason).toBe('tool_calls');
    expect((result as any).choices[0].message.tool_calls).toHaveLength(1);
    expect((result as any).choices[0].message.tool_calls[0].function.name).toBe('exec_command');
    expect(
      JSON.parse(String((result as any).choices[0].message.tool_calls[0].function.arguments || '{}')).cmd
    ).toContain('sshpass -p password ssh');
    expect((result as any).metadata.deepseek).toMatchObject({
      toolCallState: 'text_tool_calls',
      toolCallSource: 'fallback'
    });
  });
});
