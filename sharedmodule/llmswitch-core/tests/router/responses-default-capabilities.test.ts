import { describe, expect, test } from '@jest/globals';

import { ProviderRegistry } from '../../src/router/virtual-router/provider-registry.js';

describe('virtual-router responses default capabilities', () => {
  test('responses provider keeps multimodal default when model explicitly declares only web_search', () => {
    const registry = new ProviderRegistry({
      'sdfv.key1.gpt-5.4': {
        providerKey: 'sdfv.key1.gpt-5.4',
        providerType: 'responses',
        endpoint: 'https://example.com/v1',
        auth: { type: 'apiKey', value: 'x' },
        outboundProfile: 'openai-responses',
        compatibilityProfile: 'compat:passthrough',
        modelId: 'gpt-5.4',
        modelCapabilities: {
          'gpt-5.4': ['web_search']
        }
      } as any
    });

    expect(registry.hasCapability('sdfv.key1.gpt-5.4', 'web_search')).toBe(true);
    expect(registry.hasCapability('sdfv.key1.gpt-5.4', 'multimodal')).toBe(true);
  });

  test('crs compatibility keeps web_search and multimodal defaults even without explicit multimodal', () => {
    const registry = new ProviderRegistry({
      'dibittai.crsa.gpt-5.4': {
        providerKey: 'dibittai.crsa.gpt-5.4',
        providerType: 'openai',
        endpoint: 'https://example.com/v1',
        auth: { type: 'apiKey', value: 'x' },
        outboundProfile: 'openai-chat',
        compatibilityProfile: 'responses:crs',
        modelId: 'gpt-5.4',
        modelCapabilities: {
          'gpt-5.4': ['web_search']
        }
      } as any
    });

    expect(registry.hasCapability('dibittai.crsa.gpt-5.4', 'web_search')).toBe(true);
    expect(registry.hasCapability('dibittai.crsa.gpt-5.4', 'multimodal')).toBe(true);
  });
});


import { bootstrapVirtualRouterConfig } from '../../src/router/virtual-router/bootstrap.js';
import { VirtualRouterEngine } from '../../src/router/virtual-router/engine.js';

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
