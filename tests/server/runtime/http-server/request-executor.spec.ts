import { jest } from '@jest/globals';
import { __requestExecutorTestables, createRequestExecutor } from '../../../../src/server/runtime/http-server/request-executor';
import type { ProviderHandle } from '../../../../src/server/runtime/http-server/types';
import { StatsManager } from '../../../../src/server/runtime/http-server/stats-manager';

function normalizeMinimalSuccessResponse(result: unknown): unknown {
  if (!result || typeof result !== 'object') {
    return result;
  }
  const record = result as { status?: unknown; data?: unknown };
  if (record.status !== 200 || !record.data || typeof record.data !== 'object' || Array.isArray(record.data)) {
    return result;
  }
  const data = record.data as Record<string, unknown>;
  if (
    Array.isArray(data.choices)
    || Array.isArray(data.candidates)
    || Array.isArray(data.output)
    || typeof data.output_text === 'string'
    || typeof data.content === 'string'
    || Object.prototype.hasOwnProperty.call(data, 'error')
    || data.mode === 'sse'
  ) {
    return result;
  }
  const id = typeof data.id === 'string' && data.id.trim() ? data.id.trim() : 'test-ok';
  return {
    ...record,
    data: {
      id,
      object: 'chat.completion',
      model: 'test-model',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'ok'
          },
          finish_reason: 'stop'
        }
      ]
    }
  };
}

function buildHandle(providerKey: string, processFn: () => Promise<unknown>): ProviderHandle {
  return {
    runtimeKey: providerKey,
    providerId: providerKey,
    providerType: 'gemini',
    providerFamily: 'gemini',
    providerProtocol: 'gemini-chat',
    runtime: {
      runtimeKey: providerKey,
      providerId: providerKey,
      keyAlias: providerKey,
      providerType: 'gemini',
      endpoint: 'https://example.invalid',
      auth: { type: 'oauth' },
      outboundProfile: 'gemini-chat'
    },
    instance: {
      async initialize() { },
      async cleanup() { },
      processIncoming: async () => normalizeMinimalSuccessResponse(await processFn())
    }
  };
}

