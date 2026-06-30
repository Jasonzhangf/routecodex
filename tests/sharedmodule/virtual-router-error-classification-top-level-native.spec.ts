import { describe, expect, test } from '@jest/globals';

import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js';

function buildDualProviderConfig(providerA = 'test.key1.gpt-test', providerB = 'test.key2.gpt-test'): any {
  return {
    routing: {
      thinking: [
        {
          id: 'thinking-primary',
          priority: 100,
          mode: 'round-robin',
          targets: [providerA, providerB]
        }
      ],
      default: [
        {
          id: 'default-primary',
          priority: 10,
          mode: 'round-robin',
          targets: [providerA, providerB]
        }
      ]
    },
    providers: {
      [providerA]: {
        providerKey: providerA,
        providerType: 'openai',
        endpoint: 'http://example.invalid',
        auth: { type: 'apiKey', value: 'test-key' },
        outboundProfile: 'openai-chat',
        runtimeKey: 'test.key1',
        modelId: 'gpt-test'
      },
      [providerB]: {
        providerKey: providerB,
        providerType: 'openai',
        endpoint: 'http://example.invalid',
        auth: { type: 'apiKey', value: 'test-key' },
        outboundProfile: 'openai-chat',
        runtimeKey: 'test.key2',
        modelId: 'gpt-test'
      }
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

function buildTopLevelEvent(
  providerKey: string,
  classification: 'recoverable' | 'unrecoverable',
  options?: { status?: number; code?: string }
): any {
  const affectsHealth = classification === 'unrecoverable';
  return {
    code: options?.code ?? (classification === 'unrecoverable' ? 'INVALID_API_KEY' : 'HTTP_502'),
    message: classification === 'unrecoverable' ? 'invalid auth' : 'provider error',
    stage: 'provider.send',
    status: options?.status ?? (classification === 'unrecoverable' ? 401 : 502),
    errorClassification: classification,
    affectsHealth,
    runtime: {
      requestId: 'req-top-level-native',
      routeName: 'thinking',
      providerKey
    },
    timestamp: Date.now(),
    details: {}
  };
}

function readHealthState(engine: VirtualRouterEngine, providerKey: string) {
  const status = engine.getStatus();
  const state = status.health.find((entry) => entry.providerKey === providerKey || entry.providerKey === providerKey.replace('.key1.', '.1.').replace('.key2.', '.2.'));
  expect(state).toBeDefined();
  return state!;
}

describe('virtual router native top-level error event consumption', () => {
  test('consumes top-level errorClassification without requiring details.errorClassification', () => {
    const providerKey = 'test.key1.gpt-test';
    const engine = new VirtualRouterEngine({} as any);
    engine.initialize(buildDualProviderConfig());

    engine.handleProviderError(buildTopLevelEvent(providerKey, 'recoverable'));

    const state = readHealthState(engine, providerKey);
    expect(state.failureCount).toBe(0);
    expect(state.state).toBe('healthy');
  });

  test('unrecoverable top-level errors still require strike threshold before cooldown', () => {
    const providerKey = 'test.key1.gpt-test';
    const engine = new VirtualRouterEngine({} as any);
    engine.initialize(buildDualProviderConfig());

    engine.handleProviderError(buildTopLevelEvent(providerKey, 'unrecoverable', {
      status: 401,
      code: 'INVALID_API_KEY'
    }));

    const state = readHealthState(engine, providerKey);
    expect(state.state).toBe('healthy');
    expect(state.failureCount).toBe(1);
    expect(state.cooldownExpiresAt ?? null).toBeNull();
  });
});
