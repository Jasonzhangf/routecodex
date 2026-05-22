import { beforeAll, describe, expect, jest, test } from '@jest/globals';

jest.mock('../../src/providers/core/config/camoufox-launcher.ts', () => ({
  getLastCamoufoxLaunchFailureReason: () => null,
  openAuthInCamoufox: async () => { throw new Error('camoufox disabled in static harness tests'); },
}));

describe('WindsurfStaticRequestHarness', () => {
  let WindsurfStaticRequestHarness: any;
  let harness: any;

  beforeAll(async () => {
    ({ WindsurfStaticRequestHarness } = await import('../../src/debug/harnesses/windsurf-static-request-harness.ts'));
    harness = new WindsurfStaticRequestHarness({
      logger: { logModule: () => {}, logProviderRequest: () => {} } as any,
      errorHandlingCenter: { handleError: async () => {} } as any,
    } as any);
  });

  test('RED: static request harness should export preprocess + semantic conversation and must not preserve removed GetChatCompletions outbound contract', async () => {
    const result = await harness.executeForward({
      runtime: {
        runtimeKey: 'windsurf-static-harness',
        providerId: 'windsurf',
        providerKey: 'windsurf',
        providerType: 'openai',
        providerProtocol: 'openai',
        providerModule: 'windsurf-chat-provider',
        endpoint: '',
        defaultModel: 'gpt-5.4-medium',
        auth: {
          type: 'apikey',
          value: 'devin-session-token$test-static',
        },
      },
      metadata: {
        requestId: 'rid-windsurf-static-harness',
        providerId: 'windsurf',
        providerKey: 'windsurf',
        providerType: 'openai',
        providerProtocol: 'openai',
        routeName: 'default',
        target: {
          providerKey: 'windsurf',
        },
      },
      request: {
        body: {
          model: 'gpt-5.4-medium',
          apiKey: 'devin-session-token$test-static',
          messages: [
            { role: 'user', content: 'inspect repo' },
            {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  function: {
                    name: 'shell_command',
                    arguments: '{"command":"pwd"}',
                  },
                },
              ],
            },
            { role: 'tool', tool_call_id: 'call_1', content: '/tmp/project', name: 'shell_command' },
            { role: 'user', content: 'continue' },
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'shell_command',
                description: 'run shell',
                parameters: { type: 'object', properties: { command: { type: 'string' } } },
              },
            },
            {
              type: 'function',
              function: {
                name: 'apply_patch',
                description: 'patch files',
                parameters: { type: 'object', properties: { patch: { type: 'string' } } },
              },
            },
          ],
          tool_choice: {
            type: 'function',
            function: { name: 'shell_command' },
          },
        },
      },
    });

    expect(result.preprocess).toMatchObject({
      body: {
        windsurf_tool_choice: {
          type: 'function',
          function: { name: 'shell_command' },
        },
      },
    });
    expect(Array.isArray((result.preprocess as any).body.windsurf_declared_tools)).toBe(true);
    expect((result.preprocess as any).body.windsurf_declared_tools).toHaveLength(2);
    expect(typeof (result.preprocess as any).body.tools_preamble).toBe('string');
    expect(result.semanticConversation).toEqual([
      { type: 'user', text: 'inspect repo' },
      {
        type: 'assistant',
        text: '',
        tool_calls: [{ call_id: 'call_1', name: 'shell_command', arguments: { command: 'pwd' } }],
      },
      { type: 'function_call_output', call_id: 'call_1', output: '/tmp/project', name: 'shell_command' },
      { type: 'user', text: 'continue' },
    ]);
    expect(result.outboundRequest).toEqual({});
    expect(result.lens).toEqual({
      metadataKeys: [],
      metadataIdentity: {},
      topLevelKeys: [],
      completionsRequestKeys: [],
      configuration: null,
      systemPromptPresent: false,
      systemPromptPreview: null,
      promptRowKinds: [],
      promptRowKeyMatrix: [],
    });
  });

  test('RED: static request harness should still project semantic conversation when tools are absent', async () => {
    const result = await harness.executeForward({
      runtime: {
        runtimeKey: 'windsurf-static-harness-no-tools',
        providerId: 'windsurf',
        providerKey: 'windsurf',
        providerType: 'openai',
        providerProtocol: 'openai',
        providerModule: 'windsurf-chat-provider',
        endpoint: '',
        defaultModel: 'gpt-5.4-medium',
        auth: {
          type: 'apikey',
          value: 'devin-session-token$test-static-no-tools',
        },
      },
      metadata: {
        requestId: 'rid-windsurf-static-harness-no-tools',
        providerId: 'windsurf',
        providerKey: 'windsurf',
        providerType: 'openai',
        providerProtocol: 'openai',
        routeName: 'default',
        target: {
          providerKey: 'windsurf',
        },
      },
      request: {
        body: {
          model: 'gpt-5.4-medium',
          apiKey: 'devin-session-token$test-static-no-tools',
          messages: [{ role: 'user', content: 'say hi' }],
        },
      },
    });

    expect(result.semanticConversation).toEqual([{ type: 'user', text: 'say hi' }]);
    expect(result.outboundRequest).toEqual({});
    expect(result.lens.topLevelKeys).toEqual([]);
  });
});
