import { beforeAll, describe, expect, it } from '@jest/globals';

type CoreUtilsModule = typeof import('../../../../../src/server/runtime/http-server/executor/request-executor-core-utils.js');

let coreUtilsModule: CoreUtilsModule;

beforeAll(async () => {
  coreUtilsModule = await import('../../../../../src/server/runtime/http-server/executor/request-executor-core-utils.js');
});

describe('request-executor primary exhausted plan bridge', () => {
  it('[forward] uses the Rust planner contract on raw route-target ids', () => {
    const result = coreUtilsModule.resolvePrimaryExhaustedPlan({
      route: 'coding',
      tiers: [
        { id: 'coding-primary', targets: ['fwd.gpt.gpt-5.5'], priority: 200 },
        { id: 'coding-backup', targets: ['fwd.minimax.MiniMax-M3'], priority: 100, backup: true },
      ],
      exhaustedTargets: ['fwd.gpt.gpt-5.5'],
      knownTargets: ['fwd.gpt.gpt-5.5', 'fwd.minimax.MiniMax-M3'],
    });

    expect(result).toEqual({
      status: 'default_pool',
      defaultPoolTargets: ['fwd.minimax.MiniMax-M3'],
      fromTierId: 'coding-backup',
      fromTierPriority: 100,
    });
  });

  it('[forward] extracts real exhausted route + raw route-target identity from VR error details', () => {
    const context = coreUtilsModule.resolvePrimaryExhaustedRoutingContextFromError({
      code: 'PROVIDER_NOT_AVAILABLE',
      details: {
        primaryExhaustedRouteName: 'coding',
        primaryExhaustedTargets: ['fwd.gpt.gpt-5.5', 'halphen.glm-5.2'],
        unavailableRoutePools: [
          {
            routeName: 'coding',
            poolId: 'coding-primary',
            poolTargets: ['fwd.gpt.gpt-5.5', 'halphen.glm-5.2'],
          },
          {
            routeName: 'default',
            poolId: 'default-primary',
            poolTargets: ['mimo.mimo-v2.5'],
          },
        ],
      },
    });

    expect(context).toEqual({
      route: 'coding',
      exhaustedTargets: ['fwd.gpt.gpt-5.5', 'halphen.glm-5.2'],
    });
  });

  it('[forward] current G3 sample resolves search->default planner output', () => {
    const searchProvider = 'search.key1.gpt-5.4';
    const defaultProvider = 'default.key1.MiniMax-M3';
    const context = coreUtilsModule.resolvePrimaryExhaustedRoutingContextFromError({
      code: 'PROVIDER_NOT_AVAILABLE',
      details: {
        primaryExhaustedRouteName: 'search',
        primaryExhaustedTargets: [searchProvider],
        unavailableRoutePools: [
          {
            routeName: 'search',
            poolId: 'search-primary',
            poolTargets: [searchProvider],
          },
          {
            routeName: 'default',
            poolId: 'default-primary',
            poolTargets: [defaultProvider],
          },
        ],
      },
    });

    expect(context).toEqual({
      route: 'search',
      exhaustedTargets: [searchProvider],
    });

    const plan = coreUtilsModule.resolvePrimaryExhaustedPlan({
      route: context?.route ?? '',
      exhaustedTargets: context?.exhaustedTargets ?? [],
      knownTargets: [searchProvider, defaultProvider],
      tiers: [
        { id: 'search-primary', targets: [searchProvider], priority: 200 },
        { id: 'default-primary', targets: [defaultProvider], priority: 100, backup: true },
      ],
    });

    expect(plan).toEqual({
      status: 'default_pool',
      defaultPoolTargets: [defaultProvider],
      fromTierId: 'default-primary',
      fromTierPriority: 100,
    });
  });

  it('[reverse] does not guess exhausted route from metadata or routingPolicyGroup when VR error lacks route truth', () => {
    const context = coreUtilsModule.resolvePrimaryExhaustedRoutingContextFromError({
      code: 'PROVIDER_NOT_AVAILABLE',
      details: {
        candidateProviderKeys: ['asxs.crsa.gpt-5.4'],
      },
      metadata: {
        routeHint: 'tools',
        routeName: 'search/gateway-priority-5555-weighted-search',
        routecodexRoutingPolicyGroup: 'gateway_priority_5555',
      },
    });

    expect(context).toBeNull();
  });

  it('[reverse] production module no longer exports mutable primary exhausted test setter', () => {
    expect('__setPrimaryExhaustedPlanNativeForTests' in coreUtilsModule).toBe(false);
  });

  it('[forward] known target collection preserves raw route target ids and dedupes in-order', () => {
    expect(coreUtilsModule.collectPrimaryExhaustedKnownTargets([
      { targets: ['fwd.gpt.gpt-5.5', 'halphen.glm-5.2'] },
      { targets: ['fwd.gpt.gpt-5.5', 'fwd.minimax.MiniMax-M3'] },
    ])).toEqual([
      'fwd.gpt.gpt-5.5',
      'halphen.glm-5.2',
      'fwd.minimax.MiniMax-M3',
    ]);
  });

  it('[forward] default tier availability is true only for a remaining default target outside current route pool', () => {
    expect(coreUtilsModule.resolveDefaultTierAvailableForErrorErr05({
      tiers: [
        { id: 'thinking-primary', targets: ['primary.key1.model'], priority: 200 },
        { id: 'thinking-default', targets: ['default.key1.model'], priority: 100, backup: true },
      ],
      routePool: ['primary.key1.model'],
      excludedProviderKeys: new Set(['primary.key1.model']),
    })).toBe(true);
  });

  it('[forward] route default availability includes routing group default route even without backup tier', () => {
    const tiers = coreUtilsModule.buildErrorErr05DefaultAvailabilityTiers({
      routeName: 'thinking',
      routeTiers: [
        { id: 'thinking-primary', targets: ['fwd.paid.gpt-5.4-mini'], priority: 200 },
      ],
      defaultRouteTiers: [
        { id: 'default-primary', targets: ['fwd.gpt.gpt-5.3-codex-spark', 'fwd.minimax.MiniMax-M3'], priority: 100 },
      ],
    });

    expect(coreUtilsModule.resolveDefaultTierAvailableForErrorErr05({
      tiers,
      routePool: [
        'ykk.ykk.gpt-5.4-mini',
        'asxs.crsa.gpt-5.4-mini',
      ],
      excludedProviderKeys: new Set([
        'ykk.ykk.gpt-5.4-mini',
        'asxs.crsa.gpt-5.4-mini',
      ]),
    })).toBe(true);
  });

  it('[forward] ErrorErr05 routing group uses port routingPolicyGroup when metadata is absent', () => {
    expect(coreUtilsModule.resolveErrorErr05RoutingPolicyGroup({
      metadata: {},
      portRoutingPolicyGroup: 'gateway_glm_4444',
    })).toBe('gateway_glm_4444');
  });

  it('[reverse] default tier availability is false when the remaining pool is already the default tier last provider', () => {
    expect(coreUtilsModule.resolveDefaultTierAvailableForErrorErr05({
      tiers: [
        { id: 'default-primary', targets: ['default.key1.model'], priority: 100, backup: true },
      ],
      routePool: ['default.key1.model'],
      excludedProviderKeys: new Set(['default.key1.model']),
    })).toBe(false);
  });
});
