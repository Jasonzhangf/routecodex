import {
  resolvePoolCooldownWaitMs,
  shouldBlockSingletonRoutePoolExhaustion
} from '../../../../../src/server/runtime/http-server/executor/request-executor-core-utils.js';

describe('request-executor-core-utils singleton pool exhaustion', () => {
  test('blocks default-only singleton pool when provider-not-available carries recoverable cooldown hints', () => {
    const pipelineError = Object.assign(
      new Error('No available providers after applying routing instructions'),
      {
        code: 'PROVIDER_NOT_AVAILABLE',
        details: {
          routeName: 'default',
          candidateProviderCount: 1,
          minRecoverableCooldownMs: 1000,
          recoverableCooldownHints: [
            { providerKey: 'deepseek.key1.deepseek-v4-pro', waitMs: 1000, source: 'provider.error' }
          ]
        }
      }
    );

    expect(resolvePoolCooldownWaitMs(pipelineError)).toBe(1000);
    expect(
      shouldBlockSingletonRoutePoolExhaustion({
        pipelineError,
        initialRoutePool: ['deepseek.key1.deepseek-v4-pro'],
        explicitSingletonPool: false,
        excludedProviderCount: 0
      })
    ).toBe(true);
  });

  test('blocks last-model exhaustion when singleton retry already excluded the only provider', () => {
    const pipelineError = Object.assign(
      new Error('All providers unavailable for model xl.gpt-5.4'),
      {
        code: 'PROVIDER_NOT_AVAILABLE',
        details: {
          routeName: 'tools',
          candidateProviderCount: 1
        }
      }
    );

    expect(
      shouldBlockSingletonRoutePoolExhaustion({
        pipelineError,
        initialRoutePool: ['xl.key1.gpt-5.4'],
        explicitSingletonPool: true,
        excludedProviderCount: 1
      })
    ).toBe(true);
  });

  test('does not block multi-candidate exhaustion without singleton semantics', () => {
    const pipelineError = Object.assign(
      new Error('All providers unavailable for route default'),
      {
        code: 'PROVIDER_NOT_AVAILABLE',
        details: {
          routeName: 'default',
          candidateProviderCount: 2,
          minRecoverableCooldownMs: 1000,
          recoverableCooldownHints: [
            { providerKey: 'provider.a', waitMs: 1000, source: 'provider.error' }
          ]
        }
      }
    );

    expect(
      shouldBlockSingletonRoutePoolExhaustion({
        pipelineError,
        initialRoutePool: ['provider.a', 'provider.b'],
        explicitSingletonPool: false,
        excludedProviderCount: 0
      })
    ).toBe(false);
  });

  // ── 红测：单一路由池全部只有 default，1 个 provider ──

  test('blocks when all routes collapse to default-only singleton pool (port 10000 pattern)', () => {
    const pipelineError = Object.assign(
      new Error('All providers unavailable for model deepseek.deepseek-v4-pro'),
      {
        code: 'PROVIDER_NOT_AVAILABLE',
        details: {
          routeName: 'default',
          candidateProviderCount: 1,
          minRecoverableCooldownMs: 2000,
          recoverableCooldownHints: [
            { providerKey: 'deepseek.key1.deepseek-v4-pro', waitMs: 2000, source: 'provider.error' }
          ]
        }
      }
    );

    // default-only pool, one candidate, cooldown hints → must block
    expect(resolvePoolCooldownWaitMs(pipelineError)).toBe(2000);
    expect(
      shouldBlockSingletonRoutePoolExhaustion({
        pipelineError,
        initialRoutePool: ['deepseek.key1.deepseek-v4-pro'],
        explicitSingletonPool: false,
        excludedProviderCount: 0
      })
    ).toBe(true);
  });

  test('blocks singleton pool even without minRecoverableCooldownMs when excluded count > 0', () => {
    // 场景：provider 第一次错误后被 exclude，第二次 hub pipeline 跑时
    //       VR 发现池空 → PROVIDER_NOT_AVAILABLE 但无 cooldown hints
    const pipelineError = Object.assign(
      new Error('All providers unavailable for model xl.gpt-5.4'),
      {
        code: 'PROVIDER_NOT_AVAILABLE',
        details: {
          routeName: 'tools',
          candidateProviderCount: 1
          // 无 minRecoverableCooldownMs — 只有 candidateProviderCount: 1
        }
      }
    );

    expect(resolvePoolCooldownWaitMs(pipelineError)).toBeUndefined();
    // 即使没有 cooldownMs，如果 excludedProviderCount > 0（上一个 retry 已排除），仍要 block
    expect(
      shouldBlockSingletonRoutePoolExhaustion({
        pipelineError,
        initialRoutePool: ['xl.key1.gpt-5.4'],
        explicitSingletonPool: false,
        excludedProviderCount: 1
      })
    ).toBe(true);
  });

  test('blocks explicit singleton pool even when initialRoutePool is empty', () => {
    // 场景：send failure 后触发 exclude_and_reroute，holdState 带 explicitSingletonPool: true
    const pipelineError = Object.assign(
      new Error('Virtual router did not produce a provider target'),
      {
        code: 'ERR_NO_PROVIDER_TARGET'
      }
    );

    expect(
      shouldBlockSingletonRoutePoolExhaustion({
        pipelineError,
        // initialRoutePool is null — send failure side doesn't carry it
        explicitSingletonPool: true,
        excludedProviderCount: 1
      })
    ).toBe(true);
  });

  test('does NOT block singleton pool when no cooldownMs and no exclusions', () => {
    // 非 singleton：多 candidate 但没有 cooldown hints 也没有 excluded providers
    const pipelineError = Object.assign(
      new Error('All providers unavailable for route default'),
      {
        code: 'PROVIDER_NOT_AVAILABLE',
        details: {
          routeName: 'default',
          // no candidateProviderCount, no cooldownMs
        }
      }
    );

    expect(
      shouldBlockSingletonRoutePoolExhaustion({
        pipelineError,
        // null route pool — not marked singleton
        explicitSingletonPool: false,
        excludedProviderCount: 0
      })
    ).toBe(false);
  });
});
