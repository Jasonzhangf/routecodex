import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../../src/server/runtime/handlers/types.js';
import type { HubPipeline, ProviderHandle } from '../../../../src/server/runtime/http-server/types.js';
import type { ProviderRuntimeManager } from '../../../../src/server/runtime/http-server/runtime-manager.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';

const mockProcessProviderSendFailure = jest.fn();

jest.unstable_mockModule(
  '../../../../src/server/runtime/http-server/executor/request-executor-provider-send-failure.js',
  () => ({
    processProviderSendFailure: mockProcessProviderSendFailure
  })
);
jest.unstable_mockModule(
  '../../../../src/server/runtime/http-server/executor/request-executor-provider-send-failure.ts',
  () => ({
    processProviderSendFailure: mockProcessProviderSendFailure
  })
);

const { HubRequestExecutor, __requestExecutorTestables } = await import(
  '../../../../src/server/runtime/http-server/request-executor.js'
);

function createRuntimeHandle(processImpl: () => Promise<unknown>): ProviderHandle {
  return {
    providerType: 'windsurf',
    providerFamily: 'windsurf',
    providerId: 'windsurf',
    instance: {
      processIncoming: jest.fn().mockImplementation(processImpl),
      cleanup: jest.fn()
    }
  } as unknown as ProviderHandle;
}

function createExecutor(handle: ProviderHandle) {
  const pipelineResult: PipelineExecutionResult = {
    providerPayload: { data: { messages: [{ role: 'user', content: 'ping' }] } },
    target: {
      providerKey: 'windsurf.ws-pro-2.gpt-5.4-medium',
      providerType: 'windsurf',
      outboundProfile: 'openai-responses',
      runtimeKey: 'runtime:key',
      processMode: 'standard'
    },
    processMode: 'standard',
    metadata: {}
  };

  const fakePipeline: HubPipeline = {
    execute: jest.fn().mockResolvedValue(pipelineResult)
  };

  const runtimeManager: ProviderRuntimeManager = {
    resolveRuntimeKey: jest.fn().mockReturnValue('runtime:key'),
    getHandleByRuntimeKey: jest.fn().mockReturnValue(handle),
    getHandleByProviderKey: jest.fn(),
    disposeAll: jest.fn(),
    initialize: jest.fn()
  } as unknown as ProviderRuntimeManager;

  const stats = {
    recordRequestStart: jest.fn(),
    recordCompletion: jest.fn(),
    bindProvider: jest.fn(),
    recordToolUsage: jest.fn()
  };

  const errorHandlingCenter = {
    handleError: jest.fn().mockResolvedValue({ success: true })
  };

  const logStage = jest.fn();
  const deps = {
    runtimeManager,
    getHubPipeline: () => fakePipeline,
    getModuleDependencies: (): ModuleDependencies => ({
      errorHandlingCenter
    } as ModuleDependencies),
    logStage,
    stats
  };

  const executor = new HubRequestExecutor(deps);
  const request: PipelineExecutionInput = {
    requestId: 'req_no_response_regression',
    entryEndpoint: '/v1/responses',
    headers: {},
    body: { model: 'gpt-5.4-medium', input: 'ping' },
    metadata: { stream: true, inboundStream: true }
  };

  return { executor, request, logStage };
}

describe('HubRequestExecutor no-response regression guard', () => {
  const originalAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;

  beforeEach(() => {
    __requestExecutorTestables.resetRequestExecutorInternalStateForTests();
    jest.clearAllMocks();
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '1';
  });

  afterAll(() => {
    if (originalAttempts === undefined) {
      delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    } else {
      process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = originalAttempts;
    }
  });

  it('should preserve concrete provider error instead of generic no-response fallback when failure helper drops lastError', async () => {
    const providerError = Object.assign(new Error('windsurf raw stream ended with no content'), {
      code: 'WINDSURF_SERVICE_UNREACHABLE',
      upstreamCode: 'WINDSURF_SERVICE_UNREACHABLE',
      status: 502,
      statusCode: 502,
      retryable: true,
      requestExecutorProviderErrorStage: 'provider.send'
    });
    const handle = createRuntimeHandle(async () => {
      throw providerError;
    });
    mockProcessProviderSendFailure.mockResolvedValue({
      lastError: undefined,
      blockingRecoverableRouteHoldState: null,
      allowBlockingRecoverableRetryBeyondAttemptBudget: false,
      forcedRouteHint: undefined,
      contextOverflowRetries: 0,
      cumulativeExternalLatencyMs: 0
    });
    const { executor, request } = createExecutor(handle);

    await expect(executor.execute(request)).rejects.toMatchObject({
      message: 'windsurf raw stream ended with no content'
    });
  });

  it('should preserve provider code and status on final thrown error instead of throwing bare Provider execution failed without response', async () => {
    const providerError = Object.assign(new Error('windsurf raw stream ended with no content'), {
      code: 'WINDSURF_SERVICE_UNREACHABLE',
      upstreamCode: 'WINDSURF_SERVICE_UNREACHABLE',
      status: 502,
      statusCode: 502,
      retryable: true,
      requestExecutorProviderErrorStage: 'provider.send'
    });
    const handle = createRuntimeHandle(async () => {
      throw providerError;
    });
    mockProcessProviderSendFailure.mockResolvedValue({
      lastError: undefined,
      blockingRecoverableRouteHoldState: null,
      allowBlockingRecoverableRetryBeyondAttemptBudget: false,
      forcedRouteHint: undefined,
      contextOverflowRetries: 0,
      cumulativeExternalLatencyMs: 0
    });
    const { executor, request } = createExecutor(handle);

    await expect(executor.execute(request)).rejects.toMatchObject({
      code: 'WINDSURF_SERVICE_UNREACHABLE',
      upstreamCode: 'WINDSURF_SERVICE_UNREACHABLE',
      statusCode: 502
    });
  });
});
