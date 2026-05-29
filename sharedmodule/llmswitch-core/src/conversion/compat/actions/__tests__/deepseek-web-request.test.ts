import { applyDeepSeekWebRequestTransform } from '../deepseek-web-request.js';

describe('deepseek-web-request action wrapper', () => {
  test('injects tool text guidance when toolProtocol=text', () => {
    const result = applyDeepSeekWebRequestTransform(
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'run pwd' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              description: 'run shell',
              parameters: {
                type: 'object',
                properties: { cmd: { type: 'string' } },
                required: ['cmd']
              }
            }
          }
        ]
      } as any,
      {
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:deepseek-web',
        deepseek: {
          toolProtocol: 'text'
        }
      } as any
    );

    expect((result as any).prompt).toContain('Tool-call output contract (STRICT)');
    expect((result as any).prompt).toContain('<tool_call>');
    expect((result as any).prompt).toContain('"name"');
    expect((result as any).prompt).toContain('"arguments"');
  });

  test('enables search for routeId/web_search triggers', () => {
    const withRoute = applyDeepSeekWebRequestTransform(
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'find news' }]
      } as any,
      {
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:deepseek-web',
        routeId: 'web_search-primary'
      } as any
    );

    const withPayloadSearch = applyDeepSeekWebRequestTransform(
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'find docs' }],
        web_search: { enabled: true }
      } as any,
      {
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:deepseek-web'
      } as any
    );

    expect((withRoute as any).search_enabled).toBe(true);
    expect((withPayloadSearch as any).search_enabled).toBe(true);
  });

  test('maps model families to thinking/search flags through native compat', () => {
    const reasoner = applyDeepSeekWebRequestTransform(
      {
        model: 'deepseek-r1-search',
        messages: [{ role: 'user', content: 'think and search' }]
      } as any,
      {
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:deepseek-web'
      } as any
    );

    const chat = applyDeepSeekWebRequestTransform(
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'plain chat' }]
      } as any,
      {
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:deepseek-web'
      } as any
    );

    expect((reasoner as any).thinking_enabled).toBe(true);
    expect((reasoner as any).search_enabled).toBe(true);
    expect((chat as any).thinking_enabled).toBe(false);
    expect((chat as any).search_enabled).toBe(false);
  });

  test('preserves metadata.deepseek passthrough fields while adding native defaults', () => {
    const result = applyDeepSeekWebRequestTransform(
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'hello' }],
        metadata: {
          requestLabel: 'keep',
          deepseek: {
            customFlag: 'keep-me'
          }
        }
      } as any,
      {
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:deepseek-web',
        deepseek: {
          toolProtocol: 'text'
        }
      } as any
    );

    expect((result as any).metadata.requestLabel).toBe('keep');
    expect((result as any).metadata.deepseek).toMatchObject({
      strictToolRequired: true,
      textToolFallback: true,
      customFlag: 'keep-me'
    });
  });

  test('does not force another required tool call when latest turn is a tool result resume', () => {
    const result = applyDeepSeekWebRequestTransform(
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'user', content: '请执行 pwd' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: JSON.stringify({ cmd: "bash -lc 'pwd'" })
                }
              }
            ]
          },
          {
            role: 'tool',
            tool_call_id: 'call_1',
            name: 'exec_command',
            content: '{"stdout":"/tmp","exit_code":0}'
          }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              description: 'run shell',
              parameters: {
                type: 'object',
                properties: { cmd: { type: 'string' } },
                required: ['cmd']
              }
            }
          }
        ]
      } as any,
      {
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:deepseek-web',
        routeId: 'tools-deepseek-web-primary'
      } as any
    );

    expect((result as any).prompt).toContain('[Previous tool output — result of a prior tool call');
    expect((result as any).prompt).toContain('tool_call_id: call_1');
    expect((result as any).prompt).toContain('tool_name: exec_command');
    expect((result as any).prompt).toContain('output:\n{"stdout":"/tmp","exit_code":0}');
    expect(
      ((result as any).prompt.match(/\[Previous tool output — result of a prior tool call/g) ?? [])
        .length
    ).toBe(1);
    expect((result as any).prompt).not.toContain('tool_choice is required for this turn');
    expect((result as any).prompt).not.toContain('This turn is tool-required');
  });

  test('serializes prior assistant tool calls using mimoweb-style tool_call wrappers', () => {
    const result = applyDeepSeekWebRequestTransform(
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'user', content: '请继续' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: JSON.stringify({ cmd: "bash -lc 'pwd'" })
                }
              }
            ]
          }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              description: 'run shell',
              parameters: {
                type: 'object',
                properties: { cmd: { type: 'string' } },
                required: ['cmd']
              }
            }
          }
        ]
      } as any,
      {
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:deepseek-web',
        deepseek: {
          toolProtocol: 'text'
        }
      } as any
    );

    expect((result as any).prompt).toContain('<tool_call>');
    expect((result as any).prompt).toContain('"id":"call_1"');
    expect((result as any).prompt).toContain('"name":"exec_command"');
    expect((result as any).prompt).toContain('"arguments":{"cmd":"bash -lc');
    expect((result as any).prompt).not.toContain('<<RCC_TOOL_CALLS_JSON');
  });

  test('emits RCC_HISTORY contextFile metadata and continuation prompt when enabled', () => {
    const result = applyDeepSeekWebRequestTransform(
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: 'follow contract' },
          { role: 'user', content: '先分析代码' },
          { role: 'assistant', content: '我先看下' },
          { role: 'user', content: '继续' }
        ],
        metadata: {
          deepseek: {
            contextFile: { enabled: true }
          }
        }
      } as any,
      {
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:deepseek-web',
        deepseek: {
          contextFile: { enabled: true }
        }
      } as any
    );

    expect((result as any).prompt).toContain('attached context');
    expect((result as any).prompt).not.toContain('先分析代码');
    expect((result as any).metadata.deepseek.contextFile.filename).toBe('context.txt');
    expect((result as any).metadata.deepseek.contextFile.contentType).toBe('text/plain; charset=utf-8');
    expect((result as any).metadata.deepseek.contextFile.content).toContain('# context');
    expect((result as any).metadata.deepseek.contextFile.content).toContain('=== 1. SYSTEM ===');
    expect((result as any).metadata.deepseek.contextFile.content).toContain('=== 2. USER ===');
    expect((result as any).metadata.deepseek.contextFile.content).not.toContain('Tool-call output contract (STRICT)');
    expect((result as any).metadata.deepseek.contextFile.content).not.toContain('This turn is tool-required.');
  });

  test('uses unified continuation semantics to mark submitted tool result as already completed', () => {
    const result = applyDeepSeekWebRequestTransform(
      {
        model: 'deepseek-v4-pro',
        messages: [
          { role: 'user', content: '调用 exec_command 工具执行 pwd，然后返回工具调用，不要直接回答。' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: JSON.stringify({ cmd: "bash -lc 'pwd'" })
                }
              }
            ]
          },
          {
            role: 'tool',
            tool_call_id: 'call_1',
            name: 'exec_command',
            content: '/Users/fanzhang/Documents/github/routecodex'
          }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              parameters: {
                type: 'object',
                properties: { cmd: { type: 'string' } },
                required: ['cmd']
              }
            }
          }
        ],
        semantics: {
          continuation: {
            chainId: 'req_chain_1',
            continuationScope: 'request_chain',
            stateOrigin: 'openai-responses',
            restored: true,
            toolContinuation: {
              mode: 'submit_tool_outputs',
              submittedToolCallIds: ['call_1'],
              resumeOutputs: ['/Users/fanzhang/Documents/github/routecodex']
            }
          }
        },
        metadata: {
          deepseek: {
            contextFile: { enabled: true }
          }
        }
      } as any,
      {
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:deepseek-web',
        routeId: 'tools-deepseek-web-primary',
        deepseek: {
          contextFile: { enabled: true }
        }
      } as any
    );

    expect((result as any).prompt).toContain('The latest tool result has already been submitted.');
    expect((result as any).prompt).toContain('Do not repeat the same tool call');
    expect((result as any).prompt).toContain('Tool call ids already completed in this continuation: call_1.');
    expect((result as any).metadata.deepseek.contextFile.content).toContain('tool_call_id: call_1');
    expect((result as any).metadata.deepseek.contextFile.content).toContain('/Users/fanzhang/Documents/github/routecodex');
  });
});
