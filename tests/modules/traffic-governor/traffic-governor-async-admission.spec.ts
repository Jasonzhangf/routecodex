import { describe, expect, it } from '@jest/globals';

import {
  trafficGovernorAcquire,
  trafficGovernorRelease,
} from '../../../src/modules/traffic-governor/index.js';

describe('traffic governor async admission', () => {
  it('waits off the Node event loop so an earlier request can release capacity', async () => {
    const unique = `${process.pid}-${Date.now()}`;
    const runtimeKey = `runtime:async-admission:${unique}`;
    const storeRoot = `/tmp/routecodex-traffic-test-${unique}`;
    const first = await trafficGovernorAcquire({
      runtimeKey,
      requestId: 'request:first',
      maxInFlight: 1,
      acquireTimeoutMs: 2_000,
      staleLeaseMs: 10_000,
      storeRoot,
    });

    let releaseTimerFired = false;
    const secondPromise = trafficGovernorAcquire({
      runtimeKey,
      requestId: 'request:second',
      maxInFlight: 1,
      acquireTimeoutMs: 2_000,
      staleLeaseMs: 10_000,
      storeRoot,
    });
    setTimeout(() => {
      releaseTimerFired = true;
      trafficGovernorRelease({
        runtimeKey,
        requestId: first.permit.requestId,
        leaseId: first.permit.leaseId,
        stateKey: first.permit.stateKey,
        storeRoot,
      });
    }, 100);

    const second = await secondPromise;
    expect(releaseTimerFired).toBe(true);
    expect(second.waitedMs).toBeGreaterThanOrEqual(80);
    expect(second.permit.requestId).toBe('request:second');

    trafficGovernorRelease({
      runtimeKey,
      requestId: second.permit.requestId,
      leaseId: second.permit.leaseId,
      stateKey: second.permit.stateKey,
      storeRoot,
    });
  });
});
