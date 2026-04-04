import { describe, expect, it } from '@jest/globals';

import { ProviderRequestPreprocessor } from '../../../../src/providers/core/runtime/provider-request-preprocessor.js';

describe('provider-request-preprocessor', () => {
  it('keeps assistant content untouched (no provider-layer semantic text rewrite)', () => {
    const req = {
      model: 'qwenchat.qwen3.6-plus',
      messages: [
        { role: 'system', content: 'you are assistant' },
        {
          role: 'assistant',
          content: 'Tool exec_command does not exists.Tool write_stdin does not exists.Jason, 我先分析。'
        },
        { role: 'user', content: '继续' }
      ]
    } as any;

    const out = ProviderRequestPreprocessor.preprocess(req);
    const assistant = out.messages?.[1];
    expect(assistant?.content).toContain('Jason, 我先分析。');
    expect(String(assistant?.content || '')).toContain('Tool exec_command does not exists');
    expect(String(assistant?.content || '')).toContain('Tool write_stdin does not exists');
  });

  it('keeps responses-style input assistant text untouched', () => {
    const req = {
      data: {
        model: 'qwenchat.qwen3.6-plus',
        input: [
          {
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'Tool exec_command does not exists. Tool update_plan does not exists.继续执行'
              }
            ]
          }
        ]
      }
    } as any;

    const out = ProviderRequestPreprocessor.preprocess(req);
    const text = out?.data?.input?.[0]?.content?.[0]?.text;
    expect(String(text || '')).toContain('继续执行');
    expect(String(text || '')).toContain('Tool exec_command does not exists');
    expect(String(text || '')).toContain('Tool update_plan does not exists');
  });
});
