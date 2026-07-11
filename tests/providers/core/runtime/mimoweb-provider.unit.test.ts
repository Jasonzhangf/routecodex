import { afterEach, describe, expect, it, jest } from '@jest/globals';

const mockResolveModelId = jest.fn(async (model: string) => model);
const mockCallMimoWeb = jest.fn();
const mockNormalizeAssistantTextToToolCallsJson = jest.fn(async (message: Record<string, unknown>) => {
  const content = typeof message.content === 'string' ? message.content : '';
  if (content.includes('"tool_calls"')) {
    return {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'toolu_mimo_read_1',
          type: 'function',
          function: {
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/a.txt' })
          }
        }
      ]
    };
  }
  if (content.includes('<tool_call>{"arguments":{"filePath":"/tmp/a.txt"}}</tool_call>')) {
    return {
      role: 'assistant',
      content,
      tool_calls: []
    };
  }
  if (content.includes('<think>')) {
    return {
      role: 'assistant',
      content,
      tool_calls: []
    };
  }
  if (content.includes('<read><filePath>/tmp/a.txt</filePath></read>')) {
    return {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'toolu_mimo_read_xml_1',
          type: 'function',
          function: {
            name: 'read',
            arguments: JSON.stringify({ filePath: '/tmp/a.txt' })
          }
        }
      ]
    };
  }
  return {
    role: 'assistant',
    content,
    tool_calls: []
  };
});

jest.unstable_mockModule('../../../../src/providers/core/runtime/mimoweb/mimoweb-client.js', () => ({
  resolveModelId: mockResolveModelId,
  callMimoWeb: mockCallMimoWeb
}));

jest.unstable_mockModule('../../../../src/providers/core/utils/provider-error-reporter.js', () => ({
  emitProviderError: jest.fn(),
  emitProviderErrorAndWait: jest.fn(),
  emitProviderSuccessAndWait: jest.fn(),
  buildRuntimeFromProviderContext: jest.fn(() => ({ requestId: 'test-request' })),
  buildRuntimeFromCompatContext: jest.fn(() => ({ requestId: 'test-request' }))
}));

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/mimoweb-tool-harvest-host.js', () => ({
  normalizeAssistantTextToToolCallsJson: mockNormalizeAssistantTextToToolCallsJson
}));

import type { OpenAIStandardConfig } from '../../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import { attachProviderRuntimeMetadata } from '../../../../src/providers/core/runtime/provider-runtime-metadata.js';
const { MimowebProvider } = await import('../../../../src/providers/core/runtime/mimoweb/mimoweb-provider.js');
import { buildToolSystemPrompt } from '../../../../src/providers/core/runtime/mimoweb/mimoweb-tool-guidance.js';

const deps: ModuleDependencies = {
  logger: {
    logModule: () => {},
    logProviderRequest: () => {}
  }
} as ModuleDependencies;

