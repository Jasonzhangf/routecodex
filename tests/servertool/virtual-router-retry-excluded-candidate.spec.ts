import { describe, expect, it } from '@jest/globals';

import { RouteLoadBalancer } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/load-balancer.js';
import { selectProviderKeyFromCandidatePool } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/tier-selection-select.js';

describe('virtual-router retry excluded candidates', () => {
  it('does not reselect an already excluded concrete providerKey from the candidate pool', () => {
    const primary = 'tabglm.key1.glm-5.1';
    const backup = 'qwen.key1.qwen3.6-plus';

    const providerRegistry = {
      get: (key: string) => ({
        providerKey: key,
        providerType: 'responses',
        endpoint: 'https://example.invalid',
        auth: { type: 'apiKey', value: 'test-key' },
        outboundProfile: 'openai-responses',
        modelId: key.split('.').slice(-1)[0] || 'unknown'
      })
    };

    const selected = selectProviderKeyFromCandidatePool({
      routeName: 'default',
      tier: {
        id: 'default-primary',
        targets: [primary, backup],
        priority: 100,
        mode: 'round-robin'
      } as any,
      stickyKey: undefined,
      candidates: [primary, backup],
      isSafePool: true,
      deps: {
        providerRegistry,
        loadBalancer: new RouteLoadBalancer({ strategy: 'round-robin' }),
        healthManager: {
          isAvailable: () => true
        },
        contextAdvisor: {
          getConfig: () => ({ warnRatio: 0.9, hardLimit: false })
        },
        aliasQueueStore: undefined,
        quotaView: undefined
      } as any,
      options: {
        allowAliasRotation: true
      } as any,
      contextResult: {
        safe: [primary, backup],
        risky: [],
        overflow: [],
        usage: {}
      } as any,
      warnRatio: 0.9,
      excludedKeys: new Set([primary]),
      isRecoveryAttempt: true,
      now: Date.now(),
      nowForWeights: Date.now(),
      healthWeightedCfg: { enabled: false } as any,
      contextWeightedCfg: { enabled: false } as any
    });

    expect(selected).toBe(backup);
  });
});
