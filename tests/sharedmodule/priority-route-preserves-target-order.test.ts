import { describe, expect, test } from '@jest/globals';

import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js';

function buildConfig(): any {
  return {
    routing: {
      thinking: [
        {
          id: 'thinking-priority',
          priority: 100,
          mode: 'priority',
          targets: [
            'windsurf.ws-pro-1.gpt-5.5-medium',
            'windsurf.ws-pro-3.gpt-5.5-medium',
            'windsurf.ws-pro-1.gpt-5.4-high',
            'windsurf.ws-pro-3.gpt-5.4-high',
          ]
        }
      ],
      default: [
        {
          id: 'default-priority',
          priority: 10,
          mode: 'priority',
          targets: [
            'windsurf.ws-pro-1.gpt-5.5-medium',
            'windsurf.ws-pro-3.gpt-5.5-medium',
            'windsurf.ws-pro-1.gpt-5.4-high',
            'windsurf.ws-pro-3.gpt-5.4-high',
          ]
        }
      ]
    },
    providers: {
      'windsurf.ws-pro-1.gpt-5.5-medium': buildProvider('windsurf.ws-pro-1.gpt-5.5-medium', 'windsurf.ws-pro-1', 'gpt-5.5-medium'),
      'windsurf.ws-pro-3.gpt-5.5-medium': buildProvider('windsurf.ws-pro-3.gpt-5.5-medium', 'windsurf.ws-pro-3', 'gpt-5.5-medium'),
      'windsurf.ws-pro-1.gpt-5.4-high': buildProvider('windsurf.ws-pro-1.gpt-5.4-high', 'windsurf.ws-pro-1', 'gpt-5.4-high'),
      'windsurf.ws-pro-3.gpt-5.4-high': buildProvider('windsurf.ws-pro-3.gpt-5.4-high', 'windsurf.ws-pro-3', 'gpt-5.4-high'),
    },
    classifier: {},
    loadBalancing: { strategy: 'round-robin' },
    health: {
      failureThreshold: 3,
      cooldownMs: 30_000,
      fatalCooldownMs: 120_000
    }
  };
}

function buildProvider(providerKey: string, runtimeKey: string, modelId: string): any {
  return {
    providerKey,
    providerType: 'openai',
    endpoint: 'http://example.invalid',
    auth: { type: 'apiKey', value: 'test-key' },
    outboundProfile: 'openai-chat',
    runtimeKey,
    modelId
  };
}

function buildRequest(): any {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: 'continue working' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'exec_command',
          parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
        }
      }
    ]
  };
}

function buildMetadata(requestId: string): any {
  return {
    requestId,
    routeType: 'thinking',
  };
}

describe('virtual-router priority preserves configured target order', () => {
  test('after excluding first target, next target stays same-model next-key before switching model', () => {
    const engine = new VirtualRouterEngine({} as any);
    engine.initialize(buildConfig());

    const first = engine.route(buildRequest(), buildMetadata('req-priority-1'));
    expect(first.target.providerKey).toBe('windsurf.ws-pro-1.gpt-5.5-medium');

    const second = engine.route(buildRequest(), {
      ...buildMetadata('req-priority-2'),
      excludedProviderKeys: ['windsurf.ws-pro-1.gpt-5.5-medium']
    } as any);
    expect(second.target.providerKey).toBe('windsurf.ws-pro-3.gpt-5.5-medium');

    const third = engine.route(buildRequest(), {
      ...buildMetadata('req-priority-3'),
      excludedProviderKeys: ['windsurf.ws-pro-1.gpt-5.5-medium', 'windsurf.ws-pro-3.gpt-5.5-medium']
    } as any);
    expect(third.target.providerKey).toBe('windsurf.ws-pro-1.gpt-5.4-high');
  });
});