describe('HubRequestExecutor failover', () => {
  beforeEach(() => {
    __requestExecutorTestables.resetRequestExecutorInternalStateForTests();
  });

  test('covers request-executor helper snapshots and truncation utilities', async () => {
    expect(__requestExecutorTestables.readString('  abc  ')).toBe('abc');
    expect(__requestExecutorTestables.readString('')).toBeUndefined();
    expect(__requestExecutorTestables.readString(undefined)).toBeUndefined();

    const rawSnapshot = __requestExecutorTestables.extractRetryErrorSnapshot('plain-error');
    expect(rawSnapshot.reason).toContain('plain-error');

    const detailedSnapshot = __requestExecutorTestables.extractRetryErrorSnapshot({
      statusCode: 429,
      details: { code: 'E_DETAIL', upstream_code: 'rate_limit_error' },
      response: {
        data: {
          error: { code: 'E_RESPONSE' }
        }
      }
    });
    expect(detailedSnapshot.statusCode).toBe(429);
    expect(detailedSnapshot.errorCode).toBe('E_DETAIL');
    expect(detailedSnapshot.upstreamCode).toBe('rate_limit_error');

    const runtimeResolveReportPlan = __requestExecutorTestables.resolveRequestExecutorProviderErrorReportPlan({
      error: Object.assign(new Error('followup failed before send'), {
        code: 'SERVERTOOL_FOLLOWUP_FAILED',
        upstreamCode: 'client_inject_failed',
        statusCode: 502
      }),
      retryError: {
        statusCode: 502,
        errorCode: 'SERVERTOOL_FOLLOWUP_FAILED',
        upstreamCode: 'client_inject_failed',
        reason: 'followup failed before send'
      },
      fallbackStage: 'provider.runtime_resolve'
    });
    expect(runtimeResolveReportPlan).toEqual({
      errorCode: 'SERVERTOOL_FOLLOWUP_FAILED',
      upstreamCode: 'CLIENT_INJECT_FAILED',
      statusCode: 502,
      stageHint: 'provider.runtime_resolve'
    });

    const sseDecodeReportPlan = __requestExecutorTestables.resolveRequestExecutorProviderErrorReportPlan({
      error: Object.assign(
        new Error('Anthropic SSE error event [1305] 该模型当前访问量过大，请您稍后再试'),
        {
          code: 'SSE_DECODE_ERROR',
          upstreamCode: 'anthropic_sse_to_json_failed',
          statusCode: 429
        }
      ),
      retryError: {
        statusCode: 429,
        errorCode: 'SSE_DECODE_ERROR',
        upstreamCode: 'anthropic_sse_to_json_failed',
        reason: 'Anthropic SSE error event [1305] 该模型当前访问量过大，请您稍后再试'
      },
      fallbackStage: 'provider.send'
    });
    expect(sseDecodeReportPlan).toEqual({
      errorCode: 'SSE_DECODE_ERROR',
      upstreamCode: 'ANTHROPIC_SSE_TO_JSON_FAILED',
      statusCode: 429,
      stageHint: 'provider.sse_decode'
    });

    const followupReportPlan = __requestExecutorTestables.resolveRequestExecutorProviderErrorReportPlan({
      error: Object.assign(new Error('followup client inject failed'), {
        code: 'SERVERTOOL_FOLLOWUP_FAILED',
        upstreamCode: 'client_inject_failed',
        statusCode: 502
      }),
      retryError: {
        statusCode: 502,
        errorCode: 'SERVERTOOL_FOLLOWUP_FAILED',
        upstreamCode: 'client_inject_failed',
        reason: 'followup client inject failed'
      },
      fallbackStage: 'provider.send'
    });
    expect(followupReportPlan).toEqual({
      errorCode: 'SERVERTOOL_FOLLOWUP_FAILED',
      upstreamCode: 'CLIENT_INJECT_FAILED',
      statusCode: 502,
      stageHint: 'provider.followup'
    });

    const detailMarkedFollowupPlan = __requestExecutorTestables.resolveRequestExecutorProviderErrorReportPlan({
      error: Object.assign(new Error('followup client inject failed'), {
        code: 'INTERNAL_ERROR',
        statusCode: 502,
        details: {
          requestExecutorProviderErrorStage: 'provider.followup',
          reason: 'client_inject_failed'
        }
      }),
      retryError: {
        statusCode: 502,
        errorCode: 'INTERNAL_ERROR',
        reason: 'followup client inject failed'
      },
      fallbackStage: 'provider.send'
    });
    expect(detailMarkedFollowupPlan).toEqual({
      errorCode: 'INTERNAL_ERROR',
      statusCode: 502,
      stageHint: 'provider.followup'
    });

    const providerHttpReportPlan = __requestExecutorTestables.resolveRequestExecutorProviderErrorReportPlan({
      error: Object.assign(new Error('HTTP 429'), {
        statusCode: 429,
        response: {
          data: {
            error: {
              code: 'HTTP_429',
              message: 'rate limited'
            }
          }
        }
      }),
      retryError: {
        statusCode: 429,
        errorCode: 'HTTP_429',
        reason: 'rate limited'
      },
      fallbackStage: 'provider.http'
    });
    expect(providerHttpReportPlan).toEqual({
      errorCode: 'HTTP_429',
      statusCode: 429,
      stageHint: 'provider.http'
    });

    const stoplessContractReportPlan = __requestExecutorTestables.resolveRequestExecutorProviderErrorReportPlan({
      error: Object.assign(new Error('stopless contract violated'), {
        code: 'STOPLESS_FINALIZATION_MISSING',
        statusCode: 502,
        requestExecutorProviderErrorStage: 'host.stopless_contract'
      }),
      retryError: {
        statusCode: 502,
        errorCode: 'STOPLESS_FINALIZATION_MISSING',
        reason: 'stopless contract violated'
      },
      fallbackStage: 'provider.send'
    });
    expect(stoplessContractReportPlan).toEqual({
      errorCode: 'STOPLESS_FINALIZATION_MISSING',
      statusCode: 502,
      stageHint: 'host.stopless_contract'
    });

    const stoplessExecutionPlan = await __requestExecutorTestables.resolveProviderRetryExecutionPlan({
      error: Object.assign(new Error('stopless contract violated'), {
        code: 'STOPLESS_FINALIZATION_MISSING',
        statusCode: 502,
        retryable: true,
        requestExecutorProviderErrorStage: 'host.stopless_contract'
      }),
      retryError: {
        statusCode: 502,
        errorCode: 'STOPLESS_FINALIZATION_MISSING',
        reason: 'stopless contract violated'
      },
      attempt: 1,
      maxAttempts: 6,
      stage: 'host.stopless_contract',
      providerKey: 'ali-coding-plan.key1.qwen3-coder-next',
      runtimeKey: 'runtime:ali-coding-plan',
      logicalRequestChainKey: 'req-stopless-host',
      logicalChainRetryLimitStageRequestId: 'req-stopless-host',
      routePool: ['ali-coding-plan.key1.qwen3-coder-next', 'crs.key2.gpt-5.3-codex'],
      runtimeManager: {
        resolveRuntimeKey: () => 'runtime:ali-coding-plan'
      },
      excludedProviderKeys: new Set<string>(),
      recordAttempt: jest.fn(),
      logStage: () => undefined,
      status: 502
    });
    expect(stoplessExecutionPlan).toEqual(expect.objectContaining({
      shouldRetry: true,
      excludedCurrentProvider: true,
      backoffScope: 'provider',
      retrySwitchPlan: expect.objectContaining({
        switchAction: 'exclude_and_reroute',
        decisionLabel: 'provider_backoff_then_reroute'
      })
    }));

    const responseContractReportPlan = __requestExecutorTestables.resolveRequestExecutorProviderErrorReportPlan({
      error: Object.assign(new Error('empty assistant payload'), {
        code: 'EMPTY_ASSISTANT_RESPONSE',
        statusCode: 502,
        retryable: true,
        requestExecutorProviderErrorStage: 'host.response_contract'
      }),
      retryError: {
        statusCode: 502,
        errorCode: 'EMPTY_ASSISTANT_RESPONSE',
        reason: 'empty assistant payload'
      },
      fallbackStage: 'provider.send'
    });
    expect(responseContractReportPlan).toEqual({
      errorCode: 'EMPTY_ASSISTANT_RESPONSE',
      statusCode: 502,
      stageHint: 'host.response_contract'
    });

    const responseContractExecutionPlan = await __requestExecutorTestables.resolveProviderRetryExecutionPlan({
      error: Object.assign(new Error('empty assistant payload'), {
        code: 'EMPTY_ASSISTANT_RESPONSE',
        statusCode: 502,
        retryable: true,
        requestExecutorProviderErrorStage: 'host.response_contract'
      }),
      retryError: {
        statusCode: 502,
        errorCode: 'EMPTY_ASSISTANT_RESPONSE',
        reason: 'empty assistant payload'
      },
      attempt: 1,
      maxAttempts: 6,
      stage: 'host.response_contract',
      providerKey: 'qwenchat.aliasA',
      runtimeKey: 'runtime:one',
      logicalRequestChainKey: 'req-response-contract-host',
      logicalChainRetryLimitStageRequestId: 'req-response-contract-host',
      routePool: ['qwenchat.aliasA', 'tab.aliasB'],
      runtimeManager: {
        resolveRuntimeKey: () => 'runtime:one'
      },
      excludedProviderKeys: new Set<string>(),
      recordAttempt: jest.fn(),
      logStage: () => undefined,
      status: 502
    });
    expect(responseContractExecutionPlan).toEqual(expect.objectContaining({
      shouldRetry: true,
      excludedCurrentProvider: false,
      backoffScope: 'attempt',
      retrySwitchPlan: expect.objectContaining({
        switchAction: 'retry_same_provider',
        decisionLabel: 'attempt_backoff_same_provider'
      })
    }));

    const longReason = 'x'.repeat(400);
    const truncated = __requestExecutorTestables.truncateReason(longReason, 50);
    expect(truncated.length).toBe(50);
    expect(truncated.endsWith('…')).toBe(true);

    const excludedProviderKeys = new Set<string>();
    const exclusionPlan = __requestExecutorTestables.resolveProviderRetryExclusionPlan({
      providerKey: 'antigravity.alias1.gemini-3-pro-high',
      status: 429,
      error: Object.assign(new Error('HTTP 429: overload'), { statusCode: 429 }),
      promptTooLong: false,
      isVerify: false,
      isReauth: false,
      antigravityRetrySignal: { signature: 'sig-1', consecutive: 2 },
      excludedProviderKeys
    });
    expect(exclusionPlan.excludedCurrentProvider).toBe(true);
    expect(exclusionPlan.antigravityRetrySignal).toEqual({
      signature: 'sig-1',
      consecutive: 2,
      avoidAllOnRetry: true
    });
    expect(Array.from(excludedProviderKeys)).toEqual(['antigravity.alias1.gemini-3-pro-high']);

    const promptTooLongPlan = __requestExecutorTestables.resolveProviderRetryEligibilityPlan({
      error: new Error('context exceeded'),
      retryError: { statusCode: 400, reason: 'context exceeded' },
      attempt: 1,
      maxAttempts: 6,
      providerKey: 'tabglm.key1.glm-5',
      promptTooLong: true,
      contextOverflowRetries: 1,
      maxContextOverflowRetries: 2
    });
    expect(promptTooLongPlan).toEqual({
      shouldRetry: false,
      blockingRecoverable: false
    });

    expect(__requestExecutorTestables.resolveRequestExecutorProviderErrorClassification({
      error: Object.assign(new Error('context exceeded'), {
        code: 'CONTEXT_LENGTH_EXCEEDED',
        statusCode: 400
      }),
      retryError: {
        statusCode: 400,
        errorCode: 'CONTEXT_LENGTH_EXCEEDED',
        reason: 'context exceeded'
      },
      stage: 'provider.send'
    })).toBe('special_400');

    expect(__requestExecutorTestables.resolveRequestExecutorProviderErrorClassification({
      error: Object.assign(new Error('invalid access token or token expired'), {
        code: 'invalid_api_key',
        statusCode: 401
      }),
      retryError: {
        statusCode: 401,
        errorCode: 'invalid_api_key',
        reason: 'invalid access token or token expired'
      },
      stage: 'provider.send'
    })).toBe('unrecoverable');

    expect(__requestExecutorTestables.resolveRequestExecutorProviderErrorClassification({
      error: Object.assign(new Error('fetch failed'), {
        code: 'HTTP_502',
        statusCode: 502
      }),
      retryError: {
        statusCode: 502,
        errorCode: 'HTTP_502',
        reason: 'fetch failed'
      },
      stage: 'provider.send'
    })).toBe('recoverable');

    const antigravityEligibilityPlan = __requestExecutorTestables.resolveProviderRetryEligibilityPlan({
      error: new Error('Please authenticate with Google OAuth first'),
      retryError: { statusCode: 403, reason: 'Please authenticate with Google OAuth first' },
      attempt: 1,
      maxAttempts: 6,
      providerKey: 'antigravity.alias1.gemini-3-pro-high',
      isVerify: false,
      isReauth: true,
      allowAntigravityRecovery: true
    });
    expect(antigravityEligibilityPlan).toEqual({
      shouldRetry: true,
      blockingRecoverable: false
    });

    const followupEligibilityPlan = __requestExecutorTestables.resolveProviderRetryEligibilityPlan({
      error: Object.assign(new Error('followup failed'), {
        code: 'SERVERTOOL_FOLLOWUP_FAILED',
        statusCode: 401,
        upstreamCode: 'invalid_api_key'
      }),
      retryError: {
        statusCode: 401,
        errorCode: 'SERVERTOOL_FOLLOWUP_FAILED',
        upstreamCode: 'invalid_api_key',
        reason: 'followup failed'
      },
      attempt: 1,
      maxAttempts: 6,
      stage: 'provider.followup',
      providerKey: 'ali-coding-plan.key1.kimi-k2.5'
    });
    expect(followupEligibilityPlan).toEqual({
      shouldRetry: false,
      blockingRecoverable: false
    });

    const previous429Base = process.env.ROUTECODEX_429_BACKOFF_BASE_MS;
    const previous429Max = process.env.ROUTECODEX_429_BACKOFF_MAX_MS;
    process.env.ROUTECODEX_429_BACKOFF_BASE_MS = '1';
    process.env.ROUTECODEX_429_BACKOFF_MAX_MS = '1';
    try {
      const orchestratorExcluded = new Set<string>();
      const recordAttempt = jest.fn();
      const executionPlan = await __requestExecutorTestables.resolveProviderRetryExecutionPlan({
        error: Object.assign(new Error('HTTP 429: overload'), { statusCode: 429, code: 'HTTP_429' }),
        retryError: { statusCode: 429, errorCode: 'HTTP_429', reason: 'HTTP 429: overload' },
        attempt: 1,
        maxAttempts: 6,
        providerKey: 'antigravity.alias1.gemini-3-pro-high',
        runtimeKey: 'runtime:antigravity',
        logicalRequestChainKey: 'req-helper',
        logicalChainRetryLimitStageRequestId: 'req-helper',
        routePool: [
          'antigravity.alias1.gemini-3-pro-high',
          'antigravity.alias2.gemini-3-pro-high'
        ],
        runtimeManager: {
          resolveRuntimeKey: () => 'runtime:antigravity'
        },
        excludedProviderKeys: orchestratorExcluded,
        recordAttempt,
        logStage: () => undefined,
        promptTooLong: false,
        isVerify: false,
        isReauth: false,
        allowAntigravityRecovery: true,
        antigravityRetrySignal: { signature: 'sig-1', consecutive: 2 },
        status: 429
      });
      expect(recordAttempt).toHaveBeenCalledWith({ error: true });
      expect(executionPlan.shouldRetry).toBe(true);
      expect(executionPlan.backoffScope).toBe('provider');
      expect(executionPlan.retrySwitchPlan).toEqual(expect.objectContaining({
        switchAction: 'exclude_and_reroute',
        decisionLabel: 'provider_backoff_then_reroute'
      }));
      expect(executionPlan.antigravityRetrySignal).toEqual({
        signature: 'sig-1',
        consecutive: 2,
        avoidAllOnRetry: true
      });
      expect(Array.from(orchestratorExcluded)).toEqual(['antigravity.alias1.gemini-3-pro-high']);

      const telemetryPlan = __requestExecutorTestables.buildProviderRetryTelemetryPlan({
        requestId: 'req-helper',
        attempt: 1,
        maxAttempts: 6,
        providerKey: 'antigravity.alias1.gemini-3-pro-high',
        retryError: { statusCode: 429, errorCode: 'HTTP_429', reason: 'HTTP 429: overload' },
        excludedProviderKeys: orchestratorExcluded,
        routeHint: 'thinking',
        retryExecutionPlan: executionPlan,
        stage: 'provider.send',
        runtimeKey: 'runtime:antigravity'
      });
      expect(telemetryPlan.switchLogArgs).toEqual(expect.objectContaining({
        requestId: 'req-helper',
        switchAction: 'exclude_and_reroute',
        backoffScope: 'provider',
        decisionLabel: 'provider_backoff_then_reroute',
        stage: 'provider.send'
      }));
      expect(telemetryPlan.retryStageDetails).toEqual(expect.objectContaining({
        providerKey: 'antigravity.alias1.gemini-3-pro-high',
        routeHint: 'thinking',
        switchAction: 'exclude_and_reroute',
        backoffScope: 'provider',
        decisionLabel: 'provider_backoff_then_reroute'
      }));

      const followupExecutionPlan = await __requestExecutorTestables.resolveProviderRetryExecutionPlan({
        error: Object.assign(new Error('followup failed'), {
          code: 'SERVERTOOL_FOLLOWUP_FAILED',
          statusCode: 401,
          upstreamCode: 'invalid_api_key'
        }),
        retryError: {
          statusCode: 401,
          errorCode: 'SERVERTOOL_FOLLOWUP_FAILED',
          upstreamCode: 'invalid_api_key',
          reason: 'followup failed'
        },
        attempt: 1,
        maxAttempts: 6,
        stage: 'provider.followup',
        providerKey: 'ali-coding-plan.key1.kimi-k2.5',
        runtimeKey: 'runtime:ali-coding-plan',
        logicalRequestChainKey: 'req-followup',
        logicalChainRetryLimitStageRequestId: 'req-followup',
        routePool: ['ali-coding-plan.key1.kimi-k2.5', 'qwen.1.qwen3.6-plus'],
        runtimeManager: {
          resolveRuntimeKey: () => 'runtime:ali-coding-plan'
        },
        excludedProviderKeys: new Set<string>(),
        recordAttempt,
        logStage: () => undefined,
        allowAntigravityRecovery: true,
        status: 401
      });
      expect(followupExecutionPlan).toEqual({
        shouldRetry: false,
        blockingRecoverable: false,
        excludedCurrentProvider: false,
        retryBackoffMs: 0,
        recoverableBackoffMs: 0,
        antigravityRetrySignal: null
      });
    } finally {
      if (previous429Base === undefined) {
        delete process.env.ROUTECODEX_429_BACKOFF_BASE_MS;
      } else {
        process.env.ROUTECODEX_429_BACKOFF_BASE_MS = previous429Base;
      }
      if (previous429Max === undefined) {
        delete process.env.ROUTECODEX_429_BACKOFF_MAX_MS;
      } else {
        process.env.ROUTECODEX_429_BACKOFF_MAX_MS = previous429Max;
      }
    }

  });

  test('retries when runtime resolution fails before provider send and then succeeds', async () => {
    const firstProviderKey = 'runtime-missing.alias.model-a';
    const secondProviderKey = 'runtime-ready.alias.model-b';
    const successProcess = jest.fn(async () => ({ status: 200, data: { id: 'ok-after-runtime-retry' } }));
    const successHandle = buildHandle(secondProviderKey, successProcess);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey?: string) => (providerKey === secondProviderKey ? secondProviderKey : undefined),
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey === secondProviderKey ? successHandle : undefined)
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const disabled = new Set<string>(
          Array.isArray(input.metadata?.excludedProviderKeys) ? input.metadata.excludedProviderKeys : []
        );
        const providerKey = disabled.has(firstProviderKey) ? secondProviderKey : firstProviderKey;
        return {
          requestId: input.id,
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'openai',
            outboundProfile: 'openai-chat',
            runtimeKey: providerKey
          },
          routingDecision: { routeName: 'default', pool: [firstProviderKey, secondProviderKey] },
          metadata: {}
        };
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const logStage = jest.fn();
    const deps = {
      runtimeManager,
      getHubPipeline: () => pipeline,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => undefined)
        }
      }),
      logStage,
      stats: new StatsManager()
    };

    const executor = createRequestExecutor(deps);
    const result = await executor.execute({
      requestId: 'req-runtime-retry',
      entryEndpoint: '/v1/responses',
      body: {},
      headers: {},
      metadata: {}
    });

    expect(result).toEqual(expect.objectContaining({ status: 200 }));
    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    expect(successProcess).toHaveBeenCalledTimes(1);
    expect(
      logStage.mock.calls.some(
        (call) =>
          call[0] === 'provider.runtime_resolve.error' &&
          call[1] === 'req-runtime-retry' &&
          call[2]?.providerKey === firstProviderKey
      )
    ).toBe(true);
    expect(
      logStage.mock.calls.some(
        (call) =>
          call[0] === 'provider.retry' &&
          call[1] === 'req-runtime-retry' &&
          Array.isArray(call[2]?.excluded) &&
          call[2]?.excluded.includes(firstProviderKey)
      )
    ).toBe(true);
  });

  test('records attempt and fails fast when hub pipeline is unavailable', async () => {
    const deps = {
      runtimeManager: {
        resolveRuntimeKey: () => undefined,
        getHandleByRuntimeKey: () => undefined
      },
      getHubPipeline: () => null,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => undefined)
        }
      }),
      logStage: jest.fn(),
      stats: new StatsManager()
    };

    const executor = createRequestExecutor(deps);
    await expect(
      executor.execute({
        requestId: 'req-no-pipeline',
        entryEndpoint: '/v1/responses',
        body: {},
        headers: {},
        metadata: {}
      })
    ).rejects.toThrow('Hub pipeline runtime is not initialized');
  });

  test('waits for short recoverable cooldown on pool exhaustion before retrying route selection', async () => {
    const providerKey = 'deepseek-web.1.deepseek-chat';
    const handle = buildHandle(providerKey, async () => ({ status: 200, data: { id: 'ok-after-wait' } }));

    const runtimeManager = {
      resolveRuntimeKey: (key: string) => key,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? (runtimeKey === providerKey ? handle : undefined) : undefined)
    };

    const pipeline = {
      execute: jest.fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('All providers unavailable for route default'), {
            code: 'PROVIDER_NOT_AVAILABLE',
            details: {
              routeName: 'default',
              attempted: ['default:default-primary:health'],
              minRecoverableCooldownMs: 120
            }
          })
        )
        .mockResolvedValueOnce({
          requestId: 'req-cooldown-wait',
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'openai',
            outboundProfile: 'openai-chat',
            runtimeKey: providerKey
          },
          routingDecision: { routeName: 'default' },
          metadata: {}
        }),
      updateVirtualRouterConfig: jest.fn()
    };

    const logStage = jest.fn();
    const deps = {
      runtimeManager,
      getHubPipeline: () => pipeline,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => undefined)
        }
      }),
      logStage,
      stats: new StatsManager()
    };

    const executor = createRequestExecutor(deps);
    const startedAt = Date.now();
    const result = await executor.execute({
      requestId: 'req-cooldown-wait',
      entryEndpoint: '/v1/responses',
      body: {},
      headers: {},
      metadata: {}
    });
    const elapsed = Date.now() - startedAt;

    expect(result).toEqual(expect.objectContaining({ status: 200 }));
    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(
      logStage.mock.calls.some(
        (call) => call[0] === 'provider.route_pool_cooldown_wait' && typeof call[2]?.waitMs === 'number'
      )
    ).toBe(true);
  });


  test('retries with alternate provider after recoverable error', async () => {
    const firstProviderKey = 'antigravity.1-geetasamodgeetasamoda.claude-sonnet-4-5-thinking';
    const secondProviderKey = 'antigravity.2-geetasamodgeetasamoda.claude-sonnet-4-5-thinking';
    const failingError = new Error('HTTP 429: quota exhausted');
    (failingError as any).statusCode = 429;

    const failingProcess = jest.fn(async () => {
      throw failingError;
    });
    const failureHandle = buildHandle(firstProviderKey, failingProcess);
    const successPayload = { status: 200, data: { id: 'ok' } };
    const successProcess = jest.fn(async () => successPayload);
    const successHandle = buildHandle(secondProviderKey, successProcess);

    const handles = new Map<string, ProviderHandle>([
      [firstProviderKey, failureHandle],
      [secondProviderKey, successHandle]
    ]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const disabled = new Set<string>(
          Array.isArray(input.metadata?.excludedProviderKeys)
            ? input.metadata.excludedProviderKeys
            : []
        );
        const providerKey = disabled.has(firstProviderKey)
          ? secondProviderKey
          : firstProviderKey;
        return {
          requestId: input.id,
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'gemini',
            outboundProfile: 'gemini-chat',
            runtimeKey: providerKey
          },
          routingDecision: { routeName: 'thinking' },
          metadata: {}
        };
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => pipeline,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => undefined)
        }
      }),
      logStage: jest.fn(),
      stats: new StatsManager()
    };

    const executor = createRequestExecutor(deps);
    const result = await executor.execute({
      requestId: 'req-retry',
      entryEndpoint: '/v1/responses',
      body: {},
      headers: {},
      metadata: {}
    });

    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    expect(failingProcess).toHaveBeenCalledTimes(1);
    expect(successProcess).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ status: 200 }));
  });

  test('prints retry switch reason and error code to console on failover', async () => {
    const firstProviderKey = 'crs.key2.gpt-5.3-codex';
    const secondProviderKey = 'crs.key1.gpt-5.3-codex';
    const failingError = new Error('Upstream SSE parser terminated');
    (failingError as any).statusCode = 429;
    (failingError as any).code = 'SSE_TO_JSON_ERROR';
    (failingError as any).upstreamCode = 'rate_limit_error';

    const failingProcess = jest.fn(async () => {
      throw failingError;
    });
    const failureHandle = buildHandle(firstProviderKey, failingProcess);
    const successProcess = jest.fn(async () => ({ status: 200, data: { id: 'ok-after-retry' } }));
    const successHandle = buildHandle(secondProviderKey, successProcess);

    const handles = new Map<string, ProviderHandle>([
      [firstProviderKey, failureHandle],
      [secondProviderKey, successHandle]
    ]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const disabled = new Set<string>(
          Array.isArray(input.metadata?.excludedProviderKeys)
            ? input.metadata.excludedProviderKeys
            : []
        );
        const providerKey = disabled.has(firstProviderKey)
          ? secondProviderKey
          : firstProviderKey;
        return {
          requestId: input.id,
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'openai',
            outboundProfile: 'openai-responses',
            runtimeKey: providerKey
          },
          routingDecision: { routeName: 'longcontext' },
          metadata: {}
        };
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => pipeline,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => undefined)
        }
      }),
      logStage: jest.fn(),
      stats: new StatsManager()
    };

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
    try {
      const executor = createRequestExecutor(deps);
      const result = await executor.execute({
        requestId: 'req-switch-log',
        entryEndpoint: '/v1/responses',
        body: {},
        headers: {},
        metadata: {}
      });

      expect(result).toEqual(expect.objectContaining({ status: 200 }));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[provider-switch]'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('status=429'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('code=SSE_TO_JSON_ERROR'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('upstreamCode=rate_limit_error'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('switch=exclude_and_reroute'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('decision=provider_backoff_then_reroute'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('backoffScope=provider'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('provider=crs.key2.gpt-5.3-codex'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('reroutes away from current provider on 429 even when current pool is singleton', async () => {
    const firstProviderKey = 'tabglm.key1.glm-5.1';
    const secondProviderKey = 'crs.key2.gpt-5.3-codex';
    const failingError = Object.assign(new Error('HTTP 429: model overloaded'), {
      statusCode: 429,
      retryable: true
    });

    const failingProcess = jest.fn(async () => {
      throw failingError;
    });
    const failureHandle = buildHandle(firstProviderKey, failingProcess);
    const successProcess = jest.fn(async () => ({ status: 200, data: { id: 'ok-after-reroute' } }));
    const successHandle = buildHandle(secondProviderKey, successProcess);

    const handles = new Map<string, ProviderHandle>([
      [firstProviderKey, failureHandle],
      [secondProviderKey, successHandle]
    ]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const disabled = new Set<string>(
          Array.isArray(input.metadata?.excludedProviderKeys)
            ? input.metadata.excludedProviderKeys
            : []
        );
        const useFallback = disabled.has(firstProviderKey);
        return {
          requestId: input.id,
          providerPayload: {},
          target: {
            providerKey: useFallback ? secondProviderKey : firstProviderKey,
            providerType: 'openai',
            outboundProfile: 'openai-responses',
            runtimeKey: useFallback ? secondProviderKey : firstProviderKey
          },
          routingDecision: { routeName: 'thinking', pool: useFallback ? [secondProviderKey] : [firstProviderKey] },
          metadata: {}
        };
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const logStage = jest.fn();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = {
        runtimeManager,
        getHubPipeline: () => pipeline,
        getModuleDependencies: () => ({
          errorHandlingCenter: {
            handleError: jest.fn(async () => undefined)
          }
        }),
        logStage,
        stats: new StatsManager()
      };

      const executor = createRequestExecutor(deps);
      jest
        .spyOn(executor as any, 'convertProviderResponseIfNeeded')
        .mockResolvedValue({ status: 200, body: { output_text: 'ok-after-reroute' } });
      const result = await executor.execute({
        requestId: 'req-singleton-429-reroute',
        entryEndpoint: '/v1/responses',
        body: {},
        headers: {},
        metadata: {}
      });

      expect(result).toEqual(expect.objectContaining({ status: 200 }));
      expect(pipeline.execute).toHaveBeenCalledTimes(2);
      expect(successProcess).toHaveBeenCalledTimes(1);
      expect(
        logStage.mock.calls.some(
          (call) =>
            call[0] === 'provider.retry' &&
            call[2]?.switchAction === 'exclude_and_reroute' &&
            Array.isArray(call[2]?.excluded) &&
            call[2]?.excluded.includes(firstProviderKey)
        )
      ).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('switch=exclude_and_reroute'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('forces longcontext routeHint on prompt-too-long retry', async () => {
    const firstProviderKey = 'tabglm.key1.glm-5';
    const secondProviderKey = 'tabglm.longcontext.glm-5';
    const failingError = new Error(
      "Request input tokens exceeds the model's maximum context length 202752"
    );
    (failingError as any).code = 'SSE_DECODE_ERROR';
    (failingError as any).statusCode = 400;

    const failingProcess = jest.fn(async () => {
      throw failingError;
    });
    const failureHandle = buildHandle(firstProviderKey, failingProcess);
    const successPayload = { status: 200, data: { id: 'ok' } };
    const successProcess = jest.fn(async () => successPayload);
    const successHandle = buildHandle(secondProviderKey, successProcess);

    const handles = new Map<string, ProviderHandle>([
      [firstProviderKey, failureHandle],
      [secondProviderKey, successHandle]
    ]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const routeHints: Array<string | undefined> = [];
    const pipeline = {
      execute: jest.fn(async (input: any) => {
        routeHints.push(typeof input.metadata?.routeHint === 'string' ? input.metadata.routeHint : undefined);
        const useLongcontext = input.metadata?.routeHint === 'longcontext';
        const providerKey = useLongcontext ? secondProviderKey : firstProviderKey;
        return {
          requestId: input.id,
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'gemini',
            outboundProfile: 'gemini-chat',
            runtimeKey: providerKey
          },
          routingDecision: { routeName: useLongcontext ? 'longcontext' : 'tools' },
          metadata: {}
        };
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => pipeline,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => undefined)
        }
      }),
      logStage: jest.fn(),
      stats: new StatsManager()
    };

    const executor = createRequestExecutor(deps);
    const result = await executor.execute({
      requestId: 'req-context-overflow',
      entryEndpoint: '/v1/responses',
      body: {},
      headers: {},
      metadata: {}
    });

    expect(result).toEqual(expect.objectContaining({ status: 200 }));
    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    expect(routeHints[0]).not.toBe('longcontext');
    expect(routeHints[1]).toBe('longcontext');
  });

  test('rotates antigravity alias on 403 OAuth reauth-required error', async () => {
    const firstProviderKey = 'antigravity.alias1.gemini-3-pro-high';
    const secondProviderKey = 'antigravity.alias2.gemini-3-pro-high';
    const failingError = new Error('HTTP 403: Please authenticate with Google OAuth first');
    (failingError as any).statusCode = 403;
    (failingError as any).retryable = false;

    const failingProcess = jest.fn(async () => {
      throw failingError;
    });
    const failureHandle = buildHandle(firstProviderKey, failingProcess);
    const successPayload = { status: 200, data: { id: 'ok' } };
    const successProcess = jest.fn(async () => successPayload);
    const successHandle = buildHandle(secondProviderKey, successProcess);

    const handles = new Map<string, ProviderHandle>([
      [firstProviderKey, failureHandle],
      [secondProviderKey, successHandle]
    ]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const disabled = new Set<string>(
          Array.isArray(input.metadata?.excludedProviderKeys)
            ? input.metadata.excludedProviderKeys
            : []
        );
        const providerKey = disabled.has(firstProviderKey)
          ? secondProviderKey
          : firstProviderKey;
        return {
          requestId: input.id,
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'gemini',
            outboundProfile: 'gemini-chat',
            runtimeKey: providerKey
          },
          routingDecision: { routeName: 'default' },
          metadata: {}
        };
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => pipeline,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => undefined)
        }
      }),
      logStage: jest.fn(),
      stats: new StatsManager()
    };

    const executor = createRequestExecutor(deps);
    const result = await executor.execute({
      requestId: 'req-403-reauth',
      entryEndpoint: '/v1/responses',
      body: {},
      headers: {},
      metadata: {}
    });

    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    expect(failingProcess).toHaveBeenCalledTimes(1);
    expect(successProcess).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ status: 200 }));
  });
  test('preserves first upstream error when retry-exhausted routing reports provider unavailable', async () => {
    const firstProviderKey = 'glm.1-186.kimi-k2.5';
    const firstError = Object.assign(new Error('HTTP 429: quota exhausted'), {
      statusCode: 429,
      code: 'HTTP_429'
    });

    const failingProcess = jest.fn(async () => {
      throw firstError;
    });
    const failureHandle = buildHandle(firstProviderKey, failingProcess);

    const handles = new Map<string, ProviderHandle>([[firstProviderKey, failureHandle]]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pipeline = {
      execute: jest.fn()
        .mockResolvedValueOnce({
          requestId: 'req-pool-exhausted',
          providerPayload: {},
          target: {
            providerKey: firstProviderKey,
            providerType: 'openai',
            outboundProfile: 'openai-chat',
            runtimeKey: firstProviderKey
          },
          routingDecision: { routeName: 'direct' },
          metadata: {}
        })
        .mockRejectedValueOnce(
          Object.assign(new Error('All providers unavailable for model glm.kimi-k2.5'), {
            code: 'PROVIDER_NOT_AVAILABLE'
          })
        ),
      updateVirtualRouterConfig: jest.fn()
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => pipeline,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => undefined)
        }
      }),
      logStage: jest.fn(),
      stats: new StatsManager()
    };

    const executor = createRequestExecutor(deps);

    await expect(executor.execute({
      requestId: 'req-pool-exhausted',
      entryEndpoint: '/v1/chat/completions',
      body: {},
      headers: {},
      metadata: {}
    })).rejects.toMatchObject({
      message: 'HTTP 429: quota exhausted',
      statusCode: 429,
      code: 'HTTP_429'
    });

    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    const secondCallMetadata = pipeline.execute.mock.calls[1][0].metadata as Record<string, unknown>;
    expect(secondCallMetadata.excludedProviderKeys).toEqual([firstProviderKey]);
  });
  test('preserves first upstream error when singleton selected pool reroute reports provider unavailable', async () => {
    const firstProviderKey = 'glm.key1.glm-4.7';
    const firstError = Object.assign(new Error('HTTP 429: quota exhausted'), {
      statusCode: 429,
      code: 'HTTP_429'
    });

    const failingProcess = jest.fn(async () => {
      throw firstError;
    });
    const failureHandle = buildHandle(firstProviderKey, failingProcess);

    const handles = new Map<string, ProviderHandle>([[firstProviderKey, failureHandle]]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pipeline = {
      execute: jest.fn()
        .mockResolvedValueOnce({
          requestId: 'req-single-pool-unavailable',
          providerPayload: {},
          target: {
            providerKey: firstProviderKey,
            providerType: 'openai',
            outboundProfile: 'openai-chat',
            runtimeKey: firstProviderKey
          },
          routingDecision: { routeName: 'direct', pool: [firstProviderKey] },
          metadata: {}
        })
        .mockRejectedValueOnce(
          Object.assign(new Error('All providers unavailable for model glm.glm-4.7'), {
            code: 'PROVIDER_NOT_AVAILABLE'
          })
        ),
      updateVirtualRouterConfig: jest.fn()
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => pipeline,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => undefined)
        }
      }),
      logStage: jest.fn(),
      stats: new StatsManager()
    };

    const executor = createRequestExecutor(deps);

    await expect(executor.execute({
      requestId: 'req-single-pool-unavailable',
      entryEndpoint: '/v1/chat/completions',
      body: {},
      headers: {},
      metadata: {}
    })).rejects.toMatchObject({
      message: 'HTTP 429: quota exhausted',
      statusCode: 429,
      code: 'HTTP_429'
    });

    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    const secondCallMetadata = pipeline.execute.mock.calls[1][0].metadata as Record<string, unknown>;
    expect(secondCallMetadata.excludedProviderKeys).toEqual([firstProviderKey]);
  });

  test('reroutes on 429 when selected pool is singleton but lower-priority fallback pool still exists', async () => {
    const primaryProviderKey = 'glm.key1.glm-4.7';
    const fallbackProviderKey = 'qwen.key2.qwen3.5-27b';
    const firstError = Object.assign(new Error('HTTP 429: quota exhausted'), {
      statusCode: 429,
      code: 'HTTP_429'
    });

    const primaryProcess = jest.fn(async () => {
      throw firstError;
    });
    const fallbackProcess = jest.fn(async () => ({
      status: 200,
      data: { id: 'ok_after_reroute' }
    }));

    const handles = new Map<string, ProviderHandle>([
      [primaryProviderKey, buildHandle(primaryProviderKey, primaryProcess)],
      [fallbackProviderKey, buildHandle(fallbackProviderKey, fallbackProcess)]
    ]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const excluded = new Set<string>(
          Array.isArray(input.metadata?.excludedProviderKeys)
            ? input.metadata.excludedProviderKeys
            : []
        );
        const useFallback = excluded.has(primaryProviderKey);
        const providerKey = useFallback ? fallbackProviderKey : primaryProviderKey;
        return {
          requestId: 'req-singleton-selected-pool-fallback',
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'openai',
            outboundProfile: 'openai-chat',
            runtimeKey: providerKey
          },
          routingDecision: {
            routeName: 'default',
            pool: [providerKey]
          },
          metadata: {}
        };
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => pipeline,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => undefined)
        }
      }),
      logStage: jest.fn(),
      stats: new StatsManager()
    };

    const executor = createRequestExecutor(deps);
    const result = await executor.execute({
      requestId: 'req-singleton-selected-pool-fallback',
      entryEndpoint: '/v1/chat/completions',
      body: {},
      headers: {},
      metadata: {}
    });

    expect(result).toEqual(expect.objectContaining({ status: 200 }));
    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    expect(primaryProcess).toHaveBeenCalledTimes(1);
    expect(fallbackProcess).toHaveBeenCalledTimes(1);

    const secondCallMetadata = pipeline.execute.mock.calls[1][0].metadata as Record<string, unknown>;
    expect(secondCallMetadata.excludedProviderKeys).toEqual([primaryProviderKey]);
  });

  test('keeps excluding each 429 provider instead of hammering the last one again', async () => {
    const providerA = 'openrouter.key1.qwen/qwen3.6-plus:free';
    const providerB = 'qwen.2-135.qwen3.6-plus';
    const error429A = Object.assign(new Error('HTTP 429: provider A rate limited'), {
      statusCode: 429,
      code: 'HTTP_429'
    });
    const error429B = Object.assign(new Error('HTTP 429: provider B rate limited'), {
      statusCode: 429,
      code: 'HTTP_429'
    });
    const processA = jest.fn(async () => {
      throw error429A;
    });
    let providerBAttempt = 0;
    const processB = jest.fn(async () => {
      providerBAttempt += 1;
      if (providerBAttempt === 1) {
        throw error429B;
      }
      return { status: 200, data: { id: 'ok_after_last_provider_wait' } };
    });

    const handles = new Map<string, ProviderHandle>([
      [providerA, buildHandle(providerA, processA)],
      [providerB, buildHandle(providerB, processB)]
    ]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const excluded = new Set<string>(
          Array.isArray(input.metadata?.excludedProviderKeys)
            ? input.metadata.excludedProviderKeys
            : []
        );
        const providerKey = excluded.has(providerA) ? providerB : providerA;
        return {
          requestId: input.id,
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'openai',
            outboundProfile: 'openai-chat',
            runtimeKey: providerKey
          },
          routingDecision: {
            routeName: 'longcontext',
            pool: [providerA, providerB]
          },
          metadata: {}
        };
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const previousBase = process.env.ROUTECODEX_429_BACKOFF_BASE_MS;
    const previousMax = process.env.ROUTECODEX_429_BACKOFF_MAX_MS;
    process.env.ROUTECODEX_429_BACKOFF_BASE_MS = '1';
    process.env.ROUTECODEX_429_BACKOFF_MAX_MS = '5';

    try {
      const deps = {
        runtimeManager,
        getHubPipeline: () => pipeline,
        getModuleDependencies: () => ({
          errorHandlingCenter: {
            handleError: jest.fn(async () => undefined)
          }
        }),
        logStage: jest.fn(),
        stats: new StatsManager()
      };

      const executor = createRequestExecutor(deps);
      jest
        .spyOn(executor as any, 'convertProviderResponseIfNeeded')
        .mockResolvedValue({ status: 200, body: { output_text: 'ok_after_last_provider_wait' } });
      const result = await executor.execute({
        requestId: 'req-last-provider-429',
        entryEndpoint: '/v1/responses',
        body: {},
        headers: {},
        metadata: {}
      });

      expect(result).toEqual(expect.objectContaining({ status: 200 }));
      expect(pipeline.execute).toHaveBeenCalledTimes(3);
      expect(processA).toHaveBeenCalledTimes(1);
      expect(processB).toHaveBeenCalledTimes(2);

      const secondCallMetadata = pipeline.execute.mock.calls[1][0].metadata as Record<string, unknown>;
      expect(secondCallMetadata.excludedProviderKeys).toEqual([providerA]);
      const thirdCallMetadata = pipeline.execute.mock.calls[2][0].metadata as Record<string, unknown>;
      expect(thirdCallMetadata.excludedProviderKeys).toEqual([providerA, providerB]);
    } finally {
      if (previousBase === undefined) {
        delete process.env.ROUTECODEX_429_BACKOFF_BASE_MS;
      } else {
        process.env.ROUTECODEX_429_BACKOFF_BASE_MS = previousBase;
      }
      if (previousMax === undefined) {
        delete process.env.ROUTECODEX_429_BACKOFF_MAX_MS;
      } else {
        process.env.ROUTECODEX_429_BACKOFF_MAX_MS = previousMax;
      }
    }
  });

  test('keeps generic reroute backoff provider-scoped instead of raising across different providers', async () => {
    const providerA = 'tabglm.key1.glm-5.1';
    const providerB = 'crs.key2.gpt-5.3-codex';
    const providerC = 'ali-coding-plan.key1.qwen3.6-plus';
    const authErrorA = Object.assign(new Error('HTTP 401: provider A unauthorized'), {
      statusCode: 401
    });
    const authErrorB = Object.assign(new Error('HTTP 401: provider B unauthorized'), {
      statusCode: 401
    });
    const processA = jest.fn(async () => {
      throw authErrorA;
    });
    const processB = jest.fn(async () => {
      throw authErrorB;
    });
    const processC = jest.fn(async () => ({ status: 200, data: { id: 'ok_after_provider_scoped_reroute' } }));

    const handles = new Map<string, ProviderHandle>([
      [providerA, buildHandle(providerA, processA)],
      [providerB, buildHandle(providerB, processB)],
      [providerC, buildHandle(providerC, processC)]
    ]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const excluded = new Set<string>(
          Array.isArray(input.metadata?.excludedProviderKeys)
            ? input.metadata.excludedProviderKeys
            : []
        );
        const providerKey = !excluded.has(providerA)
          ? providerA
          : !excluded.has(providerB)
            ? providerB
            : providerC;
        return {
          requestId: input.id,
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'openai',
            outboundProfile: 'openai-chat',
            runtimeKey: providerKey
          },
          routingDecision: {
            routeName: 'thinking',
            pool: [providerA, providerB, providerC]
          },
          metadata: {}
        };
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const previousBase = process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS;
    const previousMax = process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_MAX_MS;
    process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS = '1';
    process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_MAX_MS = '5';

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const executor = createRequestExecutor({
        runtimeManager,
        getHubPipeline: () => pipeline,
        getModuleDependencies: () => ({
          errorHandlingCenter: {
            handleError: jest.fn(async () => undefined)
          }
        }),
        logStage: jest.fn(),
        stats: new StatsManager()
      });
      jest
        .spyOn(executor as any, 'convertProviderResponseIfNeeded')
        .mockResolvedValue({ status: 200, body: { output_text: 'ok_after_provider_scoped_reroute' } });

      const result = await executor.execute({
        requestId: 'req-provider-scoped-reroute-backoff',
        entryEndpoint: '/v1/responses',
        body: {},
        headers: {},
        metadata: {}
      });

      expect(result).toEqual(expect.objectContaining({ status: 200 }));
      const switchLines = warnSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((line) => line.includes('[provider-switch]'));
      expect(switchLines).toHaveLength(2);
      expect(switchLines[0]).toContain(`provider=${providerA}`);
      expect(switchLines[0]).toContain('backoff=1ms');
      expect(switchLines[0]).toContain('backoffScope=provider');
      expect(switchLines[0]).toContain('decision=provider_backoff_then_reroute');
      expect(switchLines[1]).toContain(`provider=${providerB}`);
      expect(switchLines[1]).toContain('backoff=1ms');
      expect(switchLines[1]).toContain('backoffScope=provider');
      expect(switchLines[1]).toContain('decision=provider_backoff_then_reroute');
    } finally {
      warnSpy.mockRestore();
      if (previousBase === undefined) {
        delete process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS;
      } else {
        process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_BASE_MS = previousBase;
      }
      if (previousMax === undefined) {
        delete process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_MAX_MS;
      } else {
        process.env.ROUTECODEX_PROVIDER_RETRY_BACKOFF_MAX_MS = previousMax;
      }
    }
  });

  test('retries failover when upstream SSE error event is retryable network failure', async () => {
    const firstProviderKey = 'deepseek-web.primary.deepseek-chat';
    const secondProviderKey = 'deepseek-web.backup.deepseek-chat';

    const failingProcess = jest.fn(async () => ({
      status: 200,
      data: {
        mode: 'sse',
        error: {
          type: 'error',
          error: {
            type: 'api_error',
            message: 'Internal Network Failure'
          }
        }
      }
    }));
    const successProcess = jest.fn(async () => ({ status: 200, data: { id: 'resp_ok' } }));

    const handles = new Map<string, ProviderHandle>([
      [firstProviderKey, buildHandle(firstProviderKey, failingProcess)],
      [secondProviderKey, buildHandle(secondProviderKey, successProcess)]
    ]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const disabled = new Set<string>(
          Array.isArray(input.metadata?.excludedProviderKeys)
            ? input.metadata.excludedProviderKeys
            : []
        );
        const providerKey = disabled.has(firstProviderKey)
          ? secondProviderKey
          : firstProviderKey;
        return {
          requestId: input.id,
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'openai',
            outboundProfile: 'openai-chat',
            runtimeKey: providerKey
          },
          routingDecision: { routeName: 'deepseek' },
          metadata: {}
        };
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => pipeline,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => undefined)
        }
      }),
      logStage: jest.fn(),
      stats: new StatsManager()
    };

    const executor = createRequestExecutor(deps);
    const result = await executor.execute({
      requestId: 'req-sse-network-retry',
      entryEndpoint: '/v1/messages',
      body: {},
      headers: {},
      metadata: {}
    });

    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    expect(failingProcess).toHaveBeenCalledTimes(1);
    expect(successProcess).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ status: 200 }));
  });

  test('fails over on converted HTTP 401 and returns next provider success', async () => {
    const firstProviderKey = 'opencode-zen-free.key1.mimo-v2-pro-free';
    const secondProviderKey = 'opencode-zen-free.key2.mimo-v2-pro-free';

    const unauthorizedProcess = jest.fn(async () => ({
      status: 401,
      data: {
        error: {
          message: 'Upstream authentication failed'
        }
      }
    }));
    const successProcess = jest.fn(async () => ({ status: 200, data: { id: 'resp_ok' } }));

    const handles = new Map<string, ProviderHandle>([
      [firstProviderKey, buildHandle(firstProviderKey, unauthorizedProcess)],
      [secondProviderKey, buildHandle(secondProviderKey, successProcess)]
    ]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const disabled = new Set<string>(
          Array.isArray(input.metadata?.excludedProviderKeys) ? input.metadata.excludedProviderKeys : []
        );
        const providerKey = disabled.has(firstProviderKey) ? secondProviderKey : firstProviderKey;
        return {
          requestId: input.id,
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'openai',
            outboundProfile: 'openai-chat',
            runtimeKey: providerKey
          },
          routingDecision: { routeName: 'default' },
          metadata: {}
        };
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const logStage = jest.fn();
    const deps = {
      runtimeManager,
      getHubPipeline: () => pipeline,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => undefined)
        }
      }),
      logStage,
      stats: new StatsManager()
    };

    const executor = createRequestExecutor(deps);
    const result = await executor.execute({
      requestId: 'req-401-failover',
      entryEndpoint: '/v1/responses',
      body: {},
      headers: {},
      metadata: {}
    });

    expect(result).toEqual(expect.objectContaining({ status: 200 }));
    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    expect(unauthorizedProcess).toHaveBeenCalledTimes(1);
    expect(successProcess).toHaveBeenCalledTimes(1);
    expect(
      logStage.mock.calls.some(
        (call) =>
          call[0] === 'provider.send.error' &&
          call[1] === 'req-401-failover' &&
          String(call[2]?.message || '').includes('Upstream authentication failed')
      )
    ).toBe(true);
  });

  test('surfaces HTTP 401 only after pool is exhausted', async () => {
    const providerKey = 'opencode-zen-free.key1.mimo-v2-pro-free';
    const previousAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '1';

    try {
      const unauthorizedProcess = jest.fn(async () => ({
        status: 401,
        data: {
          error: {
            message: 'Upstream authentication failed'
          }
        }
      }));

      const handles = new Map<string, ProviderHandle>([
        [providerKey, buildHandle(providerKey, unauthorizedProcess)]
      ]);

      const runtimeManager = {
        resolveRuntimeKey: (key: string) => key,
        getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
      };

      const pipeline = {
        execute: jest.fn(async (input: any) => ({
          requestId: input.id,
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'openai',
            outboundProfile: 'openai-chat',
            runtimeKey: providerKey
          },
          routingDecision: { routeName: 'default', pool: [providerKey] },
          metadata: {}
        })),
        updateVirtualRouterConfig: jest.fn()
      };

      const deps = {
        runtimeManager,
        getHubPipeline: () => pipeline,
        getModuleDependencies: () => ({
          errorHandlingCenter: {
            handleError: jest.fn(async () => undefined)
          }
        }),
        logStage: jest.fn(),
        stats: new StatsManager()
      };

      const executor = createRequestExecutor(deps);
      await expect(executor.execute({
        requestId: 'req-401-exhausted',
        entryEndpoint: '/v1/responses',
        body: {},
        headers: {},
        metadata: {}
      })).rejects.toMatchObject({
        statusCode: 401,
        status: 401,
        message: 'Upstream authentication failed'
      });

      expect(pipeline.execute).toHaveBeenCalledTimes(1);
      expect(unauthorizedProcess).toHaveBeenCalledTimes(1);
    } finally {
      if (previousAttempts === undefined) {
        delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      } else {
        process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = previousAttempts;
      }
    }
  });

  test('surfaces readable SSE error message when upstream error event is non-retryable', async () => {
    const providerKey = 'deepseek-web.primary.deepseek-chat';

    const failingProcess = jest.fn(async () => ({
      status: 200,
      data: {
        mode: 'sse',
        error: {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'Invalid request payload'
          }
        }
      }
    }));

    const handles = new Map<string, ProviderHandle>([
      [providerKey, buildHandle(providerKey, failingProcess)]
    ]);

    const runtimeManager = {
      resolveRuntimeKey: (key: string) => key,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => ({
        requestId: input.id,
        providerPayload: {},
        target: {
          providerKey,
          providerType: 'openai',
          outboundProfile: 'openai-chat',
          runtimeKey: providerKey
        },
        routingDecision: { routeName: 'deepseek' },
        metadata: {}
      })),
      updateVirtualRouterConfig: jest.fn()
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => pipeline,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => undefined)
        }
      }),
      logStage: jest.fn(),
      stats: new StatsManager()
    };

    const executor = createRequestExecutor(deps);

    await expect(executor.execute({
      requestId: 'req-sse-readable',
      entryEndpoint: '/v1/messages',
      body: {},
      headers: {},
      metadata: {}
    })).rejects.toMatchObject({
      code: 'SSE_DECODE_ERROR',
      message: expect.stringContaining('Upstream SSE error event [invalid_request_error]: Invalid request payload')
    });

    expect(pipeline.execute).toHaveBeenCalledTimes(1);
    expect(failingProcess).toHaveBeenCalledTimes(1);
  });

  test('derives logical request chain from followup request id and resolves retry seeds without eager duplicate snapshots', () => {
    expect(__requestExecutorTestables.deriveLogicalRequestChainKey('req-root:reasoning_stop_guard:servertool_followup'))
      .toBe('req-root');

    const serializedSeed = __requestExecutorTestables.prepareRequestPayloadRetrySeed({
      model: 'glm-5',
      messages: [
        {
          role: 'user',
          content: 'hello'
        }
      ]
    });

    expect(serializedSeed.mode).toBe('serialized');
    expect(__requestExecutorTestables.resolveOriginalRequestForResponseConversion(serializedSeed)).toEqual({
      model: 'glm-5',
      messages: [
        {
          role: 'user',
          content: 'hello'
        }
      ]
    });

    const retrySeed = __requestExecutorTestables.prepareRequestPayloadRetrySeed({
      model: 'glm-5',
      messages: [
        {
          role: 'user',
          content: 'x'.repeat(400_000)
        }
      ]
    });

    expect(retrySeed.mode).toBe('snapshot');
    expect((retrySeed as { serializedPayload?: string }).serializedPayload).toBeUndefined();
    expect(__requestExecutorTestables.resolveOriginalRequestForResponseConversion(retrySeed)).toBe(
      (retrySeed as { snapshotPayload: Record<string, unknown> }).snapshotPayload
    );
  });

  test('caps recoverable retry storms within the same logical request chain', async () => {
    const providerA = 'storm.a.glm-5';
    const providerB = 'storm.b.glm-5';
    const providerC = 'storm.c.glm-5';
    const retryable429 = () => Object.assign(new Error('HTTP 429: rate limited'), {
      statusCode: 429,
      code: 'HTTP_429'
    });
    const failingProcess = jest.fn(async () => {
      throw retryable429();
    });

    const handles = new Map<string, ProviderHandle>([
      [providerA, buildHandle(providerA, failingProcess)],
      [providerB, buildHandle(providerB, failingProcess)],
      [providerC, buildHandle(providerC, failingProcess)]
    ]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pool = [providerA, providerB, providerC];
    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const excluded = new Set<string>(
          Array.isArray(input.metadata?.excludedProviderKeys) ? input.metadata.excludedProviderKeys : []
        );
        const providerKey = pool.find((key) => !excluded.has(key)) ?? providerA;
        return {
          requestId: input.id,
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'openai',
            outboundProfile: 'openai-chat',
            runtimeKey: providerKey
          },
          routingDecision: { routeName: 'default', pool },
          metadata: {}
        };
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const previousLimit = process.env.ROUTECODEX_LOGICAL_CHAIN_RECOVERABLE_RETRY_LIMIT;
    const previousBase = process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS;
    const previousMax = process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS;
    process.env.ROUTECODEX_LOGICAL_CHAIN_RECOVERABLE_RETRY_LIMIT = '2';
    process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS = '1';
    process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS = '1';

    try {
      const logStage = jest.fn();
      const deps = {
        runtimeManager,
        getHubPipeline: () => pipeline,
        getModuleDependencies: () => ({
          errorHandlingCenter: {
            handleError: jest.fn(async () => undefined)
          }
        }),
        logStage,
        stats: new StatsManager()
      };

      const executor = createRequestExecutor(deps);
      await expect(executor.execute({
        requestId: 'req-storm-root:reasoning_stop_guard',
        entryEndpoint: '/v1/responses',
        body: {},
        headers: {},
        metadata: {}
      })).rejects.toMatchObject({
        statusCode: 429,
        code: 'HTTP_429'
      });

      expect(pipeline.execute).toHaveBeenCalledTimes(3);
      expect(
        logStage.mock.calls.some(
          (call) => call[0] === 'provider.retry.logical_chain_limit_hit' && call[2]?.logicalRequestChainKey === 'req-storm-root'
        )
      ).toBe(true);
    } finally {
      if (previousLimit === undefined) {
        delete process.env.ROUTECODEX_LOGICAL_CHAIN_RECOVERABLE_RETRY_LIMIT;
      } else {
        process.env.ROUTECODEX_LOGICAL_CHAIN_RECOVERABLE_RETRY_LIMIT = previousLimit;
      }
      if (previousBase === undefined) {
        delete process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS;
      } else {
        process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS = previousBase;
      }
      if (previousMax === undefined) {
        delete process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS;
      } else {
        process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS = previousMax;
      }
    }
  });

  test('caps blocking recoverable retries at maxAttempts without overflowing next attempt logs', async () => {
    const providerA = 'storm.fetch.a';
    const providerB = 'storm.fetch.b';
    const failingProcess = jest.fn(async () => {
      throw Object.assign(new Error('fetch failed'), {
        code: 'HTTP_502',
        statusCode: 502
      });
    });
    const handles = new Map<string, ProviderHandle>([
      [providerA, buildHandle(providerA, failingProcess)],
      [providerB, buildHandle(providerB, failingProcess)]
    ]);

    const pool = [providerA, providerB];
    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const excluded = new Set<string>(
          Array.isArray(input.metadata?.excludedProviderKeys) ? input.metadata.excludedProviderKeys : []
        );
        const providerKey = pool.find((key) => !excluded.has(key)) ?? providerA;
        return {
          requestId: input.id,
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'openai',
            outboundProfile: 'openai-responses',
            runtimeKey: providerKey
          },
          routingDecision: { routeName: 'tools', pool },
          metadata: {}
        };
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const prevAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    const prevBase = process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS;
    const prevMax = process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '2';
    process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS = '1';
    process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS = '1';

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const executor = createRequestExecutor({
        runtimeManager,
        getHubPipeline: () => pipeline,
        getModuleDependencies: () => ({
          errorHandlingCenter: {
            handleError: jest.fn(async () => undefined)
          }
        }),
        logStage: jest.fn(),
        stats: new StatsManager()
      });

      await expect(executor.execute({
        requestId: 'req-fetch-failed-cap',
        entryEndpoint: '/v1/responses',
        body: {},
        headers: {},
        metadata: {}
      })).rejects.toMatchObject({
        statusCode: 502
      });

      expect(pipeline.execute).toHaveBeenCalledTimes(2);
      const switchLines = warnSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((line) => line.includes('[provider-switch]'));
      expect(switchLines).toHaveLength(1);
      expect(switchLines[0]).toContain('attempt=1/2 -> 2/2');
      expect(switchLines[0]).not.toContain('3/2');
    } finally {
      warnSpy.mockRestore();
      if (prevAttempts === undefined) {
        delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      } else {
        process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = prevAttempts;
      }
      if (prevBase === undefined) {
        delete process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS;
      } else {
        process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS = prevBase;
      }
      if (prevMax === undefined) {
        delete process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS;
      } else {
        process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS = prevMax;
      }
    }
  });

  test('isolates recoverable fetch-failed backoff by provider key', () => {
    const prevBase = process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS;
    const prevMax = process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS;
    process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS = '1000';
    process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS = '64000';

    try {
      const keyA = __requestExecutorTestables.buildRecoverableErrorBackoffKey({
        providerKey: 'tabglm.key1.glm-5.1',
        statusCode: 502,
        errorCode: 'HTTP_502',
        reason: 'fetch failed'
      });
      const keyB = __requestExecutorTestables.buildRecoverableErrorBackoffKey({
        providerKey: 'crs.key2.gpt-5.3-codex',
        statusCode: 502,
        errorCode: 'HTTP_502',
        reason: 'fetch failed'
      });

      expect(keyA).not.toBe(keyB);

      const delayA1 = __requestExecutorTestables.consumeRecoverableErrorBackoffMs(keyA, {
        statusCode: 502,
        errorCode: 'HTTP_502',
        reason: 'fetch failed'
      });
      const delayA2 = __requestExecutorTestables.consumeRecoverableErrorBackoffMs(keyA, {
        statusCode: 502,
        errorCode: 'HTTP_502',
        reason: 'fetch failed'
      });
      const delayB1 = __requestExecutorTestables.consumeRecoverableErrorBackoffMs(keyB, {
        statusCode: 502,
        errorCode: 'HTTP_502',
        reason: 'fetch failed'
      });

      expect(delayA1).toBe(1000);
      expect(delayA2).toBe(2000);
      expect(delayB1).toBe(1000);
    } finally {
      if (prevBase === undefined) {
        delete process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS;
      } else {
        process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS = prevBase;
      }
      if (prevMax === undefined) {
        delete process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS;
      } else {
        process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS = prevMax;
      }
    }
  });

  test('rejects when recoverable backoff waiter queue is overloaded', async () => {
    const providerKey = 'ali-coding-plan.key1.glm-5';
    let callCount = 0;
    const processIncoming = jest.fn(async () => {
      callCount += 1;
      if (callCount <= 2) {
        const error = Object.assign(new Error('HTTP 429: Too many requests'), {
          statusCode: 429,
          code: 'HTTP_429',
          retryable: true
        });
        throw error;
      }
      return { status: 200, data: { id: 'ok-after-backoff' } };
    });

    const handle = buildHandle(providerKey, processIncoming);
    const runtimeManager = {
      resolveRuntimeKey: (key: string) => key,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey === providerKey ? handle : undefined)
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => ({
        requestId: input.id,
        providerPayload: {},
        target: {
          providerKey,
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey: providerKey
        },
        routingDecision: { routeName: 'tools', pool: [providerKey] },
        metadata: {}
      })),
      updateVirtualRouterConfig: jest.fn()
    };

    const previousWaiters = process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_WAITERS;
    const previousBase = process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS;
    const previousMax = process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS;
    process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_WAITERS = '1';
    process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS = '500';
    process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS = '500';

    try {
      const deps = {
        runtimeManager,
        getHubPipeline: () => pipeline,
        getModuleDependencies: () => ({
          errorHandlingCenter: {
            handleError: jest.fn(async () => undefined)
          }
        }),
        logStage: jest.fn(),
        stats: new StatsManager()
      };

      const executor = createRequestExecutor(deps);
      const first = executor.execute({
        requestId: 'req-recoverable-overload-1',
        entryEndpoint: '/v1/responses',
        body: {},
        headers: {},
        metadata: {}
      });

      while (processIncoming.mock.calls.length < 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));

      const second = executor.execute({
        requestId: 'req-recoverable-overload-2',
        entryEndpoint: '/v1/responses',
        body: {},
        headers: {},
        metadata: {}
      });

      await expect(second).rejects.toMatchObject({
        statusCode: 429,
        code: 'PROVIDER_TRAFFIC_SATURATED',
        details: expect.objectContaining({
          reason: 'recoverable_waiter_overload'
        })
      });
      await expect(first).resolves.toEqual(expect.objectContaining({ status: 200 }));
    } finally {
      if (previousWaiters === undefined) {
        delete process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_WAITERS;
      } else {
        process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_WAITERS = previousWaiters;
      }
      if (previousBase === undefined) {
        delete process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS;
      } else {
        process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS = previousBase;
      }
      if (previousMax === undefined) {
        delete process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS;
      } else {
        process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS = previousMax;
      }
    }
  });

});

