import { describe, expect, test } from '@jest/globals';

import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';
import { VirtualRouterError } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/types.js';

function buildDualProviderConfig(providerA = 'quota.key1.gpt-test', providerB = 'quota.key2.gpt-test'): any {
  return {
    routing: {
      default: [
        {
          id: 'default-primary',
          priority: 100,
          mode: 'priority',
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
        runtimeKey: 'quota.key1',
        modelId: 'gpt-test'
      },
      [providerB]: {
        providerKey: providerB,
        providerType: 'openai',
        endpoint: 'http://example.invalid',
        auth: { type: 'apiKey', value: 'test-key' },
        outboundProfile: 'openai-chat',
        runtimeKey: 'quota.key2',
        modelId: 'gpt-test'
      }
    },
    classifier: {},
    loadBalancing: { strategy: 'priority' },
    health: {
      failureThreshold: 3,
      cooldownMs: 30_000,
      fatalCooldownMs: 120_000
    }
  };
}

function buildSingleProviderConfig(providerKey = 'quota.key1.gpt-test'): any {
  return {
    routing: {
      default: [
        {
          id: 'default-primary',
          priority: 100,
          mode: 'priority',
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
        runtimeKey: 'quota.key1',
        modelId: 'gpt-test'
      }
    },
    classifier: {},
    loadBalancing: { strategy: 'priority' },
    health: {
      failureThreshold: 3,
      cooldownMs: 30_000,
      fatalCooldownMs: 120_000
    }
  };
}

function createEngineWithPoisonedQuotaView(config: any, poison: (providerKey: string) => Record<string, unknown> | null): VirtualRouterEngine {
  const engine = new VirtualRouterEngine({
    quotaView: (providerKey: string) => poison(providerKey)
  } as any);
  engine.initialize(config);
  return engine;
}

function routeProviderKey(engine: VirtualRouterEngine, requestId: string): string {
  return engine.route(
    { messages: [{ role: 'user', content: 'hello' }] } as any,
    { requestId } as any
  ).target.providerKey;
}

function readProviderNotAvailable(engine: VirtualRouterEngine, requestId: string) {
  try {
    engine.route(
      { messages: [{ role: 'user', content: 'hello' }] } as any,
      { requestId } as any
    );
    throw new Error('expected route to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(VirtualRouterError);
    const err = error as VirtualRouterError & { details?: Record<string, unknown> };
    expect(err.code).toBe('PROVIDER_NOT_AVAILABLE');
    return err;
  }
}

describe('virtual router quota/health shadow regression gate', () => {
  test('poisoned TS quotaView cannot override Rust route decision for healthy dual-provider pool', () => {
    const providerA = 'quota.key1.gpt-test';
    const providerB = 'quota.key2.gpt-test';
    const config = buildDualProviderConfig(providerA, providerB);

    const rustOnly = new VirtualRouterEngine({} as any);
    rustOnly.initialize(config);

    const tsPoisoned = createEngineWithPoisonedQuotaView(config, (providerKey) =>
      providerKey === providerA
        ? {
            providerKey,
            inPool: false,
            reason: 'quotaDepleted',
            cooldownUntil: Date.now() + 60_000,
            priorityTier: 100
          }
        : { providerKey, inPool: true, priorityTier: 100 }
    );

    expect(routeProviderKey(rustOnly, 'req-shadow-healthy-rust')).toBe(providerA);
    expect(routeProviderKey(tsPoisoned, 'req-shadow-healthy-poisoned')).toBe(providerA);
    expect(routeProviderKey(tsPoisoned, 'req-shadow-healthy-poisoned-repeat')).toBe(
      routeProviderKey(rustOnly, 'req-shadow-healthy-rust-repeat')
    );
  });

  test('quota exhausted with resetAt remains providerKey-isolated even when TS quotaView lies about pool state', () => {
    const providerA = 'quota.key1.gpt-test';
    const providerB = 'quota.key2.gpt-test';
    const config = buildDualProviderConfig(providerA, providerB);
    const quotaError = {
      code: 'QUOTA_DEPLETED',
      message: 'HTTP 429: quota exhausted',
      status: 429,
      quotaScope: 'daily',
      quotaReason: 'quota_exhausted',
      resetAt: '2026-05-28T00:00:00.000Z',
      runtime: {
        requestId: 'req-shadow-quota-resetat-source',
        routeName: 'default',
        providerKey: providerA,
        runtimeKey: 'quota.key1'
      },
      timestamp: Date.now(),
      details: {}
    } as any;

    const rustOnly = new VirtualRouterEngine({} as any);
    rustOnly.initialize(config);
    rustOnly.handleProviderError(quotaError);

    const tsPoisoned = createEngineWithPoisonedQuotaView(config, () => ({
      providerKey: providerA,
      inPool: true,
      reason: 'ok',
      priorityTier: 100
    }));
    tsPoisoned.handleProviderError(quotaError);

    expect(routeProviderKey(rustOnly, 'req-shadow-resetat-rust')).toBe(providerB);
    expect(routeProviderKey(tsPoisoned, 'req-shadow-resetat-poisoned')).toBe(providerB);

    const rustStatus = rustOnly.getStatus();
    const quotaA = rustStatus.quota?.find((entry) => entry.providerKey === providerA || entry.providerKey === providerA.replace('.key1.', '.1.'));
    const quotaB = rustStatus.quota?.find((entry) => entry.providerKey === providerB || entry.providerKey === providerB.replace('.key2.', '.2.'));
    expect(quotaA?.inPool).toBe(false);
    expect(quotaA?.reason).toBe('quotaDepleted');
    expect(typeof quotaA?.resetAt).toBe('number');
    expect(quotaB?.inPool).toBe(true);
  });

  test('singleton last-provider quota exhaustion still fails with Rust recoverable hint, not TS quotaView fiction', () => {
    const providerKey = 'quota.key1.gpt-test';
    const config = buildSingleProviderConfig(providerKey);
    const quotaError = {
      code: 'QUOTA_DEPLETED',
      message: 'HTTP 429: quota exhausted',
      status: 429,
      quotaScope: 'daily',
      quotaReason: 'quota_exhausted',
      resetAt: '2026-05-28T00:00:00.000Z',
      runtime: {
        requestId: 'req-shadow-singleton-source',
        routeName: 'default',
        providerKey,
        runtimeKey: 'quota.key1'
      },
      timestamp: Date.now(),
      details: {}
    } as any;

    const rustOnly = new VirtualRouterEngine({} as any);
    rustOnly.initialize(config);
    rustOnly.handleProviderError(quotaError);

    const tsPoisoned = createEngineWithPoisonedQuotaView(config, () => ({
      providerKey,
      inPool: true,
      reason: 'ok',
      priorityTier: 100
    }));
    tsPoisoned.handleProviderError(quotaError);

    const rustFailure = readProviderNotAvailable(rustOnly, 'req-shadow-singleton-rust');
    const poisonedFailure = readProviderNotAvailable(tsPoisoned, 'req-shadow-singleton-poisoned');

    expect(typeof rustFailure.details?.minRecoverableCooldownMs).toBe('number');
    expect(typeof poisonedFailure.details?.minRecoverableCooldownMs).toBe('number');
    expect((poisonedFailure.details?.minRecoverableCooldownMs as number) > 0).toBe(true);
    expect((poisonedFailure.details?.minRecoverableCooldownMs as number) <= 10_000).toBe(true);
    expect((poisonedFailure.details?.recoverableCooldownHints as Array<Record<string, unknown>>)[0]).toMatchObject({
      providerKey,
      source: 'rust.quota'
    });
    expect((rustFailure.details?.recoverableCooldownHints as Array<Record<string, unknown>>)[0]).toMatchObject({
      providerKey,
      source: 'rust.quota'
    });
  });
});
