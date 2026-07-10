import { describe, expect, it } from '@jest/globals';

import { bootstrapVirtualRouterConfig } from './helpers/virtual-router-bootstrap-direct-native.js';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js';

function withMetadataCenterSnapshot(metadata: Record<string, unknown>): Record<string, unknown> {
  return {
    ...metadata,
    metadataCenterSnapshot: {
      ...metadata,
      runtimeControl: {
        routecodexRoutingPolicyGroup: metadata.routecodexRoutingPolicyGroup,
        providerProtocol: metadata.providerProtocol
      }
    }
  };
}

describe('virtual-router router-direct protocol boundary', () => {
  it('keeps configured route target priority instead of filtering by provider protocol', async () => {
    const input: any = {
      virtualrouter: {
        providers: {
          anthropic: {
            id: 'anthropic',
            type: 'anthropic',
            enabled: true,
            endpoint: 'https://anthropic.invalid',
            auth: { type: 'apikey', apiKey: 'ANTHROPIC_KEY' },
            models: {
              claude: { capabilities: ['text', 'web_search'] }
            }
          },
          chat: {
            id: 'chat',
            type: 'openai',
            enabled: true,
            endpoint: 'https://chat.invalid',
            auth: { type: 'apikey', apiKey: 'CHAT_KEY' },
            models: {
              chat: { capabilities: ['text', 'web_search'] }
            }
          },
          responses: {
            id: 'responses',
            type: 'responses',
            enabled: true,
            endpoint: 'https://responses.invalid',
            auth: { type: 'apikey', apiKey: 'RESPONSES_KEY' },
            models: {
              'gpt-5': { capabilities: ['text', 'web_search'] }
            }
          }
        },
        routing: {
          'gateway_priority_5555:search': [{
            id: 'gateway-priority-5555-weighted-search',
            priority: 200,
            mode: 'priority',
            targets: ['anthropic.claude', 'chat.chat', 'responses.gpt-5'],
            routeParams: { routePolicyGroup: 'gateway_priority_5555' },
            loadBalancing: {
              strategy: 'weighted',
              weights: {
                'anthropic.claude': 1,
                'chat.chat': 1,
                'responses.gpt-5': 1
              }
            }
          }],
          'gateway_priority_5555:default': [{
            id: 'gateway-priority-5555-default',
            priority: 100,
            targets: ['anthropic.claude'],
            routeParams: { routePolicyGroup: 'gateway_priority_5555' }
          }]
        }
      }
    };
    const { config } = bootstrapVirtualRouterConfig(input);
    const engine = new VirtualRouterEngine();
    engine.initialize(config);

    for (let i = 0; i < 6; i += 1) {
      const result = await engine.route(
        {
          model: 'router-gpt-5.5',
          messages: [{ role: 'user', content: 'search protocol smoke' }]
        } as any,
        withMetadataCenterSnapshot({
          requestId: `req_router_direct_protocol_search_${i}`,
          entryEndpoint: '/v1/responses',
          routeHint: 'search',
          routecodexRoutingPolicyGroup: 'gateway_priority_5555',
          routerDirectInboundProtocol: 'openai-responses',
          providerProtocol: 'openai-responses'
        }) as any
      );

      expect(result.decision.routeName).toBe('search');
      expect(result.target?.providerKey).toBe('anthropic.key1.claude');
      expect(result.target?.outboundProfile).toBe('anthropic-messages');
    }
  });

  it('does not report provider-unavailable when default route only has cross-protocol targets', async () => {
    const input: any = {
      virtualrouter: {
        providers: {
          minimax: {
            id: 'minimax',
            type: 'openai',
            enabled: true,
            endpoint: 'https://minimax.invalid',
            auth: { type: 'apikey', apiKey: 'MINIMAX_KEY' },
            models: {
              'MiniMax-M3': { capabilities: ['text'] }
            }
          }
        },
        routing: {
          'gateway_priority_5555:default': [{
            id: 'gateway-priority-5555-default',
            priority: 100,
            mode: 'priority',
            targets: ['minimax.MiniMax-M3'],
            routeParams: { routePolicyGroup: 'gateway_priority_5555' }
          }]
        }
      }
    };
    const { config } = bootstrapVirtualRouterConfig(input);
    const engine = new VirtualRouterEngine();
    engine.initialize(config);

    const result = await engine.route(
      {
        model: 'gpt-5.5',
        stream: true,
        input: 'default floor protocol mismatch should relay'
      } as any,
      withMetadataCenterSnapshot({
        requestId: 'req_router_direct_default_floor_protocol_mismatch',
        entryEndpoint: '/v1/responses',
        routecodexRoutingPolicyGroup: 'gateway_priority_5555',
        routerDirectInboundProtocol: 'openai-responses',
        providerProtocol: 'openai-responses'
      }) as any
    );

    expect(result.decision.routeName).toBe('default');
    expect(result.target?.providerKey).toBe('minimax.key1.MiniMax-M3');
    expect(result.target?.outboundProfile).toBe('openai-chat');
  });

  it('does not report provider-unavailable when default route only has a cross-protocol forwarder target', async () => {
    const input: any = {
      virtualrouter: {
        providers: {
          minimax: {
            id: 'minimax',
            type: 'openai',
            enabled: true,
            endpoint: 'https://minimax.invalid',
            auth: { type: 'apikey', apiKey: 'MINIMAX_KEY' },
            models: {
              'MiniMax-M3': { capabilities: ['text'] }
            }
          }
        },
        routing: {
          'gateway_priority_5555:default': [
            {
              id: 'gateway-priority-5555-default',
              priority: 100,
              mode: 'priority',
              targets: ['fwd.minimax.MiniMax-M3'],
              routeParams: { routePolicyGroup: 'gateway_priority_5555' }
            }
          ]
        },
        forwarders: {
          'fwd.minimax.MiniMax-M3': {
            forwarderId: 'fwd.minimax.MiniMax-M3',
            protocol: 'openai',
            modelId: 'MiniMax-M3',
            resolutionMode: 'model-first',
            strategy: 'priority',
            stickyKey: 'none',
            targets: [
              {
                providerKey: 'minimax.key1.MiniMax-M3',
                priority: 1,
                disabled: false
              }
            ]
          }
        }
      }
    };
    const { config } = bootstrapVirtualRouterConfig(input);
    const engine = new VirtualRouterEngine();
    engine.initialize(config);

    const result = await engine.route(
      {
        model: 'gpt-5.5',
        stream: true,
        input: 'default forwarder floor protocol mismatch should relay'
      } as any,
      withMetadataCenterSnapshot({
        requestId: 'req_router_direct_default_forwarder_protocol_mismatch',
        entryEndpoint: '/v1/responses',
        routecodexRoutingPolicyGroup: 'gateway_priority_5555',
        routerDirectInboundProtocol: 'openai-responses',
        providerProtocol: 'openai-responses'
      }) as any
    );

    expect(result.decision.routeName).toBe('default');
    expect(result.target?.providerKey).toBe('minimax.key1.MiniMax-M3');
    expect(result.target?.outboundProfile).toBe('openai-chat');
  });
});
