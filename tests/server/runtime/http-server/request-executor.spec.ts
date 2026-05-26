import { jest } from '@jest/globals';
import { __requestExecutorTestables, createRequestExecutor } from '../../../../src/server/runtime/http-server/request-executor';
import { getServerToolRuntimeState, setServerToolEnabled } from '../../../../src/server/runtime/http-server/servertool-admin-state';
import type { ProviderHandle } from '../../../../src/server/runtime/http-server/types';
import { StatsManager } from '../../../../src/server/runtime/http-server/stats-manager';
import type { ProviderTrafficGovernorLike } from '../../../../src/server/runtime/http-server/provider-traffic-governor.js';

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
  let previousServerToolState: ReturnType<typeof getServerToolRuntimeState>;

  beforeEach(() => {
    __requestExecutorTestables.resetRequestExecutorInternalStateForTests();
    previousServerToolState = getServerToolRuntimeState();
    setServerToolEnabled(false, 'request-executor.spec failover');
  });

  afterEach(() => {
    setServerToolEnabled(previousServerToolState.enabled, previousServerToolState.updatedBy);
  });


  test('reselects alternative windsurf key when transport backoff is still active on newly selected target', async () => {
    const recordAttempt = () => undefined;

    const sameProviderAltKeyExcluded = new Set<string>();
    const sameProviderAltKeyExecutionPlan = await __requestExecutorTestables.resolveProviderRetryExecutionPlan({
      error: Object.assign(new Error('fetch failed'), {
        code: 'HTTP_502',
        statusCode: 502
      }),
      retryError: {
        statusCode: 502,
        errorCode: 'HTTP_502',
        reason: 'fetch failed'
      },
      attempt: 1,
      maxAttempts: 6,
      providerKey: 'windsurf.ws-pro-1.gpt-5.5-medium',
      runtimeKey: 'windsurf.ws-pro-1',
      logicalRequestChainKey: 'req-windsurf-same-provider-next-key',
      logicalChainRetryLimitStageRequestId: 'req-windsurf-same-provider-next-key',
      routePool: [
        'windsurf.ws-pro-1.gpt-5.5-medium',
        'windsurf.ws-pro-2.gpt-5.5-medium',
        'windsurf.ws-pro-3.gpt-5.5-medium'
      ],
      runtimeManager: {
        resolveRuntimeKey: (providerKey?: string) => providerKey ? providerKey.split('.gpt-')[0] : undefined
      },
      excludedProviderKeys: sameProviderAltKeyExcluded,
      recordAttempt,
      logStage: () => undefined,
      status: 502
    });
    expect(sameProviderAltKeyExecutionPlan).toEqual(expect.objectContaining({
      shouldRetry: true,
      excludedCurrentProvider: false,
      retrySwitchPlan: expect.objectContaining({
        switchAction: 'retry_same_provider',
        decisionLabel: 'recoverable_backoff_same_provider'
      })
    }));
    expect(Array.from(sameProviderAltKeyExcluded)).toEqual(['windsurf.ws-pro-1.gpt-5.5-medium']);

    const windsurfStreamCancelExcluded = new Set<string>();
    const windsurfStreamCancelExecutionPlan = await __requestExecutorTestables.resolveProviderRetryExecutionPlan({
      error: Object.assign(new Error('The pending stream has been canceled'), {
        code: 'ERR_HTTP2_STREAM_CANCEL',
        upstreamCode: 'ERR_HTTP2_STREAM_CANCEL'
      }),
      retryError: {
        errorCode: 'ERR_HTTP2_STREAM_CANCEL',
        upstreamCode: 'ERR_HTTP2_STREAM_CANCEL',
        reason: 'The pending stream has been canceled'
      },
      attempt: 1,
      maxAttempts: 6,
      providerKey: 'windsurf.ws-pro-1.gpt-5.4-medium',
      runtimeKey: 'windsurf.ws-pro-1',
      logicalRequestChainKey: 'req-windsurf-stream-cancel-reroute',
      logicalChainRetryLimitStageRequestId: 'req-windsurf-stream-cancel-reroute',
      routePool: [
        'windsurf.ws-pro-1.gpt-5.4-medium',
        'windsurf.ws-pro-2.gpt-5.4-medium',
        'windsurf.ws-pro-3.gpt-5.4-medium'
      ],
      runtimeManager: {
        resolveRuntimeKey: (providerKey?: string) => providerKey ? providerKey.split('.gpt-')[0] : undefined
      },
      excludedProviderKeys: windsurfStreamCancelExcluded,
      recordAttempt,
      logStage: () => undefined,
      status: undefined
    });
    expect(windsurfStreamCancelExecutionPlan).toEqual(expect.objectContaining({
      shouldRetry: true,
      excludedCurrentProvider: true,
      retrySwitchPlan: expect.objectContaining({
        switchAction: 'exclude_and_reroute'
      })
    }));
    expect(Array.from(windsurfStreamCancelExcluded)).toEqual(['windsurf.ws-pro-1.gpt-5.4-medium']);

    const windsurfTransportBackoffExcluded = new Set<string>();
    const windsurfTransportBackoffKey = __requestExecutorTestables.buildProviderTransportBackoffKey({
      providerKey: 'windsurf.ws-pro-1.gpt-5.4-medium',
      runtimeKey: 'windsurf.ws-pro-1'
    });
    expect(typeof windsurfTransportBackoffKey).toBe('string');
    __requestExecutorTestables.consumeProviderTransportBackoffMs(windsurfTransportBackoffKey!, {
      error: Object.assign(new Error('The pending stream has been canceled'), {
        code: 'ERR_HTTP2_STREAM_CANCEL'
      }),
      statusCode: undefined
    });
    expect(__requestExecutorTestables.peekProviderTransportBackoffWaitMs(windsurfTransportBackoffKey!)).toBeGreaterThan(0);

    const backoffReselectionPlan = __requestExecutorTestables.resolveRequestExecutorPipelineAttempt({
      inputRequestId: 'req-windsurf-transport-backoff-reselect',
      providerRequestId: 'req-windsurf-transport-backoff-reselect',
      attempt: 2,
      metadataForAttempt: {},
      pipelineResult: {
        requestId: 'req-windsurf-transport-backoff-reselect',
        metadata: {},
        routingDecision: {
          routeName: 'thinking',
          pool: [
            'windsurf.ws-pro-1.gpt-5.4-medium',
            'windsurf.ws-pro-2.gpt-5.4-medium',
            'windsurf.ws-pro-3.gpt-5.4-medium'
          ]
        },
        providerPayload: { body: { model: 'gpt-5.4-medium' } },
        target: {
          providerKey: 'windsurf.ws-pro-1.gpt-5.4-medium',
          runtimeKey: 'windsurf.ws-pro-1',
          compatibilityProfile: 'chat:windsurf'
        }
      } as any,
      clientHeadersForAttempt: undefined,
      clientRequestId: 'req-windsurf-transport-backoff-reselect',
      clientAbortSignal: undefined,
      initialRoutePool: null,
      excludedProviderKeys: windsurfTransportBackoffExcluded,
      lastError: Object.assign(new Error('The pending stream has been canceled'), {
        code: 'ERR_HTTP2_STREAM_CANCEL'
      }),
      throwIfClientAbortSignalAborted: () => undefined,
      logStage: () => undefined,
      extractRetryErrorSnapshot: __requestExecutorTestables.extractRetryErrorSnapshot,
      hubStartedAtMs: Date.now() - 10,
      pipelineLabel: 'hub'
    });
    expect(backoffReselectionPlan).toEqual({
      kind: 'retry_next_attempt',
      initialRoutePool: [
        'windsurf.ws-pro-1.gpt-5.4-medium',
        'windsurf.ws-pro-2.gpt-5.4-medium',
        'windsurf.ws-pro-3.gpt-5.4-medium'
      ]
    });
    expect(Array.from(windsurfTransportBackoffExcluded)).toEqual(['windsurf.ws-pro-1.gpt-5.4-medium']);
    __requestExecutorTestables.clearProviderTransportBackoff(windsurfTransportBackoffKey!);

    const windsurfWeeklyQuotaExcluded = new Set<string>();
    const windsurfWeeklyQuotaExecutionPlan = await __requestExecutorTestables.resolveProviderRetryExecutionPlan({
      error: Object.assign(
        new Error('Your weekly usage quota has been exhausted. Please ensure Windsurf is up to date for the best experience, or visit windsurf.com to manage your plan.'),
        {
          code: 'WINDSURF_WEEKLY_QUOTA_EXHAUSTED',
          upstreamCode: 'WINDSURF_WEEKLY_QUOTA_EXHAUSTED',
          status: 429,
          retryable: false,
          rateLimitKind: 'daily_limit',
          cooldownOverrideMs: 24 * 60 * 60_000,
          quotaScope: 'weekly',
          quotaReason: 'windsurf_weekly_exhausted'
        }
      ),
      retryError: {
        statusCode: 429,
        errorCode: 'WINDSURF_WEEKLY_QUOTA_EXHAUSTED',
        upstreamCode: 'WINDSURF_WEEKLY_QUOTA_EXHAUSTED',
        reason: 'Your weekly usage quota has been exhausted.'
      },
      attempt: 1,
      maxAttempts: 6,
      providerKey: 'windsurf.ws-pro-1.gpt-5.4-medium',
      runtimeKey: 'windsurf.ws-pro-1',
      logicalRequestChainKey: 'req-windsurf-weekly-quota-reroute',
      logicalChainRetryLimitStageRequestId: 'req-windsurf-weekly-quota-reroute',
      routePool: [
        'windsurf.ws-pro-1.gpt-5.4-medium',
        'windsurf.ws-pro-2.gpt-5.4-medium',
        'windsurf.ws-pro-3.gpt-5.4-medium'
      ],
      runtimeManager: {
        resolveRuntimeKey: (providerKey?: string) => providerKey ? providerKey.split('.gpt-')[0] : undefined
      },
      excludedProviderKeys: windsurfWeeklyQuotaExcluded,
      recordAttempt,
      logStage: () => undefined,
      status: 429
    });
    expect(windsurfWeeklyQuotaExecutionPlan).toEqual(expect.objectContaining({
      shouldRetry: true,
      excludedCurrentProvider: true,
      holdOnLastAvailable429: false
    }));
    expect(windsurfWeeklyQuotaExecutionPlan.retrySwitchPlan).toEqual(expect.objectContaining({
      switchAction: 'exclude_and_reroute'
    }));
    expect(Array.from(windsurfWeeklyQuotaExcluded)).toEqual(['windsurf.ws-pro-1.gpt-5.4-medium']);
  });

  test('RED: windsurf provider-owned account/session sticky must not leak account routing to executor layer', async () => {
    const recordAttempt = () => undefined;
    const excluded = new Set<string>();
    const executionPlan = await __requestExecutorTestables.resolveProviderRetryExecutionPlan({
      error: Object.assign(new Error('provider-internal transient'), {
        code: 'WINDSURF_UPSTREAM_TRANSIENT',
        upstreamCode: 'WINDSURF_UPSTREAM_TRANSIENT',
        status: 502,
        retryable: true,
        retryScope: 'provider-internal-only',
        providerAccountOwnership: 'internal',
      }),
      retryError: {
        statusCode: 502,
        errorCode: 'WINDSURF_UPSTREAM_TRANSIENT',
        upstreamCode: 'WINDSURF_UPSTREAM_TRANSIENT',
        reason: 'provider-internal transient'
      },
      attempt: 1,
      maxAttempts: 6,
      providerKey: 'windsurf.ws-pro-1.gpt-5.3-codex-low',
      runtimeKey: 'windsurf.ws-pro-1',
      logicalRequestChainKey: 'req-windsurf-provider-internal-sticky',
      logicalChainRetryLimitStageRequestId: 'req-windsurf-provider-internal-sticky',
      routePool: [
        'windsurf.ws-pro-1.gpt-5.3-codex-low',
        'windsurf.ws-pro-2.gpt-5.3-codex-low'
      ],
      runtimeManager: {
        resolveRuntimeKey: (providerKey?: string) => providerKey ? providerKey.split('.gpt-')[0] : undefined
      },
      excludedProviderKeys: excluded,
      recordAttempt,
      logStage: () => undefined,
      status: 502
    });

    expect(executionPlan).toEqual(expect.objectContaining({
      shouldRetry: true,
      excludedCurrentProvider: false,
      retrySwitchPlan: expect.objectContaining({
        switchAction: 'retry_same_provider'
      })
    }));
    expect(Array.from(excluded)).toEqual([]);
  });

  test('propagates concurrency busy state by runtime/alias scope instead of provider target key', async () => {
    let busyCallback: ((scopeKey: string, busy: boolean) => void) | null = null;
    const fakeTrafficGovernor: ProviderTrafficGovernorLike = {
      setConcurrencyBusyCallback(cb) {
        busyCallback = cb;
      },
      async acquire() {
        return {
          permit: {
            runtimeKey: 'deepseek-web.2',
            providerKey: 'deepseek-web.2.deepseek-v4-pro',
            requestId: 'req-1',
            leaseId: 'lease-1',
            stateKey: 'deepseek-web.2',
            maxInFlight: 1
          },
          policy: {
            concurrency: { maxInFlight: 1, acquireTimeoutMs: 100, staleLeaseMs: 1000 },
            rpm: { requestsPerMinute: 10, acquireTimeoutMs: 100, windowMs: 60000 }
          },
          waitedMs: 0,
          activeInFlight: 1,
          rpmInWindow: 1
        };
      },
      async release() {
        return { released: true, activeInFlight: 0 };
      },
      async isProviderAtConcurrencyCapacity() { return false; },
      isProviderAtConcurrencyCapacitySync() { return false; },
      async observeOutcome() {}
    };
    const marks: string[] = [];
    createRequestExecutor({
      runtimeManager: {
        resolveRuntimeKey: jest.fn(),
        getHandleByRuntimeKey: jest.fn()
      },
      getHubPipeline: () => ({
        getVirtualRouter: () => ({
          markConcurrencyScopeBusy(key: string) {
            marks.push(`busy:${key}`);
          },
          markConcurrencyScopeIdle(key: string) {
            marks.push(`idle:${key}`);
          }
        })
      } as any),
      getModuleDependencies: () => ({}) as any,
      logStage: jest.fn(),
      shouldLogStageEvent: () => false,
      stats: new StatsManager(),
      trafficGovernor: fakeTrafficGovernor
    });
    expect(busyCallback).not.toBeNull();
    busyCallback?.('deepseek-web.2', true);
    busyCallback?.('deepseek-web.2', false);
    expect(marks).toEqual(['busy:deepseek-web.2', 'idle:deepseek-web.2']);
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
      stage: 'provider.runtime_resolve'
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
      stage: 'provider.send'
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
      stage: 'provider.send'
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
      stage: 'provider.send'
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
      stage: 'provider.http'
    });
    expect(providerHttpReportPlan).toEqual({
      errorCode: 'HTTP_429',
      statusCode: 429,
      stageHint: 'provider.http'
    });

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
      stage: 'provider.send'
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
    expect(responseContractExecutionPlan).toEqual({
      shouldRetry: false,
      blockingRecoverable: false,
      excludedCurrentProvider: false,
      holdOnLastAvailable429: false,
      retryBackoffMs: 0,
      recoverableBackoffMs: 0,
    });

    const missingToolCallReportPlan = __requestExecutorTestables.resolveRequestExecutorProviderErrorReportPlan({
      error: Object.assign(new Error('missing required tool call'), {
        code: 'MISSING_REQUIRED_TOOL_CALL',
        statusCode: 502,
        retryable: true,
        requestExecutorProviderErrorStage: 'host.response_contract'
      }),
      retryError: {
        statusCode: 502,
        errorCode: 'MISSING_REQUIRED_TOOL_CALL',
        reason: 'missing required tool call'
      },
      stage: 'provider.send'
    });
    expect(missingToolCallReportPlan).toEqual({
      errorCode: 'MISSING_REQUIRED_TOOL_CALL',
      statusCode: 502,
      stageHint: 'host.response_contract'
    });

    const missingToolCallExecutionPlan = await __requestExecutorTestables.resolveProviderRetryExecutionPlan({
      error: Object.assign(new Error('missing required tool call'), {
        code: 'MISSING_REQUIRED_TOOL_CALL',
        statusCode: 502,
        retryable: true,
        requestExecutorProviderErrorStage: 'host.response_contract'
      }),
      retryError: {
        statusCode: 502,
        errorCode: 'MISSING_REQUIRED_TOOL_CALL',
        reason: 'missing required tool call'
      },
      attempt: 1,
      maxAttempts: 6,
      stage: 'host.response_contract',
      providerKey: 'qwenchat.aliasA',
      runtimeKey: 'runtime:one',
      logicalRequestChainKey: 'req-missing-tool-call-host',
      logicalChainRetryLimitStageRequestId: 'req-missing-tool-call-host',
      routePool: ['qwenchat.aliasA', 'tab.aliasB'],
      runtimeManager: {
        resolveRuntimeKey: () => 'runtime:one'
      },
      excludedProviderKeys: new Set<string>(),
      recordAttempt: jest.fn(),
      logStage: () => undefined,
      status: 502
    });
    expect(missingToolCallExecutionPlan).toEqual({
      shouldRetry: false,
      blockingRecoverable: false,
      excludedCurrentProvider: false,
      holdOnLastAvailable429: false,
      retryBackoffMs: 0,
      recoverableBackoffMs: 0,
    });

    expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
      status: 'completed',
      output: [
        {
          type: 'reasoning',
          text: 'internal only'
        }
      ],
      reasoning: 'internal only'
    })).toBeNull();

    expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            reasoning: 'internal only'
          }
        }
      ]
    })).toMatchObject({
      marker: 'chat_empty_assistant'
    });

    expect(__requestExecutorTestables.hasRequestedToolsInSemantics({
      tools: {
        clientToolsRaw: [
          {
            type: 'function',
            function: { name: 'exec_command' }
          }
        ]
      }
    })).toBe(true);

    expect(__requestExecutorTestables.isRequiredToolCallTurn({
      tools: {
        clientToolsRaw: [
          {
            type: 'function',
            function: { name: 'exec_command' }
          }
        ]
      },
      responses: {
        toolChoice: 'required'
      }
    })).toBe(true);

    expect(__requestExecutorTestables.isRequiredToolCallTurn({
      tools: {
        clientToolsRaw: [
          {
            type: 'function',
            function: { name: 'exec_command' }
          }
        ]
      },
      responses: {
        toolChoice: 'auto'
      }
    })).toBe(false);

    expect(__requestExecutorTestables.isToolResultFollowupTurn({
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: 'ok'
        }
      ]
    })).toBe(true);

    expect(__requestExecutorTestables.isToolResultFollowupTurn({
      continuation: {
        toolContinuation: {
          mode: 'submit_tool_outputs',
          submittedToolCallIds: ['call_submit_1']
        }
      },
      toolOutputs: [
        {
          tool_call_id: 'call_submit_1',
          content: 'ok'
        }
      ],
      responses: {
        resume: {
          restoredFromResponseId: 'resp_submit_prev_1',
          toolOutputsDetailed: [
            {
              callId: 'call_submit_1',
              outputText: 'ok'
            }
          ]
        }
      }
    })).toBe(true);

    expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: '我可以先给你一个验证脚本。'
          }
        }
      ]
    }, {
      tools: {
        clientToolsRaw: [
          {
            type: 'function',
            function: { name: 'exec_command' }
          }
        ]
      },
      responses: {
        toolChoice: 'required'
      }
    })).toMatchObject({
      marker: 'chat_missing_required_tool_call'
    });

    expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: '工具执行完成，我继续给出结果。'
          }
        }
      ]
    }, {
      tools: {
        clientToolsRaw: [
          {
            type: 'function',
            function: { name: 'exec_command' }
          }
        ]
      },
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: 'ok'
        }
      ]
    })).toBeNull();

    expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_exec_1',
                type: 'function',
                function: {
                  name: 'exec_command',
                  arguments: JSON.stringify({ cmd: 'pwd' })
                }
              }
            ]
          }
        }
      ]
    }, {
      tools: {
        clientToolsRaw: [
          {
            type: 'function',
            function: { name: 'exec_command' }
          }
        ]
      },
      __routecodex: {
        serverToolFollowup: true,
        serverToolFollowupSource: 'servertool.reasoning_stop_guard'
      }
    })).toBeNull();

    expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
      status: 'requires_action',
      required_action: {
        submit_tool_outputs: {
          tool_calls: [
            {
              id: 'call_exec_2',
              type: 'function',
              function: {
                name: 'exec_command',
                arguments: JSON.stringify({ cmd: 'ls' })
              }
            }
          ]
        }
      },
      output: [
        {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call_exec_2',
          arguments: JSON.stringify({ cmd: 'ls' })
        }
      ]
    }, {
      tools: {
        clientToolsRaw: [
          {
            type: 'function',
            function: { name: 'exec_command' }
          }
        ]
      },
      __routecodex: {
        serverToolFollowup: true,
        serverToolFollowupSource: 'servertool.reasoning_stop_guard'
      }
    })).toBeNull();

    expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: '我已经完成了，下面给你结果。'
          }
        }
      ]
    }, {
      __routecodex: {
        serverToolFollowup: true,
        serverToolFollowupSource: 'servertool.reasoning_stop_continue'
      },
      tools: {
        clientToolsRaw: [
          {
            type: 'function',
            function: { name: 'exec_command' }
          }
        ]
      },
      responses: {
        toolChoice: 'auto'
      },
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: 'ok'
        }
      ]
    })).toMatchObject({
      marker: 'chat_missing_required_tool_call'
    });

    expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
      status: 'completed',
      output_text: '请你手动更新 secret 后再告诉我结果。',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: '请你手动更新 secret 后再告诉我结果。' }
          ]
        }
      ]
    }, {
      tools: {
        clientToolsRaw: [
          {
            type: 'function',
            function: { name: 'exec_command' }
          }
        ]
      },
      responses: {
        toolChoice: 'required'
      },
      messages: [
        {
          role: 'user',
          content: '继续执行'
        }
      ]
    })).toMatchObject({
      marker: 'responses_missing_required_tool_call'
    });

    expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
      status: 'completed',
      output_text: '我已经完成审计，下面是结果。',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: '我已经完成审计，下面是结果。' }
          ]
        }
      ]
    }, {
      tools: {
        clientToolsRaw: [
          {
            type: 'function',
            function: { name: 'exec_command' }
          }
        ]
      },
      responses: {
        toolChoice: 'auto'
      },
      messages: [
        {
          role: 'user',
          content: '继续执行'
        }
      ]
    })).toBeNull();

    const malformedToolWrapperText = `<tool_call>
{"arguments":{"cmd":"bash -lc 'pwd'","justification":"check"}}
</tool_call>`;

    expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
      __sse_responses: true,
      __routecodex_finish_reason: 'stop',
      __routecodex_stream_contract_probe_body: {
        status: 'completed',
        output_text: malformedToolWrapperText,
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: malformedToolWrapperText
              }
            ]
          }
        ]
      }
    }, {
      tools: {
        clientToolsRaw: [
          {
            type: 'function',
            function: { name: 'exec_command' }
          }
        ]
      },
      responses: {
        toolChoice: 'required'
      },
      messages: [
        {
          role: 'user',
          content: '继续'
        }
      ]
    })).toMatchObject({
      marker: 'responses_missing_required_tool_call'
    });

    expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
      status: 'completed',
      output_text: '当前目录是 /Users/fanzhang/Documents/github/routecodex。',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: '当前目录是 /Users/fanzhang/Documents/github/routecodex。' }
          ]
        }
      ]
    }, {
      tools: {
        clientToolsRaw: [
          {
            type: 'function',
            function: { name: 'exec_command' }
          }
        ]
      },
      responses: {
        toolChoice: 'auto'
      },
      continuation: {
        toolContinuation: {
          mode: 'submit_tool_outputs',
          submittedToolCallIds: ['call_1']
        }
      },
      toolOutputs: [
        {
          tool_call_id: 'call_1',
          content: '/Users/fanzhang/Documents/github/routecodex\\n'
        }
      ],
      responses: {
        resume: {
          restoredFromResponseId: 'resp_submit_prev_1',
          toolOutputsDetailed: [
            {
              callId: 'call_1',
              outputText: '/Users/fanzhang/Documents/github/routecodex\\n'
            }
          ]
        }
      }
    })).toBeNull();

    expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
      status: 'completed',
      output_text: '',
      output: [
        {
          type: 'reasoning',
          summary: [
            {
              type: 'summary_text',
              text: 'I have all the information I need. Let me create the hook file now.'
            }
          ]
        }
      ]
    }, {
      tools: {
        clientToolsRaw: [
          {
            type: 'function',
            function: { name: 'exec_command' }
          }
        ]
      },
      responses: {
        toolChoice: 'required'
      },
      messages: [
        {
          role: 'user',
          content: '继续执行'
        }
      ]
    })).toMatchObject({
      marker: 'responses_missing_required_tool_call'
    });

    expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
      status: 'completed',
      output_text: '.',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: '.' }
          ]
        }
      ]
    })).toMatchObject({
      marker: 'responses_empty_output'
    });

    expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
      status: 'completed',
      output_text: '[reasoning.stop]\n用户任务目标: A\n是否完成: 是\n完成证据: B\n结束标记: [app.finished:reasoning.stop] {"tool":"reasoning.stop","completed":true}',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: '[reasoning.stop]\n用户任务目标: A\n是否完成: 是\n完成证据: B\n结束标记: [app.finished:reasoning.stop] {"tool":"reasoning.stop","completed":true}'
            }
          ]
        }
      ]
    }, {
      tools: {
        clientToolsRaw: [
          {
            type: 'function',
            function: { name: 'exec_command' }
          }
        ]
      },
      responses: {
        toolChoice: 'required'
      },
      messages: [
        {
          role: 'user',
          content: '继续执行'
        }
      ]
    })).toBeNull();

    expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              output_text: '[reasoning.stop]\n用户任务目标: A\n是否完成: 是\n完成证据: B\n结束标记: [app.finished:reasoning.stop] {"tool":"reasoning.stop","completed":true}'
            }
          ]
        }
      ]
    }, {
      tools: {
        clientToolsRaw: [
          {
            type: 'function',
            function: { name: 'exec_command' }
          }
        ]
      },
      messages: [
        {
          role: 'user',
          content: '继续执行'
        }
      ]
    })).toBeNull();

    expect(__requestExecutorTestables.bodyContainsReasoningStopFinalizedMarker({
      status: 'completed',
      metadata: {
        hidden: '[app.finished:reasoning.stop] {"tool":"reasoning.stop","completed":true}'
      },
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: '普通文本，没有结束标记'
            }
          ]
        }
      ]
    })).toBe(false);

    const longReason = 'x'.repeat(400);
    const truncated = __requestExecutorTestables.truncateReason(longReason, 50);
    expect(truncated.length).toBe(50);
    expect(truncated.endsWith('…')).toBe(true);

    const singleton429ExclusionPlan = __requestExecutorTestables.resolveProviderRetryExclusionPlan({
      providerKey: 'mimo.key1.mimo-v2.5-pro',
      status: 429,
      error: Object.assign(new Error('HTTP 429: overload'), { statusCode: 429 }),
      promptTooLong: false,
      isVerify: false,
      isReauth: false,
      routePool: ['mimo.key1.mimo-v2.5-pro'],
      excludedProviderKeys: new Set<string>()
    });
    expect(singleton429ExclusionPlan.excludedCurrentProvider).toBe(false);
    expect(__requestExecutorTestables.isLastAvailableProvider429({
      providerKey: 'mimo.key1.mimo-v2.5-pro',
      routePool: ['mimo.key1.mimo-v2.5-pro'],
      excludedProviderKeys: new Set<string>(),
      retryError: {
        statusCode: 429,
        errorCode: 'HTTP_429',
        reason: 'HTTP 429: overload'
      }
    })).toBe(true);

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
      shouldRetry: true,
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

    expect(__requestExecutorTestables.resolveRequestExecutorProviderErrorClassification({
      error: Object.assign(new Error('HTTP 404: {"detail":"Not Found"}'), {
        code: 'HTTP_404',
        statusCode: 404
      }),
      retryError: {
        statusCode: 404,
        errorCode: 'HTTP_404',
        upstreamCode: 'HTTP_404',
        reason: 'HTTP 404: {"detail":"Not Found"}'
      },
      stage: 'provider.send'
    })).toBe('unrecoverable');

    expect(__requestExecutorTestables.resolveRequestExecutorProviderErrorClassification({
      error: Object.assign(new Error('tool history contract violated'), {
        code: 'MALFORMED_REQUEST'
      }),
      retryError: {
        errorCode: 'MALFORMED_REQUEST',
        reason: 'tool history contract violated'
      },
      stage: 'provider.send'
    })).toBe('special_400');

    expect(__requestExecutorTestables.resolveRequestExecutorProviderErrorClassification({
      error: Object.assign(new Error('tool_call missing required id'), {
        code: 'MALFORMED_RESPONSE'
      }),
      retryError: {
        errorCode: 'MALFORMED_RESPONSE',
        reason: 'tool_call missing required id'
      },
      stage: 'provider.send'
    })).toBe('unrecoverable');

    expect(__requestExecutorTestables.resolveProviderRetryEligibilityPlan({
      error: Object.assign(new Error('tool history contract violated'), {
        code: 'MALFORMED_REQUEST'
      }),
      retryError: {
        errorCode: 'MALFORMED_REQUEST',
        reason: 'tool history contract violated'
      },
      attempt: 1,
      maxAttempts: 6,
      providerKey: 'mimo.key1.mimo-v2.5-pro'
    })).toEqual({
      shouldRetry: false,
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
    const previousRecoverableBase = process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS;
    const previousRecoverableMax = process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS;
    process.env.ROUTECODEX_429_BACKOFF_BASE_MS = '1';
    process.env.ROUTECODEX_429_BACKOFF_MAX_MS = '1';
    process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS = '1';
    process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS = '1';
    try {
      const orchestratorExcluded = new Set<string>();
      const recordAttempt = jest.fn();
      const executionPlan = await __requestExecutorTestables.resolveProviderRetryExecutionPlan({
        error: Object.assign(new Error('HTTP 429: overload'), { statusCode: 429, code: 'HTTP_429' }),
        retryError: { statusCode: 429, errorCode: 'HTTP_429', reason: 'HTTP 429: overload' },
        attempt: 1,
        maxAttempts: 6,
        providerKey: 'gemini.primary.gemini-2.5-pro',
        runtimeKey: 'runtime:gemini-primary',
        logicalRequestChainKey: 'req-helper',
        logicalChainRetryLimitStageRequestId: 'req-helper',
        routePool: [
          'gemini.primary.gemini-2.5-pro',
          'gemini.backup.gemini-2.5-pro'
        ],
        runtimeManager: {
          resolveRuntimeKey: () => 'runtime:gemini-primary'
        },
        excludedProviderKeys: orchestratorExcluded,
        recordAttempt,
        logStage: () => undefined,
        promptTooLong: false,
        isVerify: false,
        isReauth: false,
        status: 429
      });
      expect(recordAttempt).toHaveBeenCalledWith({ error: true });
      expect(executionPlan.shouldRetry).toBe(true);
      expect(executionPlan.backoffScope).toBe('recoverable');
      expect(executionPlan.retrySwitchPlan).toEqual(expect.objectContaining({
        switchAction: 'retry_same_provider',
        decisionLabel: 'recoverable_backoff_same_provider'
      }));
      expect(Array.from(orchestratorExcluded)).toEqual([]);

      const telemetryPlan = __requestExecutorTestables.buildProviderRetryTelemetryPlan({
        requestId: 'req-helper',
        attempt: 1,
        maxAttempts: 6,
        providerKey: 'gemini.primary.gemini-2.5-pro',
        retryError: { statusCode: 429, errorCode: 'HTTP_429', reason: 'HTTP 429: overload' },
        excludedProviderKeys: orchestratorExcluded,
        routeHint: 'thinking',
        retryExecutionPlan: executionPlan,
        stage: 'provider.send',
        runtimeKey: 'runtime:gemini-primary'
      });
      expect(telemetryPlan.switchLogArgs).toEqual(expect.objectContaining({
        requestId: 'req-helper',
        switchAction: 'retry_same_provider',
        backoffScope: 'recoverable',
        decisionLabel: 'recoverable_backoff_same_provider',
        stage: 'provider.send'
      }));
      expect(telemetryPlan.retryStageDetails).toEqual(expect.objectContaining({
        providerKey: 'gemini.primary.gemini-2.5-pro',
        routeHint: 'thinking',
        switchAction: 'retry_same_provider',
        backoffScope: 'recoverable',
        decisionLabel: 'recoverable_backoff_same_provider'
      }));

      const networkExcluded = new Set<string>();
      const networkExecutionPlan = await __requestExecutorTestables.resolveProviderRetryExecutionPlan({
        error: Object.assign(new Error('fetch failed'), {
          code: 'HTTP_502',
          statusCode: 502
        }),
        retryError: {
          statusCode: 502,
          errorCode: 'HTTP_502',
          reason: 'fetch failed'
        },
        attempt: 1,
        maxAttempts: 6,
        providerKey: 'deepseek.key1.deepseek-v4-pro',
        runtimeKey: 'runtime:deepseek',
        logicalRequestChainKey: 'req-network-fetch-failed',
        logicalChainRetryLimitStageRequestId: 'req-network-fetch-failed',
        routePool: [
          'deepseek.key1.deepseek-v4-pro',
          'deepseek.key2.deepseek-v4-pro'
        ],
        runtimeManager: {
          resolveRuntimeKey: () => 'runtime:deepseek'
        },
        excludedProviderKeys: networkExcluded,
        recordAttempt,
        logStage: () => undefined,
        status: 502
      });
      expect(networkExecutionPlan).toEqual(expect.objectContaining({
        shouldRetry: true,
        excludedCurrentProvider: false,
        retrySwitchPlan: expect.objectContaining({
          switchAction: 'retry_same_provider',
          decisionLabel: 'recoverable_backoff_same_provider'
        })
      }));
      expect(Array.from(networkExcluded)).toEqual([]);


      const notFoundExcluded = new Set<string>();
      const notFoundExecutionPlan = await __requestExecutorTestables.resolveProviderRetryExecutionPlan({
        error: Object.assign(new Error('HTTP 404: {"detail":"Not Found"}'), {
          code: 'HTTP_404',
          statusCode: 404
        }),
        retryError: {
          statusCode: 404,
          errorCode: 'HTTP_404',
          upstreamCode: 'HTTP_404',
          reason: 'HTTP 404: {"detail":"Not Found"}'
        },
        attempt: 1,
        maxAttempts: 6,
        providerKey: 'mimo.key1.mimo-v2.5-pro',
        runtimeKey: 'runtime:mimo',
        logicalRequestChainKey: 'req-http-404',
        logicalChainRetryLimitStageRequestId: 'req-http-404',
        routePool: [
          'mimo.key1.mimo-v2.5-pro',
          'whitedrem.key1.deepseek-v4-pro'
        ],
        runtimeManager: {
          resolveRuntimeKey: () => 'runtime:mimo'
        },
        excludedProviderKeys: notFoundExcluded,
        recordAttempt,
        logStage: () => undefined,
        status: 404
      });
      expect(notFoundExecutionPlan).toEqual({
        shouldRetry: false,
        blockingRecoverable: false,
        excludedCurrentProvider: false,
        holdOnLastAvailable429: false,
        retryBackoffMs: 0,
        recoverableBackoffMs: 0,
        });

      const sqliteBusyExcluded = new Set<string>();
      const sqliteBusyExecutionPlan = await __requestExecutorTestables.resolveProviderRetryExecutionPlan({
        error: Object.assign(new Error('database is locked (5) (SQLITE_BUSY)'), {
          code: 'new_api_error',
          upstreamCode: 'new_api_error',
          statusCode: 500,
          retryable: true
        }),
        retryError: {
          statusCode: 500,
          errorCode: 'new_api_error',
          upstreamCode: 'new_api_error',
          reason: 'database is locked (5) (SQLITE_BUSY)'
        },
        attempt: 1,
        maxAttempts: 6,
        providerKey: 'deepseek.key1.deepseek-v4-pro',
        runtimeKey: 'runtime:deepseek',
        logicalRequestChainKey: 'req-sqlite-busy',
        logicalChainRetryLimitStageRequestId: 'req-sqlite-busy',
        routePool: [
          'deepseek.key1.deepseek-v4-pro',
          'deepseek.key2.deepseek-v4-pro'
        ],
        runtimeManager: {
          resolveRuntimeKey: () => 'runtime:deepseek'
        },
        excludedProviderKeys: sqliteBusyExcluded,
        recordAttempt,
        logStage: () => undefined,
        status: 500
      });
      expect(sqliteBusyExecutionPlan).toEqual(expect.objectContaining({
        shouldRetry: true,
        blockingRecoverable: true,
        excludedCurrentProvider: false,
        backoffScope: 'recoverable',
        retrySwitchPlan: expect.objectContaining({
          switchAction: 'retry_same_provider',
          decisionLabel: 'recoverable_backoff_same_provider'
        })
      }));
      expect(Array.from(sqliteBusyExcluded)).toEqual([]);

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
        status: 401
      });
      expect(followupExecutionPlan).toEqual({
        shouldRetry: false,
        blockingRecoverable: false,
        excludedCurrentProvider: false,
        holdOnLastAvailable429: false,
        retryBackoffMs: 0,
        recoverableBackoffMs: 0,
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
      if (previousRecoverableBase === undefined) {
        delete process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS;
      } else {
        process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS = previousRecoverableBase;
      }
      if (previousRecoverableMax === undefined) {
        delete process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS;
      } else {
        process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS = previousRecoverableMax;
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

  test('waits for recoverable cooldown hint from concurrency.busy when route pool has only one provider', async () => {
    const providerKey = 'mimo.key1.mimo-v2.5-pro';
    const handle = buildHandle(providerKey, async () => ({ status: 200, data: { id: 'ok-after-concurrency-wait' } }));

    const runtimeManager = {
      resolveRuntimeKey: (key: string) => key,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? (runtimeKey === providerKey ? handle : undefined) : undefined)
    };

    const pipeline = {
      execute: jest.fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('No available providers after applying routing instructions'), {
            code: 'PROVIDER_NOT_AVAILABLE',
            details: {
              routeName: 'thinking',
              attempted: ['thinking:thinking-mimo-primary:health'],
              recoverableCooldownHints: [
                { providerKey, waitMs: 120, source: 'concurrency.busy' }
              ]
            }
          })
        )
        .mockResolvedValueOnce({
          requestId: 'req-singleton-concurrency-wait',
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'openai',
            outboundProfile: 'openai-chat',
            runtimeKey: providerKey
          },
          routingDecision: { routeName: 'thinking', pool: [providerKey] },
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
    jest.spyOn(executor as any, 'convertProviderResponseIfNeeded').mockResolvedValue({
      status: 200,
      body: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'ok'
            }
          }
        ]
      }
    });
    const startedAt = Date.now();
    const result = await executor.execute({
      requestId: 'req-singleton-concurrency-wait',
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
        (call) =>
          call[0] === 'provider.route_pool_cooldown_wait'
          && typeof call[2]?.waitMs === 'number'
          && call[2]?.reason === 'provider_pool_cooling_down'
      )
    ).toBe(true);
  });

  test('keeps blocking beyond the generic pool cooldown budget for a singleton recoverable pool', async () => {
    jest.useFakeTimers();
    const providerKey = 'dbittai.key1.MiniMax-M2.7';
    const handle = buildHandle(providerKey, async () => ({ status: 200, data: { id: 'ok-after-long-singleton-wait' } }));

    const runtimeManager = {
      resolveRuntimeKey: (key: string) => key,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? (runtimeKey === providerKey ? handle : undefined) : undefined)
    };

    let calls = 0;
    const pipeline = {
      execute: jest.fn(async () => {
        calls += 1;
        if (calls <= 61) {
          throw Object.assign(new Error('No available providers after applying routing instructions'), {
            code: 'PROVIDER_NOT_AVAILABLE',
            details: {
              routeName: 'coding',
              minRecoverableCooldownMs: 1000,
              candidateProviderCount: 1,
              recoverableCooldownHints: [
                { providerKey, waitMs: 1000, source: 'concurrency.busy' }
              ]
            }
          });
        }
        return {
          requestId: 'req-singleton-cooldown-budget',
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'anthropic',
            outboundProfile: 'anthropic-messages',
            runtimeKey: providerKey
          },
          routingDecision: { routeName: 'coding', pool: [providerKey] },
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
    jest.spyOn(executor as any, 'convertProviderResponseIfNeeded').mockResolvedValue({
      status: 200,
      body: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'ok'
            }
          }
        ]
      }
    });

    try {
      const execution = executor.execute({
        requestId: 'req-singleton-cooldown-budget',
        entryEndpoint: '/v1/responses',
        body: {},
        headers: {},
        metadata: {}
      });
      await jest.advanceTimersByTimeAsync(61_500);
      const result = await execution;

      expect(result).toEqual(expect.objectContaining({ status: 200 }));
      expect(pipeline.execute).toHaveBeenCalledTimes(62);
      expect(
        logStage.mock.calls.some(
          (call) =>
            call[0] === 'provider.route_pool_cooldown_wait'
            && call[2]?.reason === 'single_provider_pool_recoverable'
        )
      ).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });


  test('keeps recoverable 429 on the same provider even when an alternative provider exists', async () => {
    const firstProviderKey = 'gemini.primary.gemini-2.5-pro';
    const secondProviderKey = 'gemini.backup.gemini-2.5-flash';
    const failingError = new Error('HTTP 429: quota exhausted');
    (failingError as any).statusCode = 429;

    const failingProcess = jest.fn()
      .mockRejectedValueOnce(failingError)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          id: 'ok_after_same_provider_wait',
          status: 'completed',
          output_text: 'ok',
          output: [{ type: 'output_text', text: 'ok' }]
        }
      });
    const failureHandle = buildHandle(firstProviderKey, failingProcess);
    const successPayload = {
      status: 200,
      data: {
        id: 'ok',
        status: 'completed',
        output_text: 'ok',
        output: [{ type: 'output_text', text: 'ok' }]
      }
    };
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
          routingDecision: {
            routeName: 'thinking',
            pool: [firstProviderKey, secondProviderKey]
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
    jest.spyOn(executor as any, 'convertProviderResponseIfNeeded').mockResolvedValue({
      status: 200,
      body: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'ok'
            }
          }
        ]
      }
    });
    const result = await executor.execute({
      requestId: 'req-retry',
      entryEndpoint: '/v1/chat/completions',
      body: {},
      headers: {},
      metadata: {}
    });

    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    expect(failingProcess).toHaveBeenCalledTimes(2);
    expect(successProcess).toHaveBeenCalledTimes(0);
    expect(result).toEqual(expect.objectContaining({ status: 200 }));

    const secondCallMetadata = pipeline.execute.mock.calls[1][0].metadata as Record<string, unknown>;
    expect(secondCallMetadata.excludedProviderKeys).toBeUndefined();
  });

  test('prints retry switch reason and error code to console on same-provider recoverable backoff', async () => {
    const firstProviderKey = 'crs.key2.gpt-5.3-codex';
    const secondProviderKey = 'crs.key1.gpt-5.3-codex';
    const failingError = new Error('Upstream SSE parser terminated');
    (failingError as any).statusCode = 429;
    (failingError as any).code = 'SSE_TO_JSON_ERROR';
    (failingError as any).upstreamCode = 'rate_limit_error';

    const failingProcess = jest.fn()
      .mockRejectedValueOnce(failingError)
      .mockResolvedValueOnce({ status: 200, data: { id: 'ok-after-retry' } });
    const failureHandle = buildHandle(firstProviderKey, failingProcess);
    const successProcess = jest.fn(async () => ({ status: 200, data: { id: 'unused-fallback' } }));
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
      execute: jest.fn(async (input: any) => ({
        requestId: input.id,
        providerPayload: {},
        target: {
          providerKey: firstProviderKey,
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey: firstProviderKey
        },
        routingDecision: {
          routeName: 'longcontext',
          pool: [firstProviderKey, secondProviderKey]
        },
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
      expect(failingProcess).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[provider-switch]'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('status=429'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('code=SSE_TO_JSON_ERROR'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('upstreamCode=rate_limit_error'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('switch=retry_same_provider'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('decision=recoverable_backoff_same_provider'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('backoffScope=recoverable'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('provider=crs.key2.gpt-5.3-codex'));
      expect(successProcess).toHaveBeenCalledTimes(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('prints compact aggregated provider-switch logs without dedupe key payload', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
    const nowSpy = jest.spyOn(Date, 'now');
    try {
      let nowCall = 0;
      nowSpy.mockImplementation(() => {
        nowCall += 1;
        if (nowCall <= 1) {
          return 0;
        }
        if (nowCall === 2) {
          return 1_000;
        }
        if (nowCall === 3) {
          return 1_500;
        }
        return 7_000;
      });
      const executor = createRequestExecutor({
        runtimeManager: undefined as any,
        getHubPipeline: undefined as any,
        getModuleDependencies: undefined as any,
        logStage: jest.fn(),
        stats: new StatsManager()
      });
      const logger = (executor as any).logProviderRetrySwitch.bind(executor);
      logger({
        requestId: 'req-agg-1',
        attempt: 1,
        maxAttempts: 6,
        providerKey: 'mimo.key1.mimo-v2.5-pro',
        nextAttempt: 2,
        reason: 'HTTP 504: <!DOCTYPE html><html><body>gateway timeout</body></html>',
        backoffMs: 1000,
        statusCode: 504,
        errorCode: 'HTTP_504',
        upstreamCode: 'HTTP_504',
        switchAction: 'retry_same_provider',
        backoffScope: 'recoverable',
        decisionLabel: 'recoverable_backoff_same_provider',
        stage: 'provider.send'
      });
      logger({
        requestId: 'req-agg-2',
        attempt: 1,
        maxAttempts: 6,
        providerKey: 'mimo.key1.mimo-v2.5-pro',
        nextAttempt: 2,
        reason: 'HTTP 504: <!DOCTYPE html><html><body>gateway timeout again</body></html>',
        backoffMs: 1000,
        statusCode: 504,
        errorCode: 'HTTP_504',
        upstreamCode: 'HTTP_504',
        switchAction: 'retry_same_provider',
        backoffScope: 'recoverable',
        decisionLabel: 'recoverable_backoff_same_provider',
        stage: 'provider.send'
      });
      const lines = warnSpy.mock.calls.map((call) => String(call[0] ?? ''));
      expect(lines.some((line) => line.includes('[provider-switch] aggregated'))).toBe(false);
      logger({
        requestId: 'req-agg-3',
        attempt: 1,
        maxAttempts: 6,
        providerKey: 'mimo.key1.mimo-v2.5-pro',
        nextAttempt: 2,
        reason: 'HTTP 504: <!DOCTYPE html><html><body>gateway timeout final</body></html>',
        backoffMs: 1000,
        statusCode: 504,
        errorCode: 'HTTP_504',
        upstreamCode: 'HTTP_504',
        switchAction: 'retry_same_provider',
        backoffScope: 'recoverable',
        decisionLabel: 'recoverable_backoff_same_provider',
        stage: 'provider.send'
      });
      const finalLines = warnSpy.mock.calls.map((call) => String(call[0] ?? ''));
      const aggregated = finalLines.find((line) => line.includes('[provider-switch] aggregated'));
      expect(aggregated).toBeDefined();
      expect(aggregated).toContain('provider=mimo.key1.mimo-v2.5-pro');
      expect(aggregated).toContain('status=504');
      expect(aggregated).toContain('code=HTTP_504');
      expect(aggregated).toContain('upstreamCode=HTTP_504');
      expect(aggregated).toContain('suppressed=1');
      expect(aggregated).not.toContain('aggregated key=');
      expect(aggregated).not.toContain('<!DOCTYPE html>');
    } finally {
      nowSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test('keeps 429 on same provider even when route pool exposes an alternative provider', async () => {
    const firstProviderKey = 'tabglm.key1.glm-5.1';
    const secondProviderKey = 'crs.key2.gpt-5.3-codex';
    const failingError = Object.assign(new Error('HTTP 429: model overloaded'), {
      statusCode: 429,
      retryable: true
    });

    const failingProcess = jest.fn()
      .mockRejectedValueOnce(failingError)
      .mockResolvedValueOnce({ status: 200, data: { id: 'ok-after-retry' } });
    const failureHandle = buildHandle(firstProviderKey, failingProcess);
    const successProcess = jest.fn(async () => ({ status: 200, data: { id: 'unused-fallback' } }));
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
          routingDecision: {
            routeName: 'thinking',
            pool: [firstProviderKey, secondProviderKey]
          },
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
      expect(failingProcess).toHaveBeenCalledTimes(2);
      expect(successProcess).toHaveBeenCalledTimes(0);
      expect(
        logStage.mock.calls.some(
          (call) =>
            call[0] === 'provider.retry' &&
            call[2]?.switchAction === 'retry_same_provider' &&
            Array.isArray(call[2]?.excluded) &&
            call[2]?.excluded.length === 0
        )
      ).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('switch=retry_same_provider'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('decision=recoverable_backoff_same_provider'));
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
    jest.spyOn(executor as any, 'convertProviderResponseIfNeeded').mockResolvedValue({
      status: 200,
      body: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'ok'
            }
          }
        ]
      }
    });
    const result = await executor.execute({
      requestId: 'req-context-overflow',
      entryEndpoint: '/v1/chat/completions',
      body: {},
      headers: {},
      metadata: {}
    });

    expect(result).toEqual(expect.objectContaining({ status: 200 }));
    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    expect(routeHints[0]).not.toBe('longcontext');
    expect(routeHints[1]).toBe('longcontext');
  });

  test('surfaces 403 OAuth reauth-required error without alias rotation', async () => {
    const firstProviderKey = 'gemini.primary.gemini-2.5-pro';
    const secondProviderKey = 'gemini.backup.gemini-2.5-pro';
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
    await expect(executor.execute({
      requestId: 'req-403-reauth',
      entryEndpoint: '/v1/responses',
      body: {},
      headers: {},
      metadata: {}
    })).rejects.toMatchObject({
      message: 'HTTP 403: Please authenticate with Google OAuth first',
      statusCode: 403
    });

    expect(pipeline.execute).toHaveBeenCalledTimes(1);
    expect(failingProcess).toHaveBeenCalledTimes(1);
    expect(successProcess).toHaveBeenCalledTimes(0);
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
    // HTTP 429 in priority/single-provider path should not force provider exclusion.
    expect(secondCallMetadata.excludedProviderKeys).toBeUndefined();
  });
  test('keeps blocking on singleton 429 when reroute temporarily reports provider unavailable', async () => {
    const firstProviderKey = 'glm.key1.glm-4.7';
    const firstError = Object.assign(new Error('HTTP 429: quota exhausted'), {
      statusCode: 429,
      code: 'HTTP_429'
    });

    const failingProcess = jest.fn()
      .mockRejectedValueOnce(firstError)
      .mockResolvedValueOnce({ status: 200, data: { id: 'ok-after-blocking-hold' } });
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
        )
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
        }),
      updateVirtualRouterConfig: jest.fn()
    };

    const previous429Base = process.env.ROUTECODEX_429_BACKOFF_BASE_MS;
    const previous429Max = process.env.ROUTECODEX_429_BACKOFF_MAX_MS;
    process.env.ROUTECODEX_429_BACKOFF_BASE_MS = '1';
    process.env.ROUTECODEX_429_BACKOFF_MAX_MS = '1';

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
    try {
      const result = await executor.execute({
        requestId: 'req-single-pool-unavailable',
        entryEndpoint: '/v1/chat/completions',
        body: {},
        headers: {},
        metadata: {}
      });

      expect(result).toEqual(expect.objectContaining({ status: 200 }));
      expect(pipeline.execute).toHaveBeenCalledTimes(3);
      expect(failingProcess).toHaveBeenCalledTimes(2);
      const secondCallMetadata = pipeline.execute.mock.calls[1][0].metadata as Record<string, unknown>;
      expect(secondCallMetadata.excludedProviderKeys).toBeUndefined();
      expect(
        deps.logStage.mock.calls.some(
          (call: unknown[]) =>
            call[0] === 'provider.route_pool_cooldown_wait'
            && call[2]?.holdOnLastAvailable429 === true
            && call[2]?.reason === 'last_available_provider_429'
        )
      ).toBe(true);
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

  test('holds on same provider 429 when route pool exposes no alternative candidate', async () => {
    const primaryProviderKey = 'glm.key1.glm-4.7';
    const fallbackProviderKey = 'qwen.key2.qwen3.5-27b';
    const firstError = Object.assign(new Error('HTTP 429: quota exhausted'), {
      statusCode: 429,
      code: 'HTTP_429'
    });

    let primaryAttempt = 0;
    const primaryProcess = jest.fn(async () => {
      primaryAttempt += 1;
      if (primaryAttempt === 1) {
        throw firstError;
      }
      return {
        status: 200,
        data: { id: 'ok_after_same_provider_backoff' }
      };
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
    expect(primaryProcess).toHaveBeenCalledTimes(2);
    expect(fallbackProcess).toHaveBeenCalledTimes(0);

    const secondCallMetadata = pipeline.execute.mock.calls[1][0].metadata as Record<string, unknown>;
    expect(secondCallMetadata.excludedProviderKeys).toBeUndefined();
  });

  test('does not exclude provider on repeated 429 even when route pool has another candidate', async () => {
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
    const processA = jest.fn()
      .mockRejectedValueOnce(error429A)
      .mockResolvedValueOnce({ status: 200, data: { id: 'ok_after_same_provider_wait' } });
    const processB = jest.fn(async () => {
      throw error429B;
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
      expect(pipeline.execute).toHaveBeenCalledTimes(2);
      expect(processA).toHaveBeenCalledTimes(2);
      expect(processB).toHaveBeenCalledTimes(0);

      const secondCallMetadata = pipeline.execute.mock.calls[1][0].metadata as Record<string, unknown>;
      expect(secondCallMetadata.excludedProviderKeys).toBeUndefined();
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

  test('keeps generic recoverable 500 on same provider with blocking backoff', async () => {
    const providerA = 'tabglm.key1.glm-5.1';
    const providerB = 'crs.key2.gpt-5.3-codex';
    const providerC = 'ali-coding-plan.key1.qwen3.6-plus';
    const authErrorA = Object.assign(new Error('HTTP 500: provider A overloaded'), {
      statusCode: 500
    });
    const processA = jest.fn()
      .mockRejectedValueOnce(authErrorA)
      .mockResolvedValueOnce({ status: 200, data: { id: 'ok_after_same_provider_backoff' } });
    const processB = jest.fn(async () => ({ status: 200, data: { id: 'unused_provider_b' } }));
    const processC = jest.fn(async () => ({ status: 200, data: { id: 'unused_provider_c' } }));

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
        .mockResolvedValue({ status: 200, body: { output_text: 'ok_after_same_provider_backoff' } });

      const result = await executor.execute({
        requestId: 'req-same-provider-500-backoff',
        entryEndpoint: '/v1/responses',
        body: {},
        headers: {},
        metadata: {}
      });

      expect(result).toEqual(expect.objectContaining({ status: 200 }));
      const switchLines = warnSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((line) => line.includes('[provider-switch]'));
      expect(switchLines).toHaveLength(1);
      expect(switchLines[0]).toContain(`provider=${providerA}`);
      expect(switchLines[0]).toMatch(/backoff=\d+ms/);
      expect(switchLines[0]).toContain('backoffScope=recoverable');
      expect(switchLines[0]).toContain('decision=recoverable_backoff_same_provider');
      expect(processB).toHaveBeenCalledTimes(0);
      expect(processC).toHaveBeenCalledTimes(0);
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

  test('retries same provider when upstream SSE error event is retryable network failure', async () => {
    const firstProviderKey = 'deepseek-web.primary.deepseek-chat';
    const secondProviderKey = 'deepseek-web.backup.deepseek-chat';

    const failingProcess = jest.fn()
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({ status: 200, data: { id: 'resp_ok' } });
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
      execute: jest.fn(async (input: any) => ({
        requestId: input.id,
        providerPayload: {},
        target: {
          providerKey: firstProviderKey,
          providerType: 'openai',
          outboundProfile: 'openai-chat',
          runtimeKey: firstProviderKey
        },
        routingDecision: {
          routeName: 'deepseek',
          pool: [firstProviderKey, secondProviderKey]
        },
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
    const result = await executor.execute({
      requestId: 'req-sse-network-retry',
      entryEndpoint: '/v1/messages',
      body: {},
      headers: {},
      metadata: {}
    });

    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    expect(failingProcess).toHaveBeenCalledTimes(2);
    expect(successProcess).toHaveBeenCalledTimes(0);
    const secondCallMetadata = pipeline.execute.mock.calls[1][0].metadata as Record<string, unknown>;
    expect(secondCallMetadata.excludedProviderKeys).toBeUndefined();
    expect(result).toEqual(expect.objectContaining({ status: 200 }));
  });

  test('surfaces converted HTTP 401 without provider failover', async () => {
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
    await expect(executor.execute({
      requestId: 'req-401-failover',
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
    expect(successProcess).toHaveBeenCalledTimes(0);
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

  test('blocking recoverable retries ignore logical-chain caps and keep waiting until success', async () => {
    const providerA = 'storm.a.glm-5';
    const retryable429 = () => Object.assign(new Error('HTTP 429: rate limited'), {
      statusCode: 429,
      code: 'HTTP_429'
    });
    let failuresLeft = 2;
    const processIncoming = jest.fn(async () => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw retryable429();
      }
      return {
        status: 200,
        body: {
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }]
        }
      };
    });

    const handles = new Map<string, ProviderHandle>([
      [providerA, buildHandle(providerA, processIncoming)]
    ]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pool = [providerA];
    const pipeline = {
      execute: jest.fn(async (input: any) => ({
        requestId: input.id,
        providerPayload: {},
        target: {
          providerKey: providerA,
          providerType: 'openai',
          outboundProfile: 'openai-chat',
          runtimeKey: providerA
        },
        routingDecision: { routeName: 'default', pool },
        metadata: {}
      })),
      updateVirtualRouterConfig: jest.fn()
    };

    const previousLimit = process.env.ROUTECODEX_LOGICAL_CHAIN_RECOVERABLE_RETRY_LIMIT;
    const previousBase = process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS;
    const previousMax = process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS;
    process.env.ROUTECODEX_LOGICAL_CHAIN_RECOVERABLE_RETRY_LIMIT = '1';
    process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS = '1';
    process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS = '1';

    try {
      const logStage = jest.fn();
      const executor = createRequestExecutor({
        runtimeManager,
        getHubPipeline: () => pipeline,
        getModuleDependencies: () => ({
          errorHandlingCenter: {
            handleError: jest.fn(async () => undefined)
          }
        }),
        logStage,
        stats: new StatsManager()
      });
      jest.spyOn(executor as any, 'convertProviderResponseIfNeeded').mockResolvedValue({
        status: 200,
        body: {
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }]
        }
      });

      const result = await executor.execute({
        requestId: 'req-storm-root:reasoning_stop_guard',
        entryEndpoint: '/v1/responses',
        body: {},
        headers: {},
        metadata: {}
      });

      expect(result.status).toBe(200);
      expect(pipeline.execute).toHaveBeenCalledTimes(3);
      expect(
        logStage.mock.calls.some((call) => call[0] === 'provider.retry.logical_chain_limit_hit')
      ).toBe(false);
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

  test('blocking recoverable retries can exceed maxAttempts without overflowing next-attempt logs', async () => {
    const providerA = 'storm.fetch.a';
    let failuresLeft = 2;
    const processIncoming = jest.fn(async () => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw Object.assign(new Error('fetch failed'), {
          code: 'HTTP_502',
          statusCode: 502
        });
      }
      return {
        status: 200,
        body: {
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }]
        }
      };
    });
    const handles = new Map<string, ProviderHandle>([
      [providerA, buildHandle(providerA, processIncoming)]
    ]);

    const pool = [providerA];
    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => ({
        requestId: input.id,
        providerPayload: {},
        target: {
          providerKey: providerA,
          providerType: 'openai',
          outboundProfile: 'openai-responses',
          runtimeKey: providerA
        },
        routingDecision: { routeName: 'tools', pool },
        metadata: {}
      })),
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
      jest.spyOn(executor as any, 'convertProviderResponseIfNeeded').mockResolvedValue({
        status: 200,
        body: {
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }]
        }
      });

      const result = await executor.execute({
        requestId: 'req-fetch-failed-cap',
        entryEndpoint: '/v1/responses',
        body: {},
        headers: {},
        metadata: {}
      });

      expect(result.status).toBe(200);
      expect(pipeline.execute).toHaveBeenCalledTimes(3);
      const switchLines = warnSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((line) => line.includes('[provider-switch]'));
      expect(switchLines.length).toBeGreaterThan(0);
      expect(switchLines.some((line) => line.includes('3/2'))).toBe(false);
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

      __requestExecutorTestables.clearRecoverableErrorBackoffForProvider({
        providerKey: 'tabglm.key1.glm-5.1'
      });
      const delayAAfterSuccess = __requestExecutorTestables.consumeRecoverableErrorBackoffMs(keyA, {
        statusCode: 502,
        errorCode: 'HTTP_502',
        reason: 'fetch failed'
      });
      expect(delayAAfterSuccess).toBe(1000);
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

  test('keeps 429 recoverable backoff key stable across reason/code variants for same provider', () => {
    const providerKey = 'sdfv.key1.gpt-5.4';
    const keyA = __requestExecutorTestables.buildRecoverableErrorBackoffKey({
      providerKey,
      statusCode: 429,
      errorCode: 'HTTP_429_2056',
      upstreamCode: 'HTTP_429_2056',
      reason: 'rate limited 2056'
    });
    const keyB = __requestExecutorTestables.buildRecoverableErrorBackoffKey({
      providerKey,
      statusCode: 429,
      errorCode: 'HTTP_429',
      upstreamCode: 'WINDSURF_RATE_LIMITED',
      reason: 'temporarily rate limited'
    });

    expect(keyA).toBe(keyB);
    expect(keyA).toContain('status:429');
  });

  test('rejects when recoverable backoff waiter queue is overloaded', async () => {
    const providerKey = 'ali-coding-plan.key1.glm-5';
    const processIncoming = jest.fn(async () => {
      throw Object.assign(new Error('HTTP 429: Too many requests'), {
        statusCode: 429,
        code: 'HTTP_429',
        retryable: true
      });
    });

    const handle = buildHandle(providerKey, processIncoming);
    const recoverableBackoffKey = __requestExecutorTestables.buildRecoverableErrorBackoffKey({
      providerKey,
      runtimeKey: providerKey,
      statusCode: 429,
      errorCode: 'HTTP_429',
      reason: 'HTTP 429: Too many requests'
    });
    const runtimeManager = {
      resolveRuntimeKey: (key: string) => key,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey === providerKey ? handle : undefined)
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => ({
        requestId: input.id,
        providerPayload: {},
        processMode: 'passthrough',
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
    const previous429Base = process.env.ROUTECODEX_429_BACKOFF_BASE_MS;
    const previous429Max = process.env.ROUTECODEX_429_BACKOFF_MAX_MS;
    const previousBase = process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS;
    const previousMax = process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS;
    const previousServerToolState = getServerToolRuntimeState();
    process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_WAITERS = '1';
    process.env.ROUTECODEX_429_BACKOFF_BASE_MS = '500';
    process.env.ROUTECODEX_429_BACKOFF_MAX_MS = '500';
    process.env.ROUTECODEX_RECOVERABLE_BACKOFF_BASE_MS = '500';
    process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_MS = '500';
    setServerToolEnabled(false, 'request-executor.spec overload');

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
      __requestExecutorTestables.acquireRecoverableRetryWaiterSlotForTests(recoverableBackoffKey);
      const blocked = executor.execute({
        requestId: 'req-recoverable-overload-2',
        entryEndpoint: '/v1/responses',
        body: {},
        headers: {},
        metadata: {}
      });

      await expect(blocked).rejects.toMatchObject({
        statusCode: 429,
        code: 'PROVIDER_TRAFFIC_SATURATED',
        details: expect.objectContaining({
          reason: 'recoverable_waiter_overload'
        })
      });
      expect(processIncoming).toHaveBeenCalledTimes(1);
    } finally {
      __requestExecutorTestables.releaseRecoverableRetryWaiterSlotForTests(recoverableBackoffKey);
      if (previousWaiters === undefined) {
        delete process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_WAITERS;
      } else {
        process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_WAITERS = previousWaiters;
      }
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
      setServerToolEnabled(previousServerToolState.enabled, previousServerToolState.updatedBy);
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

  test('shares storm backoff across sessions through workdir scope for client tool args invalid storms', () => {
    process.env.ROUTECODEX_SESSION_STORM_BACKOFF_BASE_MS = '1000';
    process.env.ROUTECODEX_SESSION_STORM_BACKOFF_MAX_MS = '30000';

    const scopes = __requestExecutorTestables.resolveSessionStormBackoffScopes({
      sessionId: 'session-a',
      conversationId: 'conv-a',
      clientWorkdir: '/tmp/rc-workdir'
    });
    expect(scopes).toEqual([
      'session:session-a',
      'conversation:conv-a',
      'workdir:/tmp/rc-workdir'
    ]);

    const err = Object.assign(new Error('Converted provider tool call has invalid client arguments'), {
      code: 'CLIENT_TOOL_ARGS_INVALID',
      upstreamCode: 'CLIENT_TOOL_ARGS_INVALID',
      statusCode: 502
    });
    expect(__requestExecutorTestables.isSessionStormBackoffCandidate(err)).toBe(true);
    expect(__requestExecutorTestables.consumeSessionStormBackoffMs('workdir:/tmp/rc-workdir', err)).toBe(1000);
    expect(__requestExecutorTestables.peekSessionStormBackoffWaitMs('workdir:/tmp/rc-workdir')).toBe(1000);
    expect(__requestExecutorTestables.buildSessionStormHardBlockError('workdir:/tmp/rc-workdir')).toMatchObject({
      code: 'CLIENT_TOOL_ARGS_BLOCKED',
      upstreamCode: 'CLIENT_TOOL_ARGS_INVALID',
      statusCode: 429,
      retryable: false
    });

    jest.setSystemTime(new Date('2026-04-22T12:00:01.000Z'));
    expect(__requestExecutorTestables.peekSessionStormBackoffWaitMs('workdir:/tmp/rc-workdir')).toBe(0);
    expect(__requestExecutorTestables.buildSessionStormHardBlockError('workdir:/tmp/rc-workdir')).toBeUndefined();
  });

  test('treats deterministic malformed response contract errors as storm candidates and caps wait', () => {
    process.env.ROUTECODEX_SESSION_STORM_BACKOFF_BASE_MS = '1000';
    process.env.ROUTECODEX_SESSION_STORM_BACKOFF_MAX_MS = '30000';

    const err = Object.assign(
      new Error('[hub_response] Non-canonical response payload at chat_process.response.entry'),
      { code: 'MALFORMED_RESPONSE' }
    );
    expect(__requestExecutorTestables.isSessionStormBackoffCandidate(err)).toBe(true);

    expect(__requestExecutorTestables.consumeSessionStormBackoffMs('workdir:/tmp/malformed', err)).toBe(1000);
    jest.setSystemTime(new Date('2026-04-22T12:00:01.000Z'));
    expect(__requestExecutorTestables.consumeSessionStormBackoffMs('workdir:/tmp/malformed', err)).toBe(2000);
    jest.setSystemTime(new Date('2026-04-22T12:00:03.000Z'));
    expect(__requestExecutorTestables.consumeSessionStormBackoffMs('workdir:/tmp/malformed', err)).toBe(4000);
    jest.setSystemTime(new Date('2026-04-22T12:00:07.000Z'));
    expect(__requestExecutorTestables.consumeSessionStormBackoffMs('workdir:/tmp/malformed', err)).toBe(5000);
  });

});

describe('HubRequestExecutor provider transport backoff', () => {
  beforeEach(() => {
    __requestExecutorTestables.resetRequestExecutorInternalStateForTests();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-22T13:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.ROUTECODEX_429_BACKOFF_BASE_MS;
    delete process.env.RCC_429_BACKOFF_BASE_MS;
    delete process.env.ROUTECODEX_429_BACKOFF_MAX_MS;
    delete process.env.RCC_429_BACKOFF_MAX_MS;
  });

  test('records provider-scoped exponential backoff for repeated 429s', () => {
    process.env.ROUTECODEX_429_BACKOFF_BASE_MS = '1000';
    process.env.ROUTECODEX_429_BACKOFF_MAX_MS = '4000';

    const key = __requestExecutorTestables.buildProviderTransportBackoffKey({
      providerKey: 'mimo.key1.mimo-v2.5-pro',
      runtimeKey: 'runtime:mimo'
    });
    expect(key).toBe('runtime:runtime:mimo');

    const retryable429 = {
      error: Object.assign(new Error('HTTP 429: overload'), { statusCode: 429 }),
      statusCode: 429
    };

    expect(__requestExecutorTestables.consumeProviderTransportBackoffMs(key!, retryable429)).toBe(1000);
    expect(__requestExecutorTestables.peekProviderTransportBackoffWaitMs(key!)).toBe(1000);

    jest.setSystemTime(new Date('2026-04-22T13:00:00.500Z'));
    expect(__requestExecutorTestables.peekProviderTransportBackoffWaitMs(key!)).toBe(500);

    jest.setSystemTime(new Date('2026-04-22T13:00:02.000Z'));
    expect(__requestExecutorTestables.consumeProviderTransportBackoffMs(key!, retryable429)).toBe(2000);
    expect(__requestExecutorTestables.peekProviderTransportBackoffWaitMs(key!)).toBe(2000);

    __requestExecutorTestables.clearProviderTransportBackoff(key!);
    expect(__requestExecutorTestables.peekProviderTransportBackoffWaitMs(key!)).toBe(0);
  });

  test('treats transport and retryable upstream failures as provider backoff candidates', () => {
    expect(__requestExecutorTestables.shouldApplyProviderTransportBackoff({
      error: new Error('fetch failed'),
      retryError: {
        statusCode: 502,
        errorCode: 'HTTP_502',
        reason: 'fetch failed'
      },
      stage: 'provider.send'
    })).toBe(true);

    expect(__requestExecutorTestables.shouldApplyProviderTransportBackoff({
      error: Object.assign(new Error('HTTP 429: overload'), { statusCode: 429 }),
      retryError: {
        statusCode: 429,
        errorCode: 'HTTP_429',
        reason: 'HTTP 429: overload'
      },
      stage: 'provider.send'
    })).toBe(true);

    expect(__requestExecutorTestables.shouldApplyProviderTransportBackoff({
      error: Object.assign(new Error('HTTP 401: unauthorized'), { statusCode: 401 }),
      retryError: {
        statusCode: 401,
        errorCode: 'INVALID_API_KEY',
        reason: 'HTTP 401: unauthorized'
      },
      stage: 'provider.send'
    })).toBe(false);
  });
});
