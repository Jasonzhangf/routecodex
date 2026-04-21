import { describe, expect, it } from '@jest/globals';
import { applyDeepSeekWebResponseTransform } from '../../sharedmodule/llmswitch-core/src/conversion/compat/actions/deepseek-web-response.js';

describe('deepseek-web response compat', () => {
  it('allows final plain-text answers after tool-result resume when tool_choice is no longer required', () => {
    const payload: any = {
      id: 'chatcmpl_deepseek_resume_text_1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '当前目录是 /Users/fanzhang/Documents/github/routecodex'
          },
          finish_reason: 'stop'
        }
      ]
    };

    const out: any = applyDeepSeekWebResponseTransform(payload, {
      capturedChatRequest: {
        tools: [{ type: 'function', function: { name: 'exec_command' } }],
        tool_choice: 'auto'
      }
    } as any);

    expect(out.choices?.[0]?.message?.content).toContain('/Users/fanzhang/Documents/github/routecodex');
    expect(out.choices?.[0]?.message?.tool_calls).toBeUndefined();
    expect(out.choices?.[0]?.finish_reason).toBe('stop');
    expect(out.metadata?.deepseek).toMatchObject({
      toolCallState: 'no_tool_calls',
      toolCallSource: 'none'
    });
  });
});
