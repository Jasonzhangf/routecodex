import { describe, expect, it, jest } from '@jest/globals';

import { processProviderSendFailure } from '../../../../../src/server/runtime/http-server/executor/request-executor-provider-send-failure.js';

describe('request executor provider send failure abort handling', () => {
  it('does not record backoff or retry switch after client disconnect abort', async () => {
    const error = Object.assign(new Error('CLIENT_REQUEST_ABORTED'), {
      name: 'AbortError',
      code: 'CLIENT_DISCONNECTED',
      retryable: false
    });
    const controller = new AbortController();
    controller.abort(error);
    const logStage = jest.fn();

    await expect(processProviderSendFailure({
      error,
      requestId: 'req_client_abort_send_failure',
      providerKey: 'cc.key1.gpt-5.5',
      providerId: 'cc',
      providerType: 'responses',
      providerFamily: 'responses',
      providerProtocol: 'openai-responses',
      providerModel: 'gpt-5.5',
      routeName: 'thinking',
      runtimeKey: 'cc.key1.gpt-5.5',
      target: { providerKey: 'cc.key1.gpt-5.5', runtimeKey: 'cc.key1.gpt-5.5' },
      dependencies: { errorHandlingCenter: {}, debugCenter: {}, logger: {} } as any,
      runtimeManager: { resolveRuntimeKey: (providerKey?: string) => providerKey },
      attempt: 4,
      maxAttempts: 6,
      logicalRequestChainKey: 'req_client_abort_send_failure',
      routePoolForAttempt: ['cc.key1.gpt-5.5', 'mimo.key2.mimo-v2.5'],
      excludedProviderKeys: new Set<string>(),
      recordAttempt: jest.fn(),
      logStage,
      logProviderRetrySwitch: jest.fn(),
      bypassTrafficGovernor: false,
      trafficGovernor: { observeOutcome: jest.fn() } as any,
      trafficActiveInFlightAtAcquire: 1,
      trafficPolicyMaxInFlight: 4,
      providerTransportBackoffKey: 'cc.key1.gpt-5.5',
      consumeProviderTransportBackoffMs: jest.fn(() => 1000),
      sessionStormBackoffScopes: [],
      isSessionStormBackoffCandidate: jest.fn(() => false),
      consumeSessionStormBackoffMs: jest.fn(() => 0),
      getSessionStormBackoffConsecutive: jest.fn(() => 0),
      providerSendStartedAtMs: Date.now(),
      providerSendElapsedMs: 0,
      cumulativeExternalLatencyMs: 0,
      contextOverflowRetries: 0,
      maxContextOverflowRetries: 2,
      abortSignal: controller.signal,
      phase: 'provider_send',
      logNonBlockingError: jest.fn(),
      extractRetryErrorSnapshot: () => ({
        errorCode: 'CLIENT_DISCONNECTED',
        upstreamCode: 'CLIENT_DISCONNECTED',
        reason: 'CLIENT_REQUEST_ABORTED'
      })
    })).rejects.toMatchObject({ code: 'CLIENT_DISCONNECTED' });

    expect(logStage.mock.calls.map((call) => call[0])).not.toContain('provider.transport_backoff.recorded');
  });
});
