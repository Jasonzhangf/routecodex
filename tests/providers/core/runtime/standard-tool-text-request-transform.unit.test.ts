import { describe, expect, it } from '@jest/globals';

import { applyStandardToolTextRequestTransform } from '../../../../src/providers/core/runtime/standard-tool-text-request-transform.js';

describe('standard-tool-text-request-transform', () => {
  it('does not apply provider-layer text sanitation to generated prompt', () => {
    const transformed = applyStandardToolTextRequestTransform(
      {
        model: 'qwen3.6-plus',
        messages: [
          { role: 'system', content: '你是 coding assistant' },
          {
            role: 'assistant',
            content:
              'Tool exec_command does not exists.Tool write_stdin does not exists.Jason，抱歉，当前会话无法直接执行本地终端命令。'
          },
          { role: 'user', content: '继续' }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              parameters: {
                type: 'object',
                properties: {
                  cmd: { type: 'string' }
                },
                required: ['cmd']
              }
            }
          }
        ],
        tool_choice: 'auto',
        stream: false
      } as any,
      {
        providerProtocol: 'openai-chat',
        entryEndpoint: '/v1/chat/completions'
      }
    );

    expect(typeof transformed.prompt).toBe('string');
    const prompt = String(transformed.prompt);
    expect(prompt).toContain('Tool exec_command does not exists');
    expect(prompt).toContain('Tool write_stdin does not exists');
    expect(prompt).toContain('继续');
  });
});
