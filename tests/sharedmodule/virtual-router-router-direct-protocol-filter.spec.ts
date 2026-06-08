import { describe, expect, it } from '@jest/globals';

import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-bootstrap-config.js';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js';

describe('virtual-router router-direct protocol filter', () => {
  it('does not select weighted route targets with a different provider protocol', async () => {
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
            mode: 'weighted',
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
        {
          requestId: `req_router_direct_protocol_search_${i}`,
          entryEndpoint: '/v1/responses',
          routeHint: 'search',
          routecodexRoutingPolicyGroup: 'gateway_priority_5555',
          routerDirectInboundProtocol: 'openai-responses',
          providerProtocol: 'openai-responses'
        } as any
      );

      expect(result.decision.routeName).toBe('search');
      expect(result.target?.providerKey).toBe('responses.key1.gpt-5');
      expect(result.target?.outboundProfile).toBe('openai-responses');
    }
  });
});
