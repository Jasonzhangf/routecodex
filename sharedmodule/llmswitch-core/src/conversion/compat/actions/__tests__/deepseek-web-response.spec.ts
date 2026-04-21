import { applyDeepSeekWebResponseTransform } from '../deepseek-web-response.js';

describe('deepseek-web-response action spec', () => {
  test('uses native compat for upstream business envelope errors', () => {
    expect(() =>
      applyDeepSeekWebResponseTransform({
        code: 500,
        msg: 'Internal server error',
        data: null
      } as any)
    ).toThrow('[deepseek-web] upstream business error:');
  });

  test('uses native compat for required-tool enforcement', () => {
    expect(() =>
      applyDeepSeekWebResponseTransform(
        {
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'no tool call here'
              },
              finish_reason: 'stop'
            }
          ]
        } as any,
        {
          capturedChatRequest: {
            tools: [{ function: { name: 'exec_command' } }],
            tool_choice: 'required'
          },
          deepseek: {
            strictToolRequired: true,
            toolProtocol: 'native'
          }
        } as any
      )
    ).toThrow('DeepSeek declared tools present but no valid tool call was produced');
  });
});
