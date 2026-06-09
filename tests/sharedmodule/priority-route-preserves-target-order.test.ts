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
            'openai.key1.gpt-5.5-medium',
            'openai.key3.gpt-5.5-medium',
            'openai.key1.gpt-5.4-high',
            'openai.key3.gpt-5.4-high',
          ]
        }
      ],
      default: [
        {
          id: 'default-priority',
          priority: 10,
          mode: 'priority',
          targets: [
            'openai.key1.gpt-5.5-medium',
            'openai.key3.gpt-5.5-medium',
            'openai.key1.gpt-5.4-high',
            'openai.key3.gpt-5.4-high',
          ]
        }
      ]
    },
    providers: {
      'openai.key1.gpt-5.5-medium': buildProvider('openai.key1.gpt-5.5-medium', 'openai.key1', 'gpt-5.5-medium'),
      'openai.key3.gpt-5.5-medium': buildProvider('openai.key3.gpt-5.5-medium', 'openai.key3', 'gpt-5.5-medium'),
      'openai.key1.gpt-5.4-high': buildProvider('openai.key1.gpt-5.4-high', 'openai.key1', 'gpt-5.4-high'),
      'openai.key3.gpt-5.4-high': buildProvider('openai.key3.gpt-5.4-high', 'openai.key3', 'gpt-5.4-high'),
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
    expect(first.target.providerKey).toBe('openai.key1.gpt-5.5-medium');

    const second = engine.route(buildRequest(), {
      ...buildMetadata('req-priority-2'),
      excludedProviderKeys: ['openai.key1.gpt-5.5-medium']
    } as any);
    expect(second.target.providerKey).toBe('openai.key3.gpt-5.5-medium');

    const third = engine.route(buildRequest(), {
      ...buildMetadata('req-priority-3'),
      excludedProviderKeys: ['openai.key1.gpt-5.5-medium', 'openai.key3.gpt-5.5-medium']
    } as any);
    expect(third.target.providerKey).toBe('openai.key1.gpt-5.4-high');
  });
});
