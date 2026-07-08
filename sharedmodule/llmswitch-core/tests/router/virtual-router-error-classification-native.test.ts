import { describe, expect, test } from '@jest/globals';

import { VirtualRouterEngine } from '../../src/native/router-hotpath/native-virtual-router-runtime.js';

function buildConfig(providerKey = 'test.key1.gpt-test'): any {
  return {
    routing: {
      thinking: [
        {
          id: 'thinking-primary',
          priority: 100,
          mode: 'round-robin',
          targets: [providerKey]
        }
      ],
      default: [
        {
          id: 'default-primary',
          priority: 10,
          mode: 'round-robin',
          targets: [providerKey]
        }
      ]
    },
    providers: {
      [providerKey]: {
        providerKey,
        providerType: 'openai',
        endpoint: 'http://example.invalid',
        auth: { type: 'apiKey', value: 'test-key' },
        outboundProfile: 'openai-chat',
        runtimeKey: 'test.key1',
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

function buildEvent(
  providerKey: string,
  classification: 'special_400' | 'recoverable' | 'unrecoverable',
  options?: {
    status?: number;
    code?: string;
    affectsHealth?: boolean;
    classificationAtTopLevel?: boolean;
    cooldownOverrideMs?: number;
  }
): any {
  const topLevelClassification = options?.classificationAtTopLevel === true;
  return {
    code: options?.code ?? (options?.status === 400 ? 'HTTP_400' : 'HTTP_502'),
    message: 'provider error',
    stage: 'provider.send',
    status: options?.status ?? (classification === 'special_400' ? 400 : 502),
    ...(typeof options?.affectsHealth === 'boolean' ? { affectsHealth: options.affectsHealth } : {}),
    ...(topLevelClassification ? { errorClassification: classification } : {}),
    ...(typeof options?.cooldownOverrideMs === 'number' ? { cooldownOverrideMs: options.cooldownOverrideMs } : {}),
    runtime: {
      requestId: 'req-1',
      routeName: 'thinking',
      providerKey
    },
    timestamp: Date.now(),
    details: {
      ...(topLevelClassification ? {} : { errorClassification: classification })
    }
  };
}

function readHealthState(engine: VirtualRouterEngine, providerKey: string) {
  const status = engine.getStatus();
  const state = status.health.find((entry) => entry.providerKey === providerKey);
  expect(state).toBeDefined();
  return state!;
}

describe('virtual router native error classification consumption', () => {
  test('quota mode still consumes HTTP_503 into persisted health cooldown', () => {
    const providerKey = 'test.key1.gpt-test';
    const engine = new VirtualRouterEngine();
    engine.initialize(buildConfig(providerKey));

    engine.handleProviderError(buildEvent(providerKey, 'recoverable', { status: 503, code: 'HTTP_503' }));

    const state = readHealthState(engine, providerKey);
    expect(state.state).toBe('tripped');
    expect(state.reason).toBe('__http_503_daily_cooldown__');
    expect(typeof state.cooldownExpiresAt).toBe('number');
    expect((state.cooldownExpiresAt ?? 0)).toBeGreaterThan(Date.now());
  });

  test('special_400 does not mutate health on active native path', () => {
    const providerKey = 'test.key1.gpt-test';
    const engine = new VirtualRouterEngine({} as any);
    engine.initialize(buildConfig(providerKey));

    engine.handleProviderError(buildEvent(providerKey, 'special_400', { status: 400, code: 'HTTP_400' }));

    const state = readHealthState(engine, providerKey);
    expect(state.state).toBe('healthy');
    expect(state.failureCount).toBe(0);
    expect(state.cooldownExpiresAt).toBeUndefined();
  });

  test('affectsHealth=false remains health-neutral on active native path', () => {
    const providerKey = 'test.key1.gpt-test';
    const engine = new VirtualRouterEngine({} as any);
    engine.initialize(buildConfig(providerKey));

    engine.handleProviderError(buildEvent(providerKey, 'recoverable', { affectsHealth: false }));

    const state = readHealthState(engine, providerKey);
    expect(state.state).toBe('healthy');
    expect(state.failureCount).toBe(0);
    expect(state.cooldownExpiresAt).toBeUndefined();
  });

  test('recoverable enters short cooldown on active native path', () => {
    const providerKey = 'test.key1.gpt-test';
    const engine = new VirtualRouterEngine({} as any);
    engine.initialize(buildConfig(providerKey));
    const startedAt = Date.now();

    engine.handleProviderError(buildEvent(providerKey, 'recoverable'));

    const state = readHealthState(engine, providerKey);
    expect(state.state).toBe('tripped');
    expect(state.failureCount).toBe(1);
    expect(typeof state.cooldownExpiresAt).toBe('number');
    const ttl = (state.cooldownExpiresAt ?? 0) - startedAt;
    expect(ttl).toBeGreaterThanOrEqual(25_000);
    expect(ttl).toBeLessThanOrEqual(35_000);
  });

  test('unrecoverable trips until long cooldown window on active native path', () => {
    const providerKey = 'test.key1.gpt-test';
    const engine = new VirtualRouterEngine({} as any);
    engine.initialize(buildConfig(providerKey));
    const startedAt = Date.now();

    engine.handleProviderError(buildEvent(providerKey, 'unrecoverable', { status: 401, code: 'INVALID_API_KEY' }));

    const state = readHealthState(engine, providerKey);
    expect(state.state).toBe('tripped');
    expect(state.failureCount).toBeGreaterThanOrEqual(3);
    expect(typeof state.cooldownExpiresAt).toBe('number');
    const ttl = (state.cooldownExpiresAt ?? 0) - startedAt;
    expect(ttl).toBeGreaterThanOrEqual(5 * 60_000 - 5_000);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60_000 + 5_000);
  });

  test('top-level errorClassification is consumed on active native path without details fallback', () => {
    const providerKey = 'test.key1.gpt-test';
    const alternativeKey = 'test.key2.gpt-test';
    const engine = new VirtualRouterEngine({} as any);
    engine.initialize({
      ...buildConfig(providerKey),
      routing: {
        thinking: [
          {
            id: 'thinking-primary',
            priority: 100,
            mode: 'round-robin',
            targets: [providerKey, alternativeKey]
          }
        ],
        default: [
          {
            id: 'default-primary',
            priority: 10,
            mode: 'round-robin',
            targets: [providerKey, alternativeKey]
          }
        ]
      },
      providers: {
        [providerKey]: {
          providerKey,
          providerType: 'openai',
          endpoint: 'http://example.invalid',
          auth: { type: 'apiKey', value: 'test-key' },
          outboundProfile: 'openai-chat',
          runtimeKey: 'test.key1',
          modelId: 'gpt-test'
        },
        [alternativeKey]: {
          providerKey: alternativeKey,
          providerType: 'openai',
          endpoint: 'http://example.invalid',
          auth: { type: 'apiKey', value: 'test-key' },
          outboundProfile: 'openai-chat',
          runtimeKey: 'test.key2',
          modelId: 'gpt-test'
        }
      }
    } as any);

    engine.handleProviderError(buildEvent(providerKey, 'recoverable', {
      status: 502,
      code: 'HTTP_502',
      classificationAtTopLevel: true
    }));

    const state = readHealthState(engine, providerKey);
    expect(state.failureCount).toBe(1);
  });

  test('top-level cooldownOverrideMs is consumed on active native path for unrecoverable errors', () => {
    const providerKey = 'test.key1.gpt-test';
    const alternativeKey = 'test.key2.gpt-test';
    const engine = new VirtualRouterEngine({} as any);
    engine.initialize({
      ...buildConfig(providerKey),
      routing: {
        thinking: [
          {
            id: 'thinking-primary',
            priority: 100,
            mode: 'round-robin',
            targets: [providerKey, alternativeKey]
          }
        ],
        default: [
          {
            id: 'default-primary',
            priority: 10,
            mode: 'round-robin',
            targets: [providerKey, alternativeKey]
          }
        ]
      },
      providers: {
        [providerKey]: {
          providerKey,
          providerType: 'openai',
          endpoint: 'http://example.invalid',
          auth: { type: 'apiKey', value: 'test-key' },
          outboundProfile: 'openai-chat',
          runtimeKey: 'test.key1',
          modelId: 'gpt-test'
        },
        [alternativeKey]: {
          providerKey: alternativeKey,
          providerType: 'openai',
          endpoint: 'http://example.invalid',
          auth: { type: 'apiKey', value: 'test-key' },
          outboundProfile: 'openai-chat',
          runtimeKey: 'test.key2',
          modelId: 'gpt-test'
        }
      }
    } as any);

    const startedAt = Date.now();
    engine.handleProviderError(buildEvent(providerKey, 'unrecoverable', {
      status: 401,
      code: 'INVALID_API_KEY',
      classificationAtTopLevel: true,
      cooldownOverrideMs: 4321
    }));

    const state = readHealthState(engine, providerKey);
    expect(state.state).toBe('tripped');
    expect(state.failureCount).toBeGreaterThanOrEqual(3);
    expect(typeof state.cooldownExpiresAt).toBe('number');
    const ttl = (state.cooldownExpiresAt ?? 0) - startedAt;
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10_000);
  });
});
