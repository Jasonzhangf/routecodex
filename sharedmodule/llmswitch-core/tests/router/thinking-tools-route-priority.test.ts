import { describe, expect, test } from '@jest/globals';

import { RoutingClassifier } from '../../src/router/virtual-router/classifier.js';
import { buildRoutingFeatures } from '../../src/router/virtual-router/features.js';

function classifyRouteWith(
  messages: Array<{ role: string; content: string }>,
  tools: Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>
): { routeName: string; reasoning: string } {
  const req = {
    model: 'gpt-test',
    messages,
    tools
  } as any;

  const features = buildRoutingFeatures(req, { requestId: 'req_test' } as any);
  const classifier = new RoutingClassifier({});
  const result = classifier.classify(features);
  return {
    routeName: result.routeName,
    reasoning: result.reasoning
  };
}

describe('virtual-router thinking vs declared tools priority', () => {
  test('routes current user turns to thinking even when only exec_command is declared', () => {
    const result = classifyRouteWith(
      [{ role: 'user', content: '继续处理当前任务。' }],
      [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
          }
        }
      ]
    );

    expect(result.routeName).toBe('thinking');
    expect(result.reasoning).toContain('thinking:user-input');
  });

  test('routes current user thinking turn to thinking even when tools are only declared', () => {
    const result = classifyRouteWith(
      [{ role: 'user', content: 'Please think step by step and explain the root cause.' }],
      [
        {
          type: 'function',
          function: {
            name: 'read_file',
            parameters: { type: 'object', properties: {} }
          }
        }
      ]
    );

    expect(result.routeName).toBe('thinking');
    expect(result.reasoning).toContain('thinking:user-input');
  });

  test('keeps tool followup context on tools when historical tool calls already exist', () => {
    const req = {
      model: 'gpt-test',
      messages: [
        { role: 'user', content: 'Please think step by step and continue.' },
        {
          role: 'assistant',
          content: 'tool turn',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: JSON.stringify({ path: 'a.txt' })
              }
            }
          ]
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            parameters: { type: 'object', properties: {} }
          }
        }
      ]
    } as any;

    const features = buildRoutingFeatures(req, { requestId: 'req_test_followup' } as any);
    const result = new RoutingClassifier({}).classify(features);

    expect(result.routeName).toBe('tools');
    expect(result.reasoning).toContain('tools:last-tool-other');
    expect(result.reasoning).not.toContain('thinking:user-input');
  });

  test('current user turn overrides previous search continuation to thinking', () => {
    const req = {
      model: 'gpt-test',
      messages: [
        { role: 'user', content: '先搜索路由配置。' },
        {
          role: 'assistant',
          content: 'search turn',
          tool_calls: [
            {
              id: 'call_search',
              type: 'function',
              function: {
                name: 'exec_command',
                arguments: JSON.stringify({ cmd: 'rg -n "routing" sharedmodule/llmswitch-core' })
              }
            }
          ]
        },
        { role: 'user', content: '继续。' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
          }
        }
      ]
    } as any;

    const features = buildRoutingFeatures(req, { requestId: 'req_test_user_overrides_search' } as any);
    const result = new RoutingClassifier({}).classify(features);

    expect(result.routeName).toBe('thinking');
    expect(result.reasoning).toContain('thinking:user-input');
  });

  test('prefers search continuation when previous responses turn included both search and read function calls', () => {
    const req = {
      model: 'gpt-test',
      messages: [],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
          }
        }
      ],
      semantics: {
        responses: {
          context: {
            input: [
              { type: 'message', role: 'user', content: '先找配置，再读文件。' },
              {
                type: 'function_call',
                id: 'call_search',
                name: 'exec_command',
                arguments: JSON.stringify({ cmd: 'rg -n "routing" sharedmodule/llmswitch-core' })
              },
              {
                type: 'function_call',
                id: 'call_read',
                name: 'exec_command',
                arguments: JSON.stringify({ cmd: 'cat sharedmodule/llmswitch-core/src/router/virtual-router/classifier.ts' })
              },
              { type: 'function_call_output', call_id: 'call_search', output: '...' },
              { type: 'function_call_output', call_id: 'call_read', output: '...' },
              { type: 'message', role: 'user', content: '继续。' }
            ]
          }
        }
      }
    } as any;

    const features = buildRoutingFeatures(req, { requestId: 'req_test_responses_search' } as any);
    const result = new RoutingClassifier({}).classify(features);

    expect(result.routeName).toBe('search');
    expect(result.reasoning).toContain('search:last-tool-search');
  });
});
