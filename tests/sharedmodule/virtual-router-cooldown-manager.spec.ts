import { describe, expect, it, jest } from '@jest/globals';

import { CooldownManager } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine/cooldown-manager.js';

describe('virtual router cooldown manager non-blocking observability', () => {
  it('logs and throttles restore snapshot failures', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = new CooldownManager({
      healthStore: {
        path: '/tmp/virtual-router-health.json',
        loadInitialSnapshot() {
          throw new Error('restore boom');
        }
      } as any
    });

    manager.restoreHealthFromStore();
    manager.restoreHealthFromStore();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('stage=state_restore');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('operation=load_initial_snapshot');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('/tmp/virtual-router-health.json');

    warnSpy.mockRestore();
  });

  it('logs and throttles persist snapshot failures', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = new CooldownManager({
      healthStore: {
        filepath: '/tmp/virtual-router-health.json',
        loadInitialSnapshot() {
          return null;
        },
        persistSnapshot() {
          throw new Error('persist boom');
        }
      } as any
    });

    manager.markProviderCooldown('provider-a', 5_000);
    manager.persistHealthSnapshot();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('stage=state_persist');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('operation=persist_snapshot');
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('/tmp/virtual-router-health.json');

    warnSpy.mockRestore();
  });
});