function buildProvider(): MimowebProvider {
  return new MimowebProvider(
    {
      type: 'mimoweb-provider',
      config: {
        providerType: 'anthropic',
        providerId: 'mimoweb',
        auth: {
          apiKey: JSON.stringify({
            serviceToken: 'svc-token',
            userId: 'user-1',
            phToken: 'ph-token'
          })
        }
      }
    } as unknown as OpenAIStandardConfig,
    deps
  );
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('mimoweb provider tool harvest', () => {
  it('maps harvested tool calls into anthropic tool_use blocks', async () => {
    mockCallMimoWeb.mockImplementation(
      (async function* () {
        yield {
          type: 'text',
          content: '{"tool_calls":[{"id":"toolu_mimo_read_1","name":"read","input":{"filePath":"/tmp/a.txt"}}]}'
        };
        yield {
          type: 'usage',
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            reasoningTokens: 0
          }
        };
      }) as typeof callMimoWeb
    );

    const provider = buildProvider();
    await provider.initialize();
    const response = await provider.sendRequest({
      model: 'mimo-v2.5-pro',
      messages: [{ role: 'user', content: 'read /tmp/a.txt' }],
      tools: []
    });

    expect((response as any).stop_reason).toBe('tool_use');
    expect((response as any).content).toEqual([
      {
        type: 'tool_use',
        id: 'toolu_mimo_read_1',
        name: 'read',
        input: {
          filePath: '/tmp/a.txt'
        }
      }
    ]);
    expect(mockNormalizeAssistantTextToToolCallsJson).toHaveBeenCalled();
  });

  it('normalizes openai function tools before building mimoweb tool guidance', () => {
    const prompt = buildToolSystemPrompt([
      {
        type: 'function',
        function: {
          name: 'read',
          description: 'Read a file from disk',
          parameters: {
            type: 'object',
            properties: {
              filePath: { type: 'string' }
            },
            required: ['filePath'],
            additionalProperties: false
          }
        }
      } as any
    ]);

    expect(prompt).toContain('可用工具：read(filePath*:string)');
    expect(prompt).not.toContain('undefined()');
    expect(prompt).toContain('禁止输出 <toolcall_status>、<toolcall_result> 等系统标签');
    expect(prompt).toContain('禁止使用中文标签');
  });

  it('strips upstream NUL bytes from plain assistant text', async () => {
    mockCallMimoWeb.mockImplementation(
      (async function* () {
        yield {
          type: 'text',
          content: '\u0000OK'
        };
      }) as typeof callMimoWeb
    );

    const provider = buildProvider();
    await provider.initialize();
    const response = await provider.sendRequest({
      model: 'mimo-v2.5-pro',
      messages: [{ role: 'user', content: '只回答 OK' }],
      tools: []
    });

    expect((response as any).stop_reason).toBe('end_turn');
    expect((response as any).content).toEqual([{ type: 'text', text: 'OK' }]);
  });

  it('fails fast when upstream returns empty assistant output', async () => {
    mockCallMimoWeb.mockImplementation(
      (async function* () {
        yield {
          type: 'usage',
          usage: {
            promptTokens: 10,
            completionTokens: 0,
            totalTokens: 10,
            reasoningTokens: 0
          }
        };
      }) as typeof callMimoWeb
    );

    const provider = buildProvider();
    await provider.initialize();

    await expect(
      provider.sendRequest({
        model: 'mimo-v2.5-pro',
        messages: [{ role: 'user', content: 'say hi' }],
        tools: []
      })
    ).rejects.toThrow('[mimoweb] upstream assistant response was empty');
  });

  it('does not block oversized serialized query before upstream send', async () => {
    mockCallMimoWeb.mockImplementation(
      (async function* () {
        yield {
          type: 'text',
          content: 'oversized-ok'
        };
      }) as typeof callMimoWeb
    );

    const provider = buildProvider();
    await provider.initialize();

    const response = await provider.sendRequest({
      model: 'mimo-v2.5-pro',
      messages: [
        { role: 'user', content: '先前你做过一次搜索。' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_search_1',
              type: 'function',
              function: {
                name: 'search_files',
                arguments: JSON.stringify({ pattern: 'mimoweb', path: '/tmp' })
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_search_1',
          name: 'search_files',
          content: 'src/providers/core/runtime/mimoweb/mimoweb-provider.ts'
        },
        {
          role: 'user',
          content: `继续分析：\n${'x '.repeat(75_000)}`
        }
      ],
      tools: []
    } as any);

    expect((response as any).stop_reason).toBe('end_turn');
    expect((response as any).content).toEqual([{ type: 'text', text: 'oversized-ok' }]);
    expect(mockCallMimoWeb).toHaveBeenCalledTimes(1);
  });

  it('fails fast when upstream emits tool markers but no tool call can be harvested', async () => {
    mockCallMimoWeb.mockImplementation(
      (async function* () {
        yield {
          type: 'text',
          content: '<tool_call>{"arguments":{"filePath":"/tmp/a.txt"}}</tool_call>'
        };
      }) as typeof callMimoWeb
    );

    const provider = buildProvider();
    await provider.initialize();

    await expect(
      provider.sendRequest({
        model: 'mimo-v2.5-pro',
        messages: [{ role: 'user', content: 'read /tmp/a.txt' }],
        tools: []
      })
    ).rejects.toThrow('[mimoweb] upstream emitted tool markers but no tool calls could be harvested');
  });

  it('fails fast when upstream repeats the same tool call after tool_result', async () => {
    mockCallMimoWeb.mockImplementation(
      (async function* () {
        yield {
          type: 'text',
          content: '{"tool_calls":[{"id":"toolu_mimo_read_1","name":"read","input":{"filePath":"/tmp/a.txt"}}]}'
        };
      }) as typeof callMimoWeb
    );

    const provider = buildProvider();
    await provider.initialize();

    await expect(
      provider.sendRequest({
        model: 'mimo-v2.5-pro',
        messages: [
          { role: 'user', content: 'read /tmp/a.txt' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_read_1',
                name: 'read',
                input: { filePath: '/tmp/a.txt' }
              }
            ]
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_read_1',
                content: 'A_CONTENT'
              }
            ]
          }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'read',
              description: 'Read a file from disk',
              parameters: {
                type: 'object',
                properties: {
                  filePath: { type: 'string' }
                },
                required: ['filePath'],
                additionalProperties: false
              }
            }
          }
        ]
      })
    ).rejects.toThrow('[mimoweb] upstream repeated prior tool call after tool_result');
  });

  it('fails fast for repeated tool calls when history arrives in openai chat shape', async () => {
    mockCallMimoWeb.mockImplementation(
      (async function* () {
        yield {
          type: 'text',
          content: '{"tool_calls":[{"id":"call_read_1","name":"read","input":{"filePath":"/tmp/a.txt"}}]}'
        };
      }) as typeof callMimoWeb
    );

    const provider = buildProvider();
    await provider.initialize();

    await expect(
      provider.sendRequest({
        model: 'mimo-v2.5-pro',
        messages: [
          { role: 'user', content: 'read /tmp/a.txt' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_read_1',
                type: 'function',
                function: {
                  name: 'read',
                  arguments: JSON.stringify({ filePath: '/tmp/a.txt' })
                }
              }
            ]
          },
          {
            role: 'tool',
            tool_call_id: 'call_read_1',
            name: 'read',
            content: 'A_CONTENT'
          }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'read',
              description: 'Read a file from disk',
              parameters: {
                type: 'object',
                properties: {
                  filePath: { type: 'string' }
                },
                required: ['filePath'],
                additionalProperties: false
              }
            }
          }
        ]
      } as any)
    ).rejects.toThrow('[mimoweb] upstream repeated prior tool call after tool_result');
  });

  it('reuses a stable conversation id for the same session metadata', async () => {
    mockCallMimoWeb.mockImplementation(
      (async function* () {
        yield {
          type: 'text',
          content: 'ok'
        };
      }) as typeof callMimoWeb
    );

    const provider = buildProvider();
    await provider.initialize();

    const reqA: Record<string, unknown> = {
      model: 'mimo-v2.5-pro',
      messages: [{ role: 'user', content: 'hello' }],
      tools: []
    };
    attachProviderRuntimeMetadata(reqA, {
      requestId: 'req-a',
      metadata: { sessionId: 'session-123' }
    });

    const reqB: Record<string, unknown> = {
      model: 'mimo-v2.5-pro',
      messages: [{ role: 'user', content: 'world' }],
      tools: []
    };
    attachProviderRuntimeMetadata(reqB, {
      requestId: 'req-b',
      metadata: { sessionId: 'session-123' }
    });

    await provider.sendRequest(reqA);
    await provider.sendRequest(reqB);

    const firstConversationId = mockCallMimoWeb.mock.calls[0]?.[1];
    const secondConversationId = mockCallMimoWeb.mock.calls[1]?.[1];
    expect(typeof firstConversationId).toBe('string');
    expect(firstConversationId).toBe(secondConversationId);
    expect(String(firstConversationId)).toHaveLength(32);
  });
});
