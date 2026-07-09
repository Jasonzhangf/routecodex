import type { ProviderErrorEvent } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-provider-runtime-ingress.js';
import {
  getRoutingInstructionState,
  setRoutingInstructionStateErrorReporter,
} from '../servertool/routing-instructions-direct-native.js';

const events: ProviderErrorEvent[] = [];

describe('routing state store observability', () => {
  beforeEach(() => {
    events.length = 0;
    setRoutingInstructionStateErrorReporter((event: ProviderErrorEvent) => {
      events.push(event);
    });
  });

  afterEach(() => {
    setRoutingInstructionStateErrorReporter(undefined);
    events.length = 0;
  });

  test('emits explicit error when refreshing existing persistent state fails', () => {
    const key = 'session:observe-refresh';
    const existing = {
      forcedTarget: undefined,
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
        event.code === 'ROUTING_STATE_REFRESH_FAILED'
        && event.stage === 'routing_state.refresh'
        && event.details?.operation === 'refresh_existing_state'
        && event.details?.key === key
      ))
    ).toBe(true);
  });
});
