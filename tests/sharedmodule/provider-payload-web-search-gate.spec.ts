import { finalizeProviderPayloadWithPolicy } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-provider-payload-policy-apply-blocks.js';

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
});
