import { describe, expect, test } from '@jest/globals';

import {
  abandonProviderActionAdmissionNative,
  beginProviderActionWaitNative,
  cancelProviderActionWaitNative,
  peekProviderActionWaitNative,
  pollProviderActionAdmissionNative,
  recordProviderActionFailureNative,
  resetProviderActionGateNative,
} from '../../../../../src/modules/llmswitch/bridge/provider-action-gate-host';

describe('request-executor error action queue native routing-group lane', () => {
  test('provider and error-family changes stay sustained until routing-group success reset', () => {
    const unique = `${process.pid}:${Date.now()}`;
    const laneGroupKey = `global_error|port:5555|gateway-priority|${unique}`;
    const providerAKey = `global_error|port:5555|provider-a|tools|HTTP_503|${unique}`;
    const providerBKey = `global_error|port:5555|provider-b|tools|HTTP_429|${unique}`;
    const providerCKey = `global_error|port:5555|provider-c|tools|TIMEOUT|${unique}`;

    const isolated = recordProviderActionFailureNative(providerAKey, laneGroupKey);
    const sustained = recordProviderActionFailureNative(providerBKey, laneGroupKey);
    const promotedFirstLaneWaitMs = peekProviderActionWaitNative(providerAKey);
    const resetCount = resetProviderActionGateNative({ laneGroupKey });
    const isolatedAfterSuccess = recordProviderActionFailureNative(providerCKey, laneGroupKey);

    expect(isolated).toEqual({
      generation: 1,
      mode: 'isolated',
      minimumDelayMs: 1000,
    });
    expect(sustained).toEqual({
      generation: 2,
      mode: 'sustained',
      minimumDelayMs: 5000,
    });
    expect(promotedFirstLaneWaitMs).toBeGreaterThanOrEqual(4900);
    expect(promotedFirstLaneWaitMs).toBeLessThanOrEqual(5000);
    expect(resetCount).toBe(2);
    expect(isolatedAfterSuccess).toEqual({
      generation: 1,
      mode: 'isolated',
      minimumDelayMs: 1000,
    });

    resetProviderActionGateNative({ laneGroupKey });
  });

  test('explicit abandon retains FIFO and starts a full sustained floor', () => {
    const unique = `${process.pid}:${Date.now()}:abandon`;
    const laneGroupKey = `global_error|port:5555|gateway-priority|${unique}`;
    const laneKey = `global_error|port:5555|provider-a|HTTP_429|${unique}`;

    recordProviderActionFailureNative(laneKey, laneGroupKey, 'request-a');
    beginProviderActionWaitNative(laneKey, 'waiter-a', 'request-a');
    expect(peekProviderActionWaitNative(laneKey)).toBeGreaterThanOrEqual(900);

    resetProviderActionGateNative({ laneGroupKey });
    recordProviderActionFailureNative(laneKey, laneGroupKey, 'request-a');
    beginProviderActionWaitNative(laneKey, 'waiter-a', 'request-a');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1010);
    const admitted = pollProviderActionAdmissionNative(laneKey, 'waiter-a', 'request-a');
    expect(admitted.state).toBe('admitted');

    beginProviderActionWaitNative(laneKey, 'waiter-b', 'request-b');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5050);
    expect(
      pollProviderActionAdmissionNative(laneKey, 'waiter-b', 'request-b').state
    ).toBe('wait');
    expect(
      abandonProviderActionAdmissionNative(
        laneKey,
        admitted.generation,
        'request-a'
      )
    ).toBe(true);
    const afterAbandon = peekProviderActionWaitNative(laneKey);
    expect(afterAbandon).toBeGreaterThanOrEqual(4900);
    expect(afterAbandon).toBeLessThanOrEqual(5000);

    cancelProviderActionWaitNative(laneKey, 'waiter-b', 'request-b');
    resetProviderActionGateNative({ laneGroupKey });
  });
});
