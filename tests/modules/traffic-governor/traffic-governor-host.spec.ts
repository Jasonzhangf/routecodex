import { describe, expect, it, jest } from '@jest/globals';

let nativeBinding: Record<string, unknown> = {};

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/traffic-governor-host.js', () => ({
  getRouterHotpathJsonBindingSync: () => nativeBinding,
}));

const {
  trafficGovernorAcquire,
  trafficGovernorIsAtCapacity,
  trafficGovernorObserveOutcome,
  trafficGovernorRelease,
} = await import('../../../src/modules/traffic-governor/index.js');

describe('traffic-governor narrow native host', () => {
  it('routes traffic governor calls through the narrow host binding', () => {
    const calls: Array<{ capability: string; input: Record<string, unknown> }> = [];
    nativeBinding = {
      trafficGovernorAcquireJson: jest.fn((inputJson: string) => {
        calls.push({ capability: 'acquire', input: JSON.parse(inputJson) as Record<string, unknown> });
        return JSON.stringify({
          permit: {
            runtimeKey: 'runtime:one',
            requestId: 'req_1',
            leaseId: 'lease_1',
            stateKey: 'state_1',
            maxInFlight: 1,
            pid: 123,
            serverId: 'server_1',
            startedAt: 1,
            expiresAt: 2,
          },
          policy: {
            maxInFlight: 1,
            acquireTimeoutMs: 0,
            staleLeaseMs: 60_000,
            requestsPerMinute: 60,
            rpmTimeoutMs: 0,
            rpmWindowMs: 60_000,
          },
          waitedMs: 0,
          activeInFlight: 1,
          rpmInWindow: 1,
        });
      }),
      trafficGovernorReleaseJson: jest.fn((inputJson: string) => {
        calls.push({ capability: 'release', input: JSON.parse(inputJson) as Record<string, unknown> });
        return JSON.stringify({ released: true, activeInFlight: 0 });
      }),
      trafficGovernorIsAtCapacityJson: jest.fn((inputJson: string) => {
        calls.push({ capability: 'capacity', input: JSON.parse(inputJson) as Record<string, unknown> });
        return false;
      }),
      trafficGovernorObserveOutcomeJson: jest.fn((inputJson: string) => {
        calls.push({ capability: 'observe', input: JSON.parse(inputJson) as Record<string, unknown> });
      }),
    };

    const acquired = trafficGovernorAcquire({ runtimeKey: 'runtime:one', requestId: 'req_1' });
    const released = trafficGovernorRelease({
      runtimeKey: 'runtime:one',
      requestId: 'req_1',
      leaseId: acquired.permit.leaseId,
      stateKey: acquired.permit.stateKey,
    });
    const atCapacity = trafficGovernorIsAtCapacity('runtime:one');
    trafficGovernorObserveOutcome({ runtimeKey: 'runtime:one', success: true });

    expect(released.released).toBe(true);
    expect(atCapacity).toBe(false);
    expect(calls.map((call) => call.capability)).toEqual(['acquire', 'release', 'capacity', 'observe']);
    expect(calls.every((call) => call.input.storeRoot === '/tmp/routecodex-traffic')).toBe(true);
  });

  it('fails explicitly when native traffic governor capability is missing', () => {
    nativeBinding = {};

    expect(() => trafficGovernorAcquire({ runtimeKey: 'runtime:missing', requestId: 'req_missing' }))
      .toThrow('[traffic-governor] trafficGovernorAcquireJson not available');
  });
});
