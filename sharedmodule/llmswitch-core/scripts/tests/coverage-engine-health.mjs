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
    // 所有错误现在都先尝试切换 provider，fatal=false 触发 cooldown
    assert.ok(out && out.fatal === false);
   assert.equal(out.reason, 'auth');
 }

  // mapProviderErrorImpl: 429 DAILY_LIMIT_EXCEEDED => cooldown until next local midnight
  {
    const originalNow = Date.now;
    try {
      const fixedNow = new Date(2026, 2, 27, 12, 34, 56, 0).getTime();
      Date.now = () => fixedNow;
      const ev = {
        status: 429,
        code: 'HTTP_429',
        stage: 'provider_send',
        recoverable: false,
        message:
          'error: code=429 reason="DAILY_LIMIT_EXCEEDED" message="daily usage limit exceeded" metadata=map[]',
        runtime: {
          providerKey: 'p.daily.model',
          routeName: 'default'
        }
      };
      const out = mapProviderErrorImpl(ev, healthConfig);
      assert.ok(out && out.fatal === false);
      assert.equal(out.reason, 'rate_limit');
      const now = new Date(fixedNow);
      const expected = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0).getTime() - fixedNow;
      assert.equal(out.cooldownOverrideMs, expected);

      const evRecoverable = {
        status: 429,
        code: 'HTTP_429',
        stage: 'provider_send',
        recoverable: true,
        message: 'upstream quota exceeded',
        details: {
          meta: {
            reason: 'DAILY_LIMIT_EXCEEDED'
          }
        },
        runtime: {
          providerKey: 'p.daily.recoverable.model',
          routeName: 'default'
        }
      };
      const outRecoverable = mapProviderErrorImpl(evRecoverable, healthConfig);
      assert.ok(outRecoverable && outRecoverable.fatal === false);
      assert.equal(outRecoverable.reason, 'rate_limit');
      assert.equal(outRecoverable.cooldownOverrideMs, expected);
    } finally {
      Date.now = originalNow;
    }
  }

  // mapProviderErrorImpl: normal 429 keeps default short cooldown for non-recoverable rate limit
  {
    const ev = {
      status: 429,
      code: 'HTTP_429',
      stage: 'provider_send',
      recoverable: false,
      message: 'error: code=429 reason="RATE_LIMIT" message="rate limit exceeded"',
      runtime: {
        providerKey: 'p.normal429.model',
        routeName: 'default'
      }
    };
    const out = mapProviderErrorImpl(ev, healthConfig);
    assert.ok(out && out.fatal === false);
    assert.equal(out.reason, 'rate_limit');
    assert.equal(out.cooldownOverrideMs, 60_000);
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
