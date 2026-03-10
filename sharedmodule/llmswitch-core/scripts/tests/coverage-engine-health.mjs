#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  const {
    mapProviderErrorImpl,
    handleProviderFailureImpl,
    applySeriesCooldownImpl,
    applyQuotaDepletedImpl,
    applyQuotaRecoveryImpl,
    resetRateLimitBackoffForProvider,
    deriveReason
  } = await import('../../dist/router/virtual-router/engine-health.js');

  // Minimal stubs: ProviderHealthManager-like surface.
  const calls = [];
  const healthManager = {
    tripProvider: (...args) => calls.push(['tripProvider', ...args]),
    cooldownProvider: (...args) => calls.push(['cooldownProvider', ...args]),
    recordFailure: (...args) => calls.push(['recordFailure', ...args]),
    recordSuccess: (...args) => calls.push(['recordSuccess', ...args])
  };

  const cooldowns = [];
  const markProviderCooldown = (providerKey, ttl) => cooldowns.push([providerKey, ttl]);
  const clearProviderCooldown = (providerKey) => cooldowns.push([providerKey, 'clear']);

  const healthConfig = {
    fatalCooldownMs: 10 * 60_000
  };

  // mapProviderErrorImpl: auth errors => fatal auth
  {
    const ev = {
      status: 401,
      code: 'AUTH_FAILED',
      stage: 'provider_send',
      recoverable: false,
      runtime: {
        providerKey: 'p.key1.model',
        providerFamily: 'iflow',
        routeName: 'default'
      }
    };
    const out = mapProviderErrorImpl(ev, healthConfig);
    assert.ok(out && out.fatal === true);
    assert.equal(out.reason, 'auth');
  }

  // handleProviderFailureImpl: 429 non-fatal uses backoff schedule + mark cooldown
  {
    resetRateLimitBackoffForProvider('p.key2.model');
    handleProviderFailureImpl(
      { providerKey: 'p.key2.model', affectsHealth: true, fatal: false, reason: 'rate_limit', statusCode: 429 },
      healthManager,
      healthConfig,
      markProviderCooldown
    );
    assert.ok(calls.some((c) => c[0] === 'cooldownProvider'));
    assert.ok(cooldowns.length === 1);
  }

  // deriveReason basic mapping
  {
    assert.equal(deriveReason('ERR_TIMEOUT', 'provider_send'), 'timeout');
    assert.equal(deriveReason('ERR_UNKNOWN', 'unknown', 500), 'upstream_error');
  }

  // applySeriesCooldownImpl / applyQuotaDepletedImpl / applyQuotaRecoveryImpl: no-throw smoke
  {
    const providerKey = 'tab.key1.claude-opus';
    const providerRegistry = {
      has: (key) => key === providerKey,
      get: (key) => {
        if (key !== providerKey) throw new Error('missing');
        return { providerKey, modelId: 'claude-opus' };
      }
    };

    applySeriesCooldownImpl(
      {
        providerKey,
        runtime: { providerKey },
        details: { virtualRouterSeriesCooldown: { providerId: 'tab', series: 'claude', cooldownMs: 1000 } }
      },
      providerRegistry,
      healthManager,
      markProviderCooldown,
      console
    );

    applyQuotaDepletedImpl(
      { providerKey, details: { virtualRouterQuotaDepleted: { providerKey, cooldownMs: 1000 } } },
      healthManager,
      markProviderCooldown,
      console
    );

    applyQuotaRecoveryImpl(
      { providerKey, details: { virtualRouterQuotaRecovery: { providerKey } } },
      healthManager,
      clearProviderCooldown,
      console
    );
  }

  console.log('✅ coverage-engine-health passed');
}

main().catch((e) => {
  console.error('❌ coverage-engine-health failed:', e);
  process.exit(1);
});