describe('HubRequestExecutor session storm backoff', () => {
  beforeEach(() => {
    __requestExecutorTestables.resetRequestExecutorInternalStateForTests();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-22T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.ROUTECODEX_SESSION_STORM_BACKOFF_BASE_MS;
    delete process.env.RCC_SESSION_STORM_BACKOFF_BASE_MS;
    delete process.env.ROUTECODEX_SESSION_STORM_BACKOFF_MAX_MS;
    delete process.env.RCC_SESSION_STORM_BACKOFF_MAX_MS;
  });

  test('backs off exponentially for repeated provider-unavailable failures', () => {
    process.env.ROUTECODEX_SESSION_STORM_BACKOFF_BASE_MS = '1000';
    process.env.ROUTECODEX_SESSION_STORM_BACKOFF_MAX_MS = '8000';

    const key = __requestExecutorTestables.resolveSessionStormBackoffScope({
      sessionId: 'session-1'
    });
    expect(key).toBe('session:session-1');

    const err = Object.assign(new Error('No available providers after applying routing instructions'), {
      code: 'PROVIDER_NOT_AVAILABLE'
    });
    expect(__requestExecutorTestables.isSessionStormBackoffCandidate(err)).toBe(true);

    expect(__requestExecutorTestables.consumeSessionStormBackoffMs(key!)).toBe(1000);
    expect(__requestExecutorTestables.peekSessionStormBackoffWaitMs(key!)).toBe(1000);

    jest.setSystemTime(new Date('2026-04-22T12:00:00.500Z'));
    expect(__requestExecutorTestables.peekSessionStormBackoffWaitMs(key!)).toBe(500);

    jest.setSystemTime(new Date('2026-04-22T12:00:01.000Z'));
    expect(__requestExecutorTestables.consumeSessionStormBackoffMs(key!)).toBe(2000);
    expect(__requestExecutorTestables.peekSessionStormBackoffWaitMs(key!)).toBe(2000);

    __requestExecutorTestables.clearSessionStormBackoff(key!);
    expect(__requestExecutorTestables.peekSessionStormBackoffWaitMs(key!)).toBe(0);
  });

  test('does not treat generic application errors as storm candidates', () => {
    expect(
      __requestExecutorTestables.isSessionStormBackoffCandidate(new Error('boom'))
    ).toBe(false);
  });
});
