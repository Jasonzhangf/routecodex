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

  it('allows retry planning for response-processing SSE decode failures', async () => {
    const error = Object.assign(new Error('Rust HubPipeline response path failed: hub_pipeline_error: OpenAI chat SSE response did not contain JSON data events'), {
      code: 'SSE_DECODE_ERROR',
      status: 502,
      statusCode: 502,
      retryable: true,
      requestExecutorProviderErrorStage: 'provider.sse_decode'
    });
    const recordAttempt = jest.fn();
    const logProviderRetrySwitch = jest.fn();

    await expect(processProviderSendFailure({
      error,
      requestId: 'req_empty_openai_chat_sse_retryable_response_phase',
      providerKey: 'mini27.key1.MiniMax-M2.7',
      providerId: 'mini27',
      providerType: 'openai',
      providerFamily: 'openai',
      providerProtocol: 'openai-chat',
      providerModel: 'MiniMax-M2.7',
      routeName: 'tools',
      runtimeKey: 'mini27.key1.MiniMax-M2.7',
      target: { providerKey: 'mini27.key1.MiniMax-M2.7', runtimeKey: 'mini27.key1.MiniMax-M2.7' },
      dependencies: { errorHandlingCenter: {}, debugCenter: {}, logger: {} } as any,
      runtimeManager: { resolveRuntimeKey: (providerKey?: string) => providerKey },
      attempt: 1,
      maxAttempts: 3,
      logicalRequestChainKey: 'req_empty_openai_chat_sse_retryable_response_phase',
      routePoolForAttempt: ['mini27.key1.MiniMax-M2.7'],
      excludedProviderKeys: new Set<string>(),
      recordAttempt,
      logStage: jest.fn(),
      logProviderRetrySwitch,
      bypassTrafficGovernor: false,
      trafficGovernor: { observeOutcome: jest.fn() } as any,
      trafficActiveInFlightAtAcquire: 1,
      trafficPolicyMaxInFlight: 4,
      providerTransportBackoffKey: 'mini27.key1.MiniMax-M2.7',
      consumeProviderTransportBackoffMs: jest.fn(() => 0),
      sessionStormBackoffScopes: [],
      isSessionStormBackoffCandidate: jest.fn(() => false),
      consumeSessionStormBackoffMs: jest.fn(() => 0),
      getSessionStormBackoffConsecutive: jest.fn(() => 0),
      providerSendStartedAtMs: Date.now(),
      providerSendElapsedMs: 0,
      cumulativeExternalLatencyMs: 0,
      contextOverflowRetries: 0,
      maxContextOverflowRetries: 2,
      phase: 'provider_response_processing',
      logNonBlockingError: jest.fn(),
      extractRetryErrorSnapshot: () => ({
        statusCode: 502,
        errorCode: 'SSE_DECODE_ERROR',
        reason: error.message
      })
    })).resolves.toMatchObject({
      lastError: error,
      allowBlockingRecoverableRetryBeyondAttemptBudget: false
    });

    expect(recordAttempt).toHaveBeenCalledWith({ error: true });
    expect(logProviderRetrySwitch).toHaveBeenCalledWith(expect.objectContaining({
      switchAction: 'retry_same_provider',
      stage: 'provider.send'
    }));
  });

  it('normalizes raw Rust empty OpenAI chat SSE response-processing failures before retry planning', async () => {
    const error = new Error('Rust HubPipeline response path failed: hub_pipeline_error: OpenAI chat SSE response did not contain JSON data events');
    const recordAttempt = jest.fn();
    const logProviderRetrySwitch = jest.fn();

    await expect(processProviderSendFailure({
      error,
      requestId: 'req_raw_empty_openai_chat_sse_retryable_response_phase',
      providerKey: 'mini27.key1.MiniMax-M2.7',
      providerId: 'mini27',
      providerType: 'openai',
      providerFamily: 'openai',
      providerProtocol: 'openai-chat',
      providerModel: 'MiniMax-M2.7',
      routeName: 'tools',
      runtimeKey: 'mini27.key1.MiniMax-M2.7',
      target: { providerKey: 'mini27.key1.MiniMax-M2.7', runtimeKey: 'mini27.key1.MiniMax-M2.7' },
      dependencies: { errorHandlingCenter: {}, debugCenter: {}, logger: {} } as any,
      runtimeManager: { resolveRuntimeKey: (providerKey?: string) => providerKey },
      attempt: 1,
      maxAttempts: 3,
      logicalRequestChainKey: 'req_raw_empty_openai_chat_sse_retryable_response_phase',
      routePoolForAttempt: ['mini27.key1.MiniMax-M2.7'],
      excludedProviderKeys: new Set<string>(),
      recordAttempt,
      logStage: jest.fn(),
      logProviderRetrySwitch,
      bypassTrafficGovernor: false,
      trafficGovernor: { observeOutcome: jest.fn() } as any,
      trafficActiveInFlightAtAcquire: 1,
      trafficPolicyMaxInFlight: 4,
      providerTransportBackoffKey: 'mini27.key1.MiniMax-M2.7',
      consumeProviderTransportBackoffMs: jest.fn(() => 0),
      sessionStormBackoffScopes: [],
      isSessionStormBackoffCandidate: jest.fn(() => false),
      consumeSessionStormBackoffMs: jest.fn(() => 0),
      getSessionStormBackoffConsecutive: jest.fn(() => 0),
      providerSendStartedAtMs: Date.now(),
      providerSendElapsedMs: 0,
      cumulativeExternalLatencyMs: 0,
      contextOverflowRetries: 0,
      maxContextOverflowRetries: 2,
      phase: 'provider_response_processing',
      logNonBlockingError: jest.fn(),
      extractRetryErrorSnapshot: () => ({ reason: error.message })
    })).resolves.toMatchObject({
      lastError: expect.objectContaining({
        code: 'SSE_DECODE_ERROR',
        statusCode: 502,
        retryable: true,
        requestExecutorProviderErrorStage: 'provider.sse_decode'
      })
    });

    expect(recordAttempt).toHaveBeenCalledWith({ error: true });
    expect(logProviderRetrySwitch).toHaveBeenCalledWith(expect.objectContaining({
      switchAction: 'retry_same_provider',
      stage: 'provider.send'
    }));
  });
});
