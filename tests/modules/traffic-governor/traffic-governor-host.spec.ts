import { describe, expect, it, jest } from '@jest/globals';

let acquireNative: (inputJson: string) => string | Promise<string>;
let releaseNative: (inputJson: string) => string;
let capacityNative: (inputJson: string) => boolean;
let observeNative: (inputJson: string) => void;

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge/traffic-governor-host.js', () => ({
  trafficGovernorAcquireNativeJson: (inputJson: string) => acquireNative(inputJson),
  trafficGovernorReleaseNativeJson: (inputJson: string) => releaseNative(inputJson),
  trafficGovernorIsAtCapacityNativeJson: (inputJson: string) => capacityNative(inputJson),
  trafficGovernorObserveOutcomeNativeJson: (inputJson: string) => observeNative(inputJson),
}));

const {
  TrafficAdmissionBackpressureError,
  isTrafficAdmissionBackpressureError,
  trafficGovernorAcquire,
  trafficGovernorIsAtCapacity,
  trafficGovernorObserveOutcome,
  trafficGovernorRelease,
} = await import('../../../src/modules/traffic-governor/index.js');

describe('traffic-governor narrow native host', () => {
  it('routes traffic governor calls through the narrow host binding', async () => {
    const calls: Array<{ capability: string; input: Record<string, unknown> }> = [];
    acquireNative = jest.fn((inputJson: string) => {
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
          acquireTimeoutMs: 100,
          staleLeaseMs: 60_000,
          requestsPerMinute: 60,
          rpmTimeoutMs: 100,
          rpmWindowMs: 60_000,
        },
        waitedMs: 0,
        activeInFlight: 1,
        rpmInWindow: 1,
      });
    });
    releaseNative = jest.fn((inputJson: string) => {
      calls.push({ capability: 'release', input: JSON.parse(inputJson) as Record<string, unknown> });
      return JSON.stringify({ released: true, activeInFlight: 0 });
    });
    capacityNative = jest.fn((inputJson: string) => {
      calls.push({ capability: 'capacity', input: JSON.parse(inputJson) as Record<string, unknown> });
      return false;
    });
    observeNative = jest.fn((inputJson: string) => {
      calls.push({ capability: 'observe', input: JSON.parse(inputJson) as Record<string, unknown> });
    });

    const acquired = await trafficGovernorAcquire({
      runtimeKey: 'runtime:one',
      requestId: 'req_1',
      rpmWindowMs: 30_000,
    });
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
    expect(calls[0]?.input.rpmWindowMs).toBe(30_000);
  });

  it('projects bounded saturation as typed non-provider backpressure without HTTP 429', async () => {
    acquireNative = jest.fn(() => JSON.stringify({
      backpressure: {
        code: 'TRAFFIC_ADMISSION_BACKPRESSURE',
        lane: 'concurrency',
        runtimeKey: 'runtime:busy',
        stateKey: 'server:one::runtime:busy',
        timeoutMs: 75,
        waitedMs: 76,
        current: 2,
        limit: 2,
      },
    }));

    let captured: unknown;
    try {
      await trafficGovernorAcquire({ runtimeKey: 'runtime:busy', requestId: 'req_waiter' });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(TrafficAdmissionBackpressureError);
    expect(isTrafficAdmissionBackpressureError(captured)).toBe(true);
    expect(captured).toMatchObject({
      code: 'TRAFFIC_ADMISSION_BACKPRESSURE',
      routecodexErrorKind: 'traffic_admission_backpressure',
      retryable: false,
      lane: 'concurrency',
      timeoutMs: 75,
      waitedMs: 76,
    });
    expect(captured).not.toHaveProperty('statusCode');
    expect(String(captured)).not.toContain('429');
  });

  it('fails fast on malformed native backpressure instead of downgrading it', async () => {
    acquireNative = jest.fn(() => JSON.stringify({
      backpressure: {
        code: 'TRAFFIC_ADMISSION_BACKPRESSURE',
        lane: 'unknown',
      },
    }));

    await expect(trafficGovernorAcquire({ runtimeKey: 'runtime:bad', requestId: 'req_bad' }))
      .rejects.toThrow('[traffic-governor] malformed traffic admission backpressure');
  });
});
