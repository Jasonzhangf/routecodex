import { describe, expect, test } from '@jest/globals';

import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.js';
import { VirtualRouterError } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/virtual-router-contracts.js';

const FUTURE_RESET_AT = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

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

describe('virtual router quota shadow compare against TS second center', () => {
  test('same-shape route decision stays identical even if TS quotaView marks primary key out-of-pool', () => {
    const providerA = 'quota.key1.gpt-test';
    const providerB = 'quota.key2.gpt-test';
    const config = buildDualProviderConfig(providerA, providerB);
    const request = { messages: [{ role: 'user', content: 'hello' }] } as any;
    const metadata = { requestId: 'req-quota-shadow-compare-route' } as any;

    const rustOnly = new VirtualRouterEngine({} as any);
    rustOnly.initialize(config);

    const tsPoisoned = createEngineWithPoisonedQuotaView(config, (providerKey) => {
      if (providerKey === providerA) {
        return {
          providerKey,
          inPool: false,
          reason: 'quotaDepleted',
          cooldownUntil: Date.now() + 60_000,
          blacklistUntil: null,
          priorityTier: 100
        };
      }
      return {
        providerKey,
        inPool: true,
        priorityTier: 100
      };
    });

    const rustOnlyDecision = rustOnly.route(request, metadata);
    const tsPoisonedDecision = tsPoisoned.route(request, metadata);

    expect([providerA, providerB]).toContain(rustOnlyDecision.target.providerKey);
    expect(tsPoisonedDecision.target.providerKey).toBe(rustOnlyDecision.target.providerKey);
    expect(tsPoisonedDecision.decision.routeName).toBe(rustOnlyDecision.decision.routeName);
  });

  test('same-shape singleton quota exhausted error stays identical even if TS quotaView advertises a conflicting pool state', () => {
    const providerKey = 'quota.key1.gpt-test';
    const config = buildSingleProviderConfig(providerKey);
    const request = { messages: [{ role: 'user', content: 'hello' }] } as any;
    const metadata = { requestId: 'req-quota-shadow-compare-singleton' } as any;
    const errorEvent = {
      code: 'QUOTA_DEPLETED',
      message: 'HTTP 429: quota exhausted',
      status: 429,
      quotaScope: 'daily',
      quotaReason: 'quota_exhausted',
      resetAt: FUTURE_RESET_AT,
      runtime: {
        requestId: 'req-singleton-quota-shadow',
        routeName: 'default',
        providerKey,
        runtimeKey: 'quota.key1'
      },
      timestamp: Date.now(),
      details: {}
    } as any;

    const rustOnly = new VirtualRouterEngine({} as any);
    rustOnly.initialize(config);
    rustOnly.handleProviderError(errorEvent);

    const tsPoisoned = createEngineWithPoisonedQuotaView(config, (key) => ({
      providerKey: key,
      inPool: true,
      reason: 'ok',
      priorityTier: 100
    }));
    tsPoisoned.handleProviderError(errorEvent);

    const readFailure = (engine: VirtualRouterEngine) => {
      try {
        engine.route(request, metadata);
        throw new Error('expected route to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(VirtualRouterError);
        const err = error as VirtualRouterError & { details?: Record<string, unknown> };
        expect(err.code).toBe('PROVIDER_NOT_AVAILABLE');
        return {
          code: err.code,
          minRecoverableCooldownMs: err.details?.minRecoverableCooldownMs,
          recoverableCooldownHints: err.details?.recoverableCooldownHints
        };
      }
    };

    const rustOnlyFailure = readFailure(rustOnly);
    const tsPoisonedFailure = readFailure(tsPoisoned);

    expect(typeof rustOnlyFailure.minRecoverableCooldownMs).toBe('number');
    expect(tsPoisonedFailure.code).toBe(rustOnlyFailure.code);
    expect(typeof tsPoisonedFailure.minRecoverableCooldownMs).toBe('number');
    expect((tsPoisonedFailure.minRecoverableCooldownMs as number) > 0).toBe(true);
    expect((tsPoisonedFailure.minRecoverableCooldownMs as number) <= 10_000).toBe(true);
    expect(Array.isArray(rustOnlyFailure.recoverableCooldownHints)).toBe(true);
    expect(Array.isArray(tsPoisonedFailure.recoverableCooldownHints)).toBe(true);
    expect((tsPoisonedFailure.recoverableCooldownHints as Array<Record<string, unknown>>)[0]).toMatchObject({
      providerKey,
      source: 'rust.quota'
    });
    expect((rustOnlyFailure.recoverableCooldownHints as Array<Record<string, unknown>>)[0]).toMatchObject({
      providerKey,
      source: 'rust.quota'
    });
    const rustWaitMs = Number((rustOnlyFailure.recoverableCooldownHints as Array<Record<string, unknown>>)[0]?.waitMs);
    const tsWaitMs = Number((tsPoisonedFailure.recoverableCooldownHints as Array<Record<string, unknown>>)[0]?.waitMs);
    expect(Number.isFinite(rustWaitMs)).toBe(true);
    expect(Number.isFinite(tsWaitMs)).toBe(true);
    expect(Math.abs(tsWaitMs - rustWaitMs)).toBeLessThanOrEqual(50);
  });
});
