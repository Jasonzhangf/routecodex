import { describe, expect, it } from '@jest/globals';

import { applyStandardToolTextRequestTransform } from '../../../../src/providers/core/runtime/standard-tool-text-request-transform.js';

describe('standard-tool-text-request-transform', () => {
  it('drops stale assistant tool-registry failure history before generating prompt', () => {
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
    expect(prompt).not.toContain('Tool exec_command does not exists');
    expect(prompt).not.toContain('Tool write_stdin does not exists');
    expect(prompt).toContain('exec_command');
    expect(prompt).toContain('继续');
  });

  it('keeps current user-quoted tool error text while filtering stale assistant history', () => {
    const transformed = applyStandardToolTextRequestTransform(
      {
        model: 'qwen3.6-plus',
        messages: [
          {
            role: 'assistant',
            content: 'Tool apply_patch does not exists.Tool exec_command does not exists.'
          },
          {
            role: 'user',
            content: '检查这个错误：Tool exec_command does not exists.'
          }
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
        ]
      } as any,
      {
        providerProtocol: 'openai-chat',
        entryEndpoint: '/v1/chat/completions'
      }
    );

    const prompt = String(transformed.prompt || '');
    const quotedOccurrences = prompt.match(/Tool exec_command does not exists/g) || [];
    expect(quotedOccurrences).toHaveLength(1);
    expect(prompt).toContain('检查这个错误');
  });

  it('drops historical user relayed machine-noise with repeated tool-missing text but keeps final user turn', () => {
    const transformed = applyStandardToolTextRequestTransform(
      {
        model: 'qwen3.6-plus',
        messages: [
          {
            role: 'user',
            content:
              '🤖 派发更新：原因: Tool exec_command does not exists.Tool agent_list does not exists.Tool exec_command does not exists.'
          },
          {
            role: 'user',
            content: '当前先分析根因，不要再返回 Tool exec_command does not exists。'
          }
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
        ]
      } as any,
      {
        providerProtocol: 'openai-chat',
        entryEndpoint: '/v1/chat/completions'
      }
    );

    const prompt = String(transformed.prompt || '');
    expect(prompt).not.toContain('🤖 派发更新');
    expect(prompt).toContain('当前先分析根因');
    const execMissingCount = (prompt.match(/Tool exec_command does not exists/g) || []).length;
    expect(execMissingCount).toBe(1);
  });
});
