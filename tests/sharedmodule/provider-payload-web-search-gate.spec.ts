import {
  buildRequestStageProviderPayload,
  finalizeProviderPayloadWithPolicy,
} from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage-provider-payload.js';

describe('provider payload builtin web_search gating', () => {
  const baseArgs = {
    effectivePolicy: undefined,
    compatibilityProfile: undefined,
    stageRecorder: undefined,
    requestId: 'provider-payload-web-search-gate',
    config: {
      virtualRouter: {}
    } as any
  };

  test('strips builtin web_search on non-search routes', () => {
    const output = finalizeProviderPayloadWithPolicy({
      ...baseArgs,
      outboundProtocol: 'openai-responses',
      formattedPayload: {
        model: 'llmgate.deepseek-v4-pro',
        tools: [
          { type: 'web_search' },
          {
            type: 'function',
            function: { name: 'exec_command' }
          }
        ]
      } as any,
      outboundAdapterContext: {
        routeId: 'thinking.default',
        __rt: {
          webSearch: {
            engines: [
              {
                executionMode: 'direct',
                directActivation: 'builtin',
                modelId: 'llmgate.deepseek-v4-pro'
              }
            ]
          }
        }
      }
    });

    expect(output.tools).toEqual([
      {
        type: 'function',
        function: { name: 'exec_command' }
      }
    ]);
  });

  test('strips builtin web_search on thinking/priority-thinking route ids (slash form)', () => {
    const output = finalizeProviderPayloadWithPolicy({
      ...baseArgs,
      outboundProtocol: 'openai-responses',
      formattedPayload: {
        model: 'llmgate.deepseek-v4-pro',
        tools: [
          { type: 'web_search' },
          { type: 'web_search_preview' },
          {
            type: 'function',
            function: { name: 'exec_command' }
          }
        ]
      } as any,
      outboundAdapterContext: {
        routeId: 'thinking/priority-thinking',
        __rt: {
          webSearch: {
            engines: [
              {
                executionMode: 'direct',
                directActivation: 'builtin',
                modelId: 'llmgate.deepseek-v4-pro'
              }
            ]
          }
        }
      }
    });

    expect(output.tools).toEqual([
      {
        type: 'function',
        function: { name: 'exec_command' }
      }
    ]);
  });

  test('strips builtin web_search when search route has no matching direct-builtin capability', () => {
    const output = finalizeProviderPayloadWithPolicy({
      ...baseArgs,
      outboundProtocol: 'openai-responses',
      formattedPayload: {
        model: 'llmgate.deepseek-v4-pro',
        tools: [
          { type: 'web_search' },
          {
            type: 'function',
            function: { name: 'exec_command' }
          }
        ]
      } as any,
      outboundAdapterContext: {
        routeId: 'search.default',
        __rt: {
          webSearch: {
            engines: [
              {
                executionMode: 'proxy',
                directActivation: 'builtin',
                modelId: 'llmgate.deepseek-v4-pro'
              }
            ]
          }
        }
      }
    });

    expect(output.tools).toEqual([
      {
        type: 'function',
        function: { name: 'exec_command' }
      }
    ]);
  });

  test('does not strip last builtin web_search when tool_choice requires declared tools', () => {
    const output = finalizeProviderPayloadWithPolicy({
      ...baseArgs,
      outboundProtocol: 'openai-responses',
      formattedPayload: {
        model: 'llmgate.deepseek-v4-pro',
        tool_choice: 'auto',
        tools: [{ type: 'web_search' }]
      } as any,
      outboundAdapterContext: {
        routeId: 'thinking.default',
        __rt: {
          webSearch: {
            engines: [
              {
                executionMode: 'proxy',
                directActivation: 'builtin',
                modelId: 'llmgate.deepseek-v4-pro'
              }
            ]
          }
        }
      }
    });

    expect(output.tool_choice).toBe('auto');
    expect(output.tools).toEqual([{ type: 'web_search' }]);
  });

  test('replaces canonical web_search with builtin only for anthropic direct-builtin search routes', () => {
    const output = finalizeProviderPayloadWithPolicy({
      ...baseArgs,
      outboundProtocol: 'anthropic-messages',
      formattedPayload: {
        model: 'claude-3-7-sonnet',
        tools: [
          {
            type: 'function',
            function: { name: 'web_search' }
          },
          {
            type: 'function',
            function: { name: 'exec_command' }
          }
        ]
      } as any,
      outboundAdapterContext: {
        routeId: 'search.default',
        __rt: {
          webSearch: {
            engines: [
              {
                executionMode: 'direct',
                directActivation: 'builtin',
                modelId: 'claude-3-7-sonnet',
                maxUses: '3'
              }
            ]
          }
        }
      }
    });

    expect(output.tools).toEqual([
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 3
      },
      {
        type: 'function',
        function: { name: 'exec_command' }
      }
    ]);
  });

  test('passthrough outbound payload also strips builtin web_search on non-anthropic protocols', async () => {
    const result = await buildRequestStageProviderPayload({
      normalized: {
        id: 'provider-payload-web-search-gate-passthrough',
        providerProtocol: 'openai-responses',
        metadata: {},
      } as any,
      hooks: {
        createSemanticMapper: () => ({}),
        contextMetadataKey: 'messages',
      } as any,
      config: {
        virtualRouter: {},
      } as any,
      workingRequest: {
        model: 'llmgate.deepseek-v4-pro',
        messages: [],
        metadata: {},
      } as any,
      rawRequest: {
        model: 'llmgate.deepseek-v4-pro',
        stream: true,
        tool_choice: 'auto',
        tools: [
          { type: 'web_search' },
          {
            type: 'function',
            function: { name: 'exec_command' },
          },
        ],
      } as any,
      contextSnapshot: undefined,
      activeProcessMode: 'chat',
      outboundProtocol: 'openai-responses',
      outboundAdapterContext: {
        routeId: 'thinking.default',
        __rt: {
          webSearch: {
            engines: [
              {
                executionMode: 'proxy',
                directActivation: 'builtin',
                modelId: 'llmgate.deepseek-v4-pro',
              },
            ],
          },
        },
      },
      outboundStream: true,
      outboundRecorder: undefined,
      semanticMapper: {},
      effectivePolicy: undefined,
      shadowCompareBaselineMode: undefined,
    });

    expect(result.providerPayload.tools).toEqual([
      {
        type: 'function',
        function: { name: 'exec_command' },
      },
    ]);
  });
});
