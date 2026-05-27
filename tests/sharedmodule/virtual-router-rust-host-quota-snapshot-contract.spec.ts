import { describe, expect, test } from '@jest/globals';

import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';

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

describe('virtual router rust host-facing quota snapshot contract gap', () => {
  test('native getStatus() exposes host-facing quota snapshot separately from router-internal quota snapshot', () => {
    const providerA = 'quota.key1.gpt-test';
    const providerB = 'quota.key2.gpt-test';
    const engine = new VirtualRouterEngine({} as any);
    engine.initialize(buildDualProviderConfig(providerA, providerB));

    engine.handleProviderError({
      code: 'QUOTA_DEPLETED',
      message: 'HTTP 429: quota exhausted',
      status: 429,
      quotaScope: 'daily',
      quotaReason: 'quota_exhausted',
      resetAt: '2026-05-28T00:00:00.000Z',
      runtime: {
        requestId: 'req-rust-host-snapshot-contract',
        routeName: 'default',
        providerKey: providerA,
        runtimeKey: 'quota.key1'
      },
      timestamp: Date.now(),
      details: {
        authIssue: { kind: 'google_account_verification', url: 'https://accounts.google.com/signin/continue' },
        priorityTier: 7
      }
    } as any);

    const status = engine.getStatus();
    const canonicalProviderA = providerA.replace('.key1.', '.1.');
    const canonicalProviderB = providerB.replace('.key2.', '.2.');
    const providerAQuota = status.quota?.find((entry) => entry.providerKey === providerA || entry.providerKey === canonicalProviderA);
    const providerBQuota = status.quota?.find((entry) => entry.providerKey === providerB || entry.providerKey === canonicalProviderB);
    const providerAHostSnapshot = status.quotaHostSnapshot?.find((entry) => entry.providerKey === providerA || entry.providerKey === canonicalProviderA);
    const providerBHostSnapshot = status.quotaHostSnapshot?.find((entry) => entry.providerKey === providerB || entry.providerKey === canonicalProviderB);

    expect(providerAQuota).toBeDefined();
    expect(providerAQuota?.providerKey).toBeTruthy();
    expect([providerA, providerA.replace('.key1.', '.1.')]).toContain(providerAQuota?.providerKey);
    expect(providerAQuota).toMatchObject({
      inPool: false,
      reason: 'quotaDepleted',
      consecutiveErrorCount: 1
    });
    expect(typeof providerAQuota?.resetAt).toBe('number');
    expect(providerBQuota?.providerKey).toBeTruthy();
    expect([providerB, providerB.replace('.key2.', '.2.')]).toContain(providerBQuota?.providerKey);
    expect(providerBQuota).toMatchObject({
      inPool: true
    });

    // Router-internal quota snapshot 仍保持精简形态。
    expect(providerAQuota).not.toHaveProperty('authType');
    expect(providerAQuota).not.toHaveProperty('authIssue');
    expect(providerAQuota).not.toHaveProperty('priorityTier');
    expect(providerAQuota).not.toHaveProperty('cooldownKeepsPool');
    expect(providerAQuota).not.toHaveProperty('lastErrorSeries');
    expect(providerAQuota).not.toHaveProperty('lastErrorCode');
    expect(providerAQuota).not.toHaveProperty('selectionPenalty');
    expect(providerAQuota).not.toHaveProperty('lastProviderGuardApplied');

    // Host-facing quota snapshot 现在单独导出 richer contract。
    expect(providerAHostSnapshot).toBeDefined();
    expect(providerAHostSnapshot).toMatchObject({
      providerKey: canonicalProviderA,
      inPool: false,
      reason: 'quotaDepleted',
      authType: 'apikey',
      authIssue: null,
      priorityTier: 100,
      cooldownKeepsPool: false,
      lastErrorSeries: 'E429',
      lastErrorCode: 'QUOTA_DEPLETED',
      consecutiveErrorCount: 1,
      selectionPenalty: 1,
      lastProviderGuardApplied: false
    });
    expect(typeof providerAHostSnapshot?.resetAt).toBe('number');
    expect(providerBHostSnapshot).toMatchObject({
      providerKey: canonicalProviderB,
      inPool: true,
      authType: 'apikey',
      authIssue: null,
      priorityTier: 100,
      consecutiveErrorCount: 0,
      selectionPenalty: 0,
      lastProviderGuardApplied: false
    });
  });
});
