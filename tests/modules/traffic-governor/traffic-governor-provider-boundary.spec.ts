import { describe, expect, it, jest } from '@jest/globals';

import {
  TrafficAdmissionBackpressureError,
} from '../../../src/modules/traffic-governor/index.js';
import {
  processProviderSendFailure,
} from '../../../src/server/runtime/http-server/executor/request-executor-provider-send-failure.js';

describe('traffic admission provider-error boundary', () => {
  it('does not record provider health, report provider failure, or reroute typed backpressure', async () => {
    const error = new TrafficAdmissionBackpressureError({
      code: 'TRAFFIC_ADMISSION_BACKPRESSURE',
      lane: 'concurrency',
      runtimeKey: 'runtime:busy',
      stateKey: 'server:one::runtime:busy',
      timeoutMs: 50,
      waitedMs: 51,
      current: 2,
      limit: 2,
    });
    const errorHandlingCenter = { handleError: jest.fn() };
    const extractRetryErrorSnapshot = jest.fn(() => ({
      errorCode: 'TRAFFIC_ADMISSION_BACKPRESSURE',
      reason: error.message,
    }));
    const recordAttempt = jest.fn();
    const logStage = jest.fn();
    const logProviderRetrySwitch = jest.fn();
    const writeProviderSnapshot = jest.fn(async () => undefined);
    const excludedProviderKeys = new Set<string>();

    await expect(processProviderSendFailure({
      error,
      requestId: 'request:waiter',
      providerKey: 'provider:key',
      providerId: 'provider',
      providerProtocol: 'openai-responses',
      runtimeKey: 'runtime:busy',
      target: { providerKey: 'provider:key', runtimeKey: 'runtime:busy' },
      dependencies: { errorHandlingCenter } as any,
      runtimeManager: { resolveRuntimeKey: (providerKey?: string) => providerKey },
      attempt: 1,
      maxAttempts: 3,
      logicalRequestChainKey: 'request:waiter',
      routePoolForAttempt: ['provider:key', 'provider:other'],
      defaultTierAvailable: true,
      excludedProviderKeys,
      recordAttempt,
      logStage,
      logProviderRetrySwitch,
      bypassTrafficGovernor: false,
      trafficActiveInFlightAtAcquire: 0,
      trafficPolicyMaxInFlight: 2,
      providerSendStartedAtMs: 0,
      providerSendElapsedMs: 0,
      cumulativeExternalLatencyMs: 0,
      contextOverflowRetries: 0,
      maxContextOverflowRetries: 2,
      phase: 'provider_send',
      logNonBlockingError: jest.fn(),
      writeProviderSnapshot,
      extractRetryErrorSnapshot,
    })).rejects.toBe(error);

    expect(extractRetryErrorSnapshot).not.toHaveBeenCalled();
    expect(recordAttempt).not.toHaveBeenCalled();
    expect(logStage).not.toHaveBeenCalled();
    expect(logProviderRetrySwitch).not.toHaveBeenCalled();
    expect(writeProviderSnapshot).not.toHaveBeenCalled();
    expect(errorHandlingCenter.handleError).not.toHaveBeenCalled();
    expect(excludedProviderKeys).toEqual(new Set());
  });
});
