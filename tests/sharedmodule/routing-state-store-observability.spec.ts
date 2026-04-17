import {
  resetProviderRuntimeIngressForTests,
  setProviderRuntimeObserverHooks
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/provider-runtime-ingress.js';
import type { ProviderErrorEvent } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/types.js';
import {
  getRoutingInstructionState
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine/routing-state/store.js';

describe('routing state store observability', () => {
  let events: ProviderErrorEvent[] = [];
  let observerOwner: object | null = null;

  beforeEach(() => {
    events = [];
    observerOwner = {};
    resetProviderRuntimeIngressForTests();
    setProviderRuntimeObserverHooks(observerOwner, {
      onProviderErrorReported: (event) => {
        events.push(event);
      }
    });
  });

  afterEach(() => {
    if (observerOwner) {
      setProviderRuntimeObserverHooks(observerOwner, undefined);
    }
    observerOwner = null;
    resetProviderRuntimeIngressForTests();
  });

  test('emits explicit error when refreshing existing persistent state fails', () => {
    const key = 'session:observe-refresh';
    const existing = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set<string>(),
      disabledProviders: new Set<string>(),
      disabledKeys: new Map<string, number>(),
      disabledModels: new Map<string, number>(),
      stopMessageText: '继续执行'
    } as any;

    const map = new Map<string, any>([[key, existing]]);
    const store = {
      loadSync: () => {
        throw new Error('persisted read failed');
      },
      saveAsync: () => {}
    };

    const result = getRoutingInstructionState(key, map as any, store as any);
    expect(result).toBe(existing);
    expect(
      events.some((event) => (
        event.code === 'STICKY_STATE_REFRESH_FAILED'
        && event.stage === 'sticky_session.refresh'
        && event.details?.operation === 'refresh_existing_state'
        && event.details?.key === key
      ))
    ).toBe(true);
  });
});
