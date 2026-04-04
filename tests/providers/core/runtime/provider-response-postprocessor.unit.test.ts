import { describe, expect, it } from '@jest/globals';

import { buildPostprocessedProviderResponse } from '../../../../src/providers/core/runtime/provider-response-postprocessor.js';

describe('provider-response-postprocessor', () => {
  it('keeps chat completion content untouched (no provider-layer semantic text rewrite)', () => {
    const out = buildPostprocessedProviderResponse({
      response: {
        data: {
          id: 'chatcmpl-x',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'Tool exec_command does not exists.Tool write_stdin does not exists.继续执行'
              }
            }
          ]
        },
        status: 200
      },
      context: {
        requestId: 'req-chat-1',
        startTime: Date.now() - 10
      } as any,
      providerType: 'openai'
    });

    const text = (out as any)?.data?.choices?.[0]?.message?.content || '';
    expect(String(text)).toContain('继续执行');
    expect(String(text)).toContain('Tool exec_command does not exists');
    expect(String(text)).toContain('Tool write_stdin does not exists');
  });

  it('keeps responses output_text untouched', () => {
    const out = buildPostprocessedProviderResponse({
      response: {
        data: {
          id: 'resp-x',
          object: 'response',
          output: [
            {
              type: 'output_text',
              text: 'Tool update_plan does not exists.Tool agent_list does not exists.继续'
            }
          ]
        },
        status: 200
      },
      context: {
        requestId: 'req-resp-1',
        startTime: Date.now() - 10
      } as any,
      providerType: 'responses'
    });

    const text = (out as any)?.data?.output?.[0]?.text || '';
    expect(String(text)).toContain('继续');
    expect(String(text)).toContain('Tool update_plan does not exists');
    expect(String(text)).toContain('Tool agent_list does not exists');
  });
});
