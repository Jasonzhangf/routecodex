import { jest } from '@jest/globals';
import { RouteLoadBalancer } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/load-balancer.js';
import { StickySessionManager } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine/sticky-session-manager.js';

describe('virtual-router state pruning', () => {
  const originalStickyTtl = process.env.ROUTECODEX_VR_STICKY_TTL_MS;
  const originalStickyMaxEntries = process.env.ROUTECODEX_VR_STICKY_MAX_ENTRIES;
  const originalSessionTtl = process.env.ROUTECODEX_VR_STICKY_SESSION_TTL_MS;
  const originalSessionMaxEntries = process.env.ROUTECODEX_VR_STICKY_SESSION_MAX_ENTRIES;

  beforeEach(() => {
    process.env.ROUTECODEX_VR_STICKY_TTL_MS = '60000';
    process.env.ROUTECODEX_VR_STICKY_MAX_ENTRIES = '16';
    process.env.ROUTECODEX_VR_STICKY_SESSION_TTL_MS = '60000';
    process.env.ROUTECODEX_VR_STICKY_SESSION_MAX_ENTRIES = '16';
  });

  afterAll(() => {
    process.env.ROUTECODEX_VR_STICKY_TTL_MS = originalStickyTtl;
    process.env.ROUTECODEX_VR_STICKY_MAX_ENTRIES = originalStickyMaxEntries;
    process.env.ROUTECODEX_VR_STICKY_SESSION_TTL_MS = originalSessionTtl;
    process.env.ROUTECODEX_VR_STICKY_SESSION_MAX_ENTRIES = originalSessionMaxEntries;
  });

  it('evicts expired sticky load-balancer pins before selecting', () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000);
    const balancer = new RouteLoadBalancer({ strategy: 'sticky' });
    expect(
      balancer.select({
        routeName: 'default',
        candidates: ['provider-a', 'provider-b'],
        stickyKey: 'session-1',
        availabilityCheck: () => true
      })
    ).toBe('provider-a');

    const states = (balancer as any).states as Map<string, { stickyMap: Map<string, { providerKey: string; updatedAtMs: number }> }>;
    const stickyMap = states.get('default')?.stickyMap;
    expect(stickyMap?.get('session-1')?.providerKey).toBe('provider-a');

    nowSpy.mockReturnValue(62_000);
    expect(
      balancer.select({
        routeName: 'default',
        candidates: ['provider-b'],
        stickyKey: 'session-1',
        availabilityCheck: () => true
      })
    ).toBe('provider-b');
    expect(stickyMap?.get('session-1')?.providerKey).toBe('provider-b');
    nowSpy.mockRestore();
  });

  it('prunes stale sticky session manager records', () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000);
    const manager = new StickySessionManager();
    manager.setAliasQueue('alias-a', ['provider-a']);
    manager.setAliasLease('alias-a', { sessionKey: 'session-1', lastSeenAt: 1_000 });
    manager.setSessionAlias('session-1', 'alias-a');

    const storesAtStart = manager.getAllStores();
    expect(storesAtStart.aliasQueueStore.get('alias-a')).toEqual(['provider-a']);
    expect(storesAtStart.aliasLeaseStore.get('alias-a')?.sessionKey).toBe('session-1');
    expect(storesAtStart.sessionAliasStore.get('session-1')).toBe('alias-a');

    nowSpy.mockReturnValue(62_000);
    const storesAfterTtl = manager.getAllStores();
    expect(storesAfterTtl.aliasQueueStore.has('alias-a')).toBe(false);
    expect(storesAfterTtl.aliasLeaseStore.has('alias-a')).toBe(false);
    expect(storesAfterTtl.sessionAliasStore.has('session-1')).toBe(false);
    nowSpy.mockRestore();
  });
});
