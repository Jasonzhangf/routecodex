import { describe, expect, it, jest } from '@jest/globals';

const planPrimaryExhaustedToDefaultPoolNative = jest.fn();

jest.mock('../../../../../src/modules/llmswitch/bridge.js', () => ({
  planPrimaryExhaustedToDefaultPoolNative,
}));

import { resolvePrimaryExhaustedPlan } from '../../../../../src/server/runtime/http-server/executor/request-executor-core-utils.js';

describe('request-executor primary exhausted plan bridge', () => {
  it('[forward] delegates primary_exhausted -> default_pool to native VR planner', () => {
    planPrimaryExhaustedToDefaultPoolNative.mockReturnValue({
      status: 'default_pool',
      defaultPoolTargets: ['sdfv.key1.gpt-5.5'],
      fromTierId: 'primary',
      fromTierPriority: 0,
    });

    const result = resolvePrimaryExhaustedPlan({
      route: 'search',
      tiers: [
        { id: 'primary', targets: ['1token.key1.gpt-5.5'], priority: 0 },
        { id: 'default', targets: ['sdfv.key1.gpt-5.5'], priority: 1, backup: true },
      ],
      exhaustedTargets: ['1token.key1.gpt-5.5'],
      knownTargets: ['1token.key1.gpt-5.5', 'sdfv.key1.gpt-5.5'],
    });

    expect(planPrimaryExhaustedToDefaultPoolNative).toHaveBeenCalledTimes(1);
    expect(planPrimaryExhaustedToDefaultPoolNative).toHaveBeenCalledWith({
      route: 'search',
      tiers: [
        { id: 'primary', targets: ['1token.key1.gpt-5.5'], priority: 0 },
        { id: 'default', targets: ['sdfv.key1.gpt-5.5'], priority: 1, backup: true },
      ],
      exhaustedTargets: ['1token.key1.gpt-5.5'],
      knownTargets: ['1token.key1.gpt-5.5', 'sdfv.key1.gpt-5.5'],
    });
    expect(result).toEqual({
      status: 'default_pool',
      defaultPoolTargets: ['sdfv.key1.gpt-5.5'],
      fromTierId: 'primary',
      fromTierPriority: 0,
    });
  });

  it('[reverse] preserves no_default_pool_needed without synthesizing host fallback targets', () => {
    planPrimaryExhaustedToDefaultPoolNative.mockReturnValue({
      status: 'no_default_pool_needed',
      defaultPoolTargets: [],
      fromTierId: null,
      fromTierPriority: null,
    });

    const result = resolvePrimaryExhaustedPlan({
      route: 'search',
      tiers: [{ id: 'primary', targets: ['1token.key1.gpt-5.5'], priority: 0 }],
      exhaustedTargets: ['1token.key1.gpt-5.5'],
      knownTargets: ['1token.key1.gpt-5.5'],
    });

    expect(result.defaultPoolTargets).toEqual([]);
    expect(result.status).toBe('no_default_pool_needed');
  });
});
