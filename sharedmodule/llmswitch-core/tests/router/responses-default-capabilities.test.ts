import { bootstrapVirtualRouterConfig } from '../../../../tests/sharedmodule/helpers/virtual-router-bootstrap-direct-native.js';
import { VirtualRouterEngine } from '../../../../tests/sharedmodule/helpers/virtual-router-engine-direct-native.js';

test('thinking route with declared tools still keeps responses primary provider selectable', () => {
  const bootstrapped = bootstrapVirtualRouterConfig({
    virtualrouter: {
      providers: {
        sdfv: {
          type: 'responses',
          endpoint: 'https://example.com/v1',
          auth: { type: 'apiKey', value: 'x' },
          models: {
            'gpt-5.4': {
              capabilities: ['web_search']
            }
          }
        },
        mimo: {
          type: 'anthropic',
          endpoint: 'https://example.com/anthropic',
          auth: { type: 'apiKey', value: 'x' },
          models: {
            'mimo-v2.5-pro': {
              capabilities: ['text', 'reasoning', 'thinking', 'longcontext']
            }
          }
        }
      },
      routing: {
        thinking: [
          {
            id: 'thinking-primary',
            priority: 200,
            mode: 'priority',
            targets: ['sdfv.gpt-5.4'],
            routeParams: { routePolicyGroup: 'gateway_priority_5555' }
          },
          {
            id: 'thinking-backup',
            priority: 210,
            mode: 'priority',
            backup: true,
            targets: ['mimo.mimo-v2.5-pro'],
            routeParams: { routePolicyGroup: 'gateway_priority_5555' }
          }
        ],
        default: [
          {
            id: 'default-primary',
            priority: 100,
            mode: 'priority',
            targets: ['sdfv.gpt-5.4'],
            routeParams: { routePolicyGroup: 'gateway_priority_5555' }
          }
        ]
      }
    }
  } as const);

  const engine = new VirtualRouterEngine();
  engine.initialize(bootstrapped.config);
  const routed = engine.route(
    {
      model: 'gpt-5.3-codex',
      messages: [{ role: 'user', content: '继续执行' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
          }
        }
      ]
    } as any,
    {
      requestId: 'req_test_5555_thinking_tools',
      routecodexRoutingPolicyGroup: 'gateway_priority_5555'
    } as any
  );

  expect(routed.decision.routeName).toBe('thinking');
  expect(routed.target.providerKey).toBe('sdfv.key1.gpt-5.4');
});
