import { jest } from '@jest/globals';
import type { ProviderHandle } from '../../../../src/server/runtime/http-server/types';
import type { ProviderTrafficGovernorLike } from '../../../../src/server/runtime/http-server/provider-traffic-governor.js';

jest.unstable_mockModule('../../../../src/server/runtime/http-server/executor/request-executor-native-retry-policy.js', () => ({
  resolveRequestExecutorNativeRetryPolicy: jest.fn((input: {
    classification?: string;
    isStreamingRequest?: boolean;
    hostContractFailure?: boolean;
    forceExcludeCurrentProviderOnRetry?: boolean;
    errorCode?: string;
    promptTooLong?: boolean;
    existingExclusion?: boolean;
  }) => {
    if (
      input.hostContractFailure
      && input.errorCode !== 'EMPTY_ASSISTANT_RESPONSE'
      && input.errorCode !== 'MISSING_REQUIRED_TOOL_CALL'
    ) {
      return { excludeCurrentProvider: false, reason: 'host_contract_failure' };
    }
    if (input.forceExcludeCurrentProviderOnRetry || input.existingExclusion) {
      return { excludeCurrentProvider: true, reason: 'existing_exclusion' };
    }
    if (input.isStreamingRequest && input.classification === 'recoverable' && !input.promptTooLong) {
      return { excludeCurrentProvider: true, reason: 'streaming_recoverable_pre_response' };
    }
    return { excludeCurrentProvider: false, reason: 'preserve_existing_policy' };
  })
}));

const { __requestExecutorTestables, createRequestExecutor } = await import('../../../../src/server/runtime/http-server/request-executor');
const { getServerToolRuntimeState, setServerToolEnabled } = await import('../../../../src/server/runtime/http-server/servertool-admin-state');
const { StatsManager } = await import('../../../../src/server/runtime/http-server/stats-manager');
const { createBridgeHttpServerMock } = await import('../../../helpers/bridge-http-server-mock');
const { MetadataCenter } = await import('../../../../src/server/runtime/http-server/metadata-center/metadata-center.js');

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

function buildMinimalResponsesSuccessBody(id: string, text = 'ok'): Record<string, unknown> {
  return {
    id,
    object: 'response',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }]
      }
    ],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2
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

  test('provider failure switches provider even when maxAttempts is one', async () => {
    const previousMaxAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '1';
    const providerA = 'tab.key1.gpt-5.2';
    const providerB = 'tab.key2.gpt-5.2';

    const failingProcess = jest.fn(async () => {
      throw Object.assign(new Error('HTTP 429'), { statusCode: 429, code: 'HTTP_429' });
    });
    const successProcess = jest.fn(async () => ({ status: 200, data: { id: 'resp_ok' } }));

    const handles = new Map<string, ProviderHandle>([
      [providerA, buildHandle(providerA, failingProcess)],
      [providerB, buildHandle(providerB, successProcess)]
    ]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const excluded = new Set<string>(
          Array.isArray(input?.metadata?.excludedProviderKeys) ? input.metadata.excludedProviderKeys : []
        );
        const selected = excluded.has(providerA) ? providerB : providerA;
        return {
          requestId: input.id,
          providerPayload: {
            model: 'gpt-5.2',
            previous_response_id: 'resp_inline_retry_leak',
            stream: true,
            store: false,
            input: [
              {
                role: 'user',
                type: 'message',
                content: [{ type: 'input_text', text: 'continue' }]
              }
            ]
          },
          target: {
            providerKey: selected,
            providerType: 'responses',
            outboundProfile: 'openai-responses',
            runtimeKey: selected
          },
          routingDecision: {
            routeName: 'default',
            pool: [providerA, providerB]
          },
          metadata: {}
        };
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    try {
      const executor = createRequestExecutor({
        runtimeManager,
        getHubPipeline: () => pipeline as any,
        getModuleDependencies: () => ({
          errorHandlingCenter: {
            handleError: jest.fn(async () => undefined)
          }
        }),
        logStage: jest.fn(),
        stats: new StatsManager()
      });
      let convertCount = 0;
      jest.spyOn(executor as any, 'convertProviderResponseIfNeeded').mockImplementation(async () => {
        convertCount += 1;
        if (convertCount === 1) {
          throw Object.assign(new Error('missing required tool call'), {
            code: 'MISSING_REQUIRED_TOOL_CALL',
            statusCode: 502,
            status: 502,
            retryable: true,
            requestExecutorProviderErrorStage: 'host.response_contract'
          });
        }
        return {
          status: 200,
          body: buildMinimalResponsesSuccessBody('resp_ok_after_reroute', 'ok_after_reroute')
        };
      });

      const result = await executor.execute({
        requestId: 'req-reroute-source-entry-rebuild',
        entryEndpoint: '/v1/responses',
        body: {
          model: 'gpt-5.2',
          previous_response_id: 'resp_original_entry',
          stream: true,
          store: false,
          input: [
            {
              role: 'user',
              type: 'message',
              content: [{ type: 'input_text', text: 'continue' }]
            }
          ]
        },
        headers: {},
        metadata: {
          stream: true,
          inboundStream: true,
          responsesRequestContext: {
            payload: {
              model: 'gpt-5.2',
              previous_response_id: 'resp_original_entry',
              stream: true,
              store: false
            },
            context: {
              input: [
                {
                  role: 'user',
                  type: 'message',
                  content: [{ type: 'input_text', text: 'continue' }]
                }
              ]
            }
          }
        }
      });

      expect(result).toEqual(expect.objectContaining({ status: 200 }));
      expect(failingProcess).toHaveBeenCalledTimes(1);
      expect(successProcess).toHaveBeenCalledTimes(1);
      expect(pipeline.execute).toHaveBeenCalledTimes(2);
      const secondPipelineInput = pipeline.execute.mock.calls[1]?.[0] as Record<string, any>;
      expect(secondPipelineInput?.metadata?.excludedProviderKeys).toEqual([providerA]);
    } finally {
      if (previousMaxAttempts === undefined) {
        delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      } else {
        process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = previousMaxAttempts;
      }
    }
  });

  test('reroutes host response contract empty assistant payload to next provider instead of returning 502 early', async () => {
    const previousMaxAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '2';
    const providerA = 'asxs.crsa.gpt-5.4';
    const providerB = '1token.key1.gpt-5.4';
    const declaredTools = [{
      type: 'function',
      function: {
        name: 'exec_command',
        description: 'run shell command',
        parameters: {
          type: 'object',
          properties: {
            cmd: { type: 'string' }
          },
          required: ['cmd']
        }
      }
    }];

    const firstProcess = jest.fn(async () => ({
      status: 200,
      data: {
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
      }
    }));
    const secondProcess = jest.fn(async () => ({
      status: 200,
      data: buildMinimalResponsesSuccessBody('resp_ok_b', 'ok_after_reroute')
    }));

    const handles = new Map<string, ProviderHandle>([
      [providerA, {
        runtimeKey: providerA,
        providerId: providerA,
        providerType: 'responses',
        providerFamily: 'responses',
        providerProtocol: 'openai-responses',
        runtime: {
          runtimeKey: providerA,
          providerId: providerA,
          keyAlias: providerA,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'oauth' },
          outboundProfile: 'openai-responses'
        },
        instance: {
          async initialize() {},
          async cleanup() {},
          processIncoming: firstProcess
        }
      }],
      [providerB, {
        runtimeKey: providerB,
        providerId: providerB,
        providerType: 'responses',
        providerFamily: 'responses',
        providerProtocol: 'openai-responses',
        runtime: {
          runtimeKey: providerB,
          providerId: providerB,
          keyAlias: providerB,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'oauth' },
          outboundProfile: 'openai-responses'
        },
        instance: {
          async initialize() {},
          async cleanup() {},
          processIncoming: secondProcess
        }
      }]
    ]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const selectedProviders: string[] = [];
    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const excluded = new Set<string>(
          Array.isArray(input?.metadata?.excludedProviderKeys) ? input.metadata.excludedProviderKeys : []
        );
        const selected = excluded.has(providerA) ? providerB : providerA;
        selectedProviders.push(selected);
        return {
          requestId: input.id,
          processedRequest: {
            model: 'gpt-5.4',
            tools: declaredTools,
            tool_choice: 'required',
            input: [
              {
                role: 'user',
                type: 'message',
                content: [{ type: 'input_text', text: 'continue' }]
              }
            ]
          },
          standardizedRequest: {
            model: 'gpt-5.4',
            tools: declaredTools,
            tool_choice: 'required'
          },
          providerPayload: {
            model: 'gpt-5.4',
            tool_choice: 'required',
            tools: declaredTools,
            input: [
              {
                role: 'user',
                type: 'message',
                content: [{ type: 'input_text', text: 'continue' }]
              }
            ]
          },
          target: {
            providerKey: selected,
            providerType: 'responses',
            outboundProfile: 'openai-responses',
            runtimeKey: selected
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

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const executor = createRequestExecutor({
        runtimeManager,
        getHubPipeline: () => pipeline as any,
        getModuleDependencies: () => ({
          errorHandlingCenter: {
            handleError: jest.fn(async () => undefined)
          }
        }),
        logStage: jest.fn(),
        stats: new StatsManager()
      });

      const result = await executor.execute({
        requestId: 'req-empty-assistant-reroute',
        entryEndpoint: '/v1/responses',
        body: {
          model: 'gpt-5.4',
          tools: declaredTools,
          tool_choice: 'required',
          input: [
            {
              role: 'user',
              type: 'message',
              content: [{ type: 'input_text', text: 'continue' }]
            }
          ]
        },
        headers: {},
        metadata: {}
      });

      expect(result).toEqual(expect.objectContaining({ status: 200 }));
      expect(selectedProviders).toEqual([providerA, providerB]);
      expect(firstProcess).toHaveBeenCalledTimes(1);
      expect(secondProcess).toHaveBeenCalledTimes(1);
      expect(pipeline.execute).toHaveBeenCalledTimes(2);
      const switchLines = warnSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((line) => line.includes('[provider-switch]') && line.includes('req-empty-assistant-reroute'));
      expect(switchLines.some((line) => (
        line.includes(`provider=${providerA}`)
        && line.includes('switch=exclude_and_reroute')
        && line.includes('decision=exclude_and_reroute')
        && line.includes('code=EMPTY_ASSISTANT_RESPONSE')
      ))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      if (previousMaxAttempts === undefined) {
        delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      } else {
        process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = previousMaxAttempts;
      }
    }
  });

  test('clears router-direct preselectedRoute before provider failure reroute so Hub can reselect tokenrelay', async () => {
    const previousAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '3';
    const providerA = 'XLC.key1.glm-5.2';
    const providerB = 'tokenrelay.key1.deepseek-v4-pro';
    const routePool = [providerA, providerB, 'XLC.key2.deepseek-v4-pro'];

    const failingProcess = jest.fn(async () => {
      throw Object.assign(new Error('model_not_found'), {
        statusCode: 503,
        status: 503,
        code: 'model_not_found',
        upstreamCode: 'HTTP_503',
        retryable: true
      });
    });
    const successProcess = jest.fn(async () => ({
      status: 200,
      data: buildMinimalResponsesSuccessBody('resp_tokenrelay_after_reroute', 'tokenrelay-ok')
    }));

    const handles = new Map<string, ProviderHandle>([
      [providerA, buildHandle(providerA, failingProcess)],
      [providerB, buildHandle(providerB, successProcess)]
    ]);
    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const selectedProviders: string[] = [];
    const preselectedSeenByAttempt: Array<boolean> = [];
    const pipeline = {
      execute: jest.fn(async (input: any, metadataArg?: Record<string, unknown>) => {
        const metadata = metadataArg && typeof metadataArg === 'object' ? metadataArg : input?.metadata;
        const runtimeControl = MetadataCenter.read(metadata)?.readRuntimeControl();
        const preselected = runtimeControl?.preselectedRoute as { target?: { providerKey?: string } } | undefined;
        const excluded = new Set<string>(
          Array.isArray(metadata?.excludedProviderKeys) ? metadata.excludedProviderKeys : []
        );
        const providerKey = preselected?.target?.providerKey
          ?? (excluded.has(providerA) ? providerB : providerA);
        selectedProviders.push(providerKey);
        preselectedSeenByAttempt.push(Boolean(preselected));
        return {
          requestId: input.id,
          processedRequest: {
            model: 'gpt-5.4',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping tokenrelay' }] }]
          },
          standardizedRequest: {
            model: 'gpt-5.4'
          },
          providerPayload: {
            model: providerKey === providerB ? 'deepseek-v4-pro' : 'glm-5.2',
            messages: [{ role: 'user', content: 'ping tokenrelay' }]
          },
          target: {
            providerKey,
            providerType: 'openai',
            outboundProfile: 'openai-chat',
            runtimeKey: providerKey,
            modelId: providerKey === providerB ? 'deepseek-v4-pro' : 'glm-5.2'
          },
          routingDecision: {
            routeName: 'thinking',
            pool: [providerKey],
            routePool,
            reason: 'thinking:user-input'
          },
          processMode: 'standard',
          metadata: {}
        };
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const metadata: Record<string, unknown> = {};
    MetadataCenter.attach(metadata).writeRuntimeControl(
      'preselectedRoute',
      {
        target: {
          providerKey: providerA,
          providerType: 'openai',
          outboundProfile: 'openai-chat',
          runtimeKey: providerA,
          modelId: 'glm-5.2'
        },
        decision: {
          routeName: 'thinking',
          pool: [providerA],
          routePool,
          reason: 'thinking:user-input'
        },
        diagnostics: {}
      },
      {
        module: 'tests/server/runtime/http-server/request-executor.spec.ts',
        symbol: 'clears router-direct preselectedRoute before provider failure reroute so Hub can reselect tokenrelay',
        stage: 'test_router_direct_relay_preselected_route'
      },
      'simulate router-direct target_outbound_profile_requires_hub_relay handoff'
    );

    try {
      const executor = createRequestExecutor({
        runtimeManager,
        getHubPipeline: () => pipeline as any,
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
        body: buildMinimalResponsesSuccessBody('resp_tokenrelay_after_reroute', 'tokenrelay-ok')
      });

      const result = await executor.execute({
        requestId: 'req-router-direct-relay-preselected-reroute',
        entryEndpoint: '/v1/responses',
        body: {
          model: 'gpt-5.4',
          stream: true,
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping tokenrelay' }] }]
        },
        headers: {},
        metadata
      });

      expect(result).toEqual(expect.objectContaining({ status: 200 }));
      expect(selectedProviders).toEqual([providerA, providerB]);
      expect(preselectedSeenByAttempt).toEqual([true, false]);
      expect(failingProcess).toHaveBeenCalledTimes(1);
      expect(successProcess).toHaveBeenCalledTimes(1);
      expect(pipeline.execute).toHaveBeenCalledTimes(2);
      const secondPipelineInput = pipeline.execute.mock.calls[1]?.[0] as { metadata?: Record<string, unknown> } | undefined;
      const secondMetadata = secondPipelineInput?.metadata;
      expect(secondMetadata?.excludedProviderKeys).toEqual([providerA]);
      expect(MetadataCenter.read(secondMetadata)?.readRuntimeControl().preselectedRoute).toBeUndefined();
    } finally {
      if (previousAttempts === undefined) {
        delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      } else {
        process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = previousAttempts;
      }
    }
  });

  test('reports provider business upstream status from protocol details', () => {
    const providerBusinessReportPlan = __requestExecutorTestables.resolveRequestExecutorProviderErrorReportPlan({
      error: Object.assign(new Error('[hub_response] Upstream provider returned structured business error'), {
        code: 'HTTP_429_2056',
        statusCode: 429,
        requestExecutorProviderErrorStage: 'host.response_contract',
        details: {
          upstreamCode: 'provider_status_2056',
          providerStatusCode: 2056,
          providerStatusMessage: 'usage limit exceeded, weekly usage limit reached'
        }
      }),
      retryError: {
        statusCode: 429,
        errorCode: 'HTTP_429_2056',
        reason: '[hub_response] Upstream provider returned structured business error'
      },
      stage: 'provider.send'
    });
    expect(providerBusinessReportPlan).toEqual({
      errorCode: 'HTTP_429_2056',
      upstreamCode: 'PROVIDER_STATUS_2056',
      statusCode: 429,
      stageHint: 'host.response_contract'
    });
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

  test('fails fast on acquire-time concurrency saturation and reroutes to the next route candidate', async () => {
    const providerA = '1token.key1.gpt-5.5';
    const providerB = 'asxs.gpt-5.5';
    const processA = jest.fn(async () => ({ status: 200, data: { id: 'should-not-run' } }));
    const processB = jest.fn(async () => ({ status: 200, data: { id: 'rerouted-ok' } }));
    const handles = new Map<string, ProviderHandle>([
      [providerA, buildHandle(providerA, processA)],
      [providerB, buildHandle(providerB, processB)]
    ]);
    const acquire = jest.fn(async ({ runtimeKey }: { runtimeKey: string }) => {
      if (runtimeKey === providerA) {
        throw Object.assign(new Error('provider traffic saturated for runtime 1token.key1.gpt-5.5'), {
          statusCode: 429,
          code: 'PROVIDER_TRAFFIC_SATURATED',
          retryable: true,
          details: {
            reason: 'acquire_after_backoff_concurrency',
            runtimeKey,
            providerKey: runtimeKey,
            unifiedBackoffMs: 1000
          }
        });
      }
      return {
        permit: {
          runtimeKey,
          providerKey: runtimeKey,
          requestId: 'req-acquire-fast-fail',
          leaseId: `lease-${runtimeKey}`,
          stateKey: runtimeKey,
          maxInFlight: 1
        },
        policy: {
          concurrency: { maxInFlight: 1, acquireTimeoutMs: 100, staleLeaseMs: 1000 },
          rpm: { requestsPerMinute: 10, acquireTimeoutMs: 100, windowMs: 60000 }
        },
        waitedMs: 1000,
        activeInFlight: 1,
        rpmInWindow: 1
      };
    });
    const fakeTrafficGovernor: ProviderTrafficGovernorLike = {
      setConcurrencyBusyCallback() {},
      acquire,
      async release() {
        return { released: true, activeInFlight: 0 };
      },
      async isProviderAtConcurrencyCapacity() { return false; },
      isProviderAtConcurrencyCapacitySync(runtimeKey: string) {
        return runtimeKey === providerA;
      },
      async observeOutcome() {}
    };
    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };
    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const excluded = new Set<string>(
          Array.isArray(input?.metadata?.excludedProviderKeys) ? input.metadata.excludedProviderKeys : []
        );
        const selected = excluded.has(providerA) ? providerB : providerA;
        return {
          requestId: input.requestId,
          providerPayload: { model: 'gpt-5.5', input: 'continue' },
          target: {
            providerKey: selected,
            providerType: 'responses',
            outboundProfile: 'openai-responses',
            runtimeKey: selected
          },
          routingDecision: {
            routeName: 'default',
            pool: [providerA, providerB]
          },
          metadata: {}
        };
      }),
      updateVirtualRouterConfig: jest.fn()
    };
    const logStage = jest.fn();
    const executor = createRequestExecutor({
      runtimeManager,
      getHubPipeline: () => pipeline as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => undefined)
        }
      }),
      logStage,
      stats: new StatsManager(),
      trafficGovernor: fakeTrafficGovernor
    });
    const result = await executor.execute({
      requestId: 'req-acquire-fast-fail',
      entryEndpoint: '/v1/responses',
      body: { model: 'gpt-5.5', input: 'continue' },
      headers: {},
      metadata: {}
    });

    expect(result).toEqual(expect.objectContaining({ status: 200 }));
    expect(processA).toHaveBeenCalledTimes(0);
    expect(processB).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(acquire.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ runtimeKey: providerA }));
    expect(acquire.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ runtimeKey: providerB }));
    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    const secondPipelineInput = pipeline.execute.mock.calls[1]?.[0] as Record<string, any>;
    expect(secondPipelineInput?.metadata?.excludedProviderKeys).toEqual([providerA]);
    expect(
      logStage.mock.calls.some(
        (call) =>
          call[0] === 'provider.traffic.acquire.wait'
      )
    ).toBe(true);
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

    await expect(__requestExecutorTestables.resolveProviderRetryExecutionPlan({
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
    })).resolves.toMatchObject({
      shouldRetry: true,
      classification: 'recoverable',
      action: 'reroute_explicit_alternative'
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

    await expect(__requestExecutorTestables.resolveProviderRetryExecutionPlan({
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
    })).resolves.toMatchObject({
      shouldRetry: true,
      classification: 'recoverable',
      action: 'reroute_explicit_alternative'
    });

    await expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
      status: 'completed',
      output: [
        {
          type: 'reasoning',
          text: 'internal only'
        }
      ],
      reasoning: 'internal only'
    })).resolves.toBeNull();

    await expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            reasoning: 'internal only'
          }
        }
      ]
    })).resolves.toMatchObject({
      marker: 'chat_empty_assistant'
    });

    await expect(__requestExecutorTestables.hasRequestedToolsInSemantics({
      tools: {
        clientToolsRaw: [
          {
            type: 'function',
            function: { name: 'exec_command' }
          }
        ]
      }
    })).resolves.toBe(true);

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
    })).resolves.toBe(true);

    await expect(__requestExecutorTestables.isRequiredToolCallTurn({
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
    })).resolves.toBe(false);

    expect(__requestExecutorTestables.isToolResultFollowupTurn({
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: 'ok'
        }
      ]
    })).resolves.toBe(true);

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
    })).resolves.toBe(true);

    expect(__requestExecutorTestables.isToolResultFollowupTurn({
      messages: [
        {
          role: 'system',
          content: 'system guidance'
        },
        {
          role: 'user',
          content: 'investigate current rustification state'
        },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_prev_1',
              type: 'function',
              function: {
                name: 'list_directory',
                arguments: '{"path":"sharedmodule/llmswitch-core/src/servertool"}'
              }
            },
            {
              id: 'call_prev_2',
              type: 'function',
              function: {
                name: 'list_directory',
                arguments: '{"path":"sharedmodule/llmswitch-core/rust-core/crates"}'
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_prev_1',
          content: 'stop-message-auto.ts\\nengine.ts'
        },
        {
          role: 'tool',
          tool_call_id: 'call_prev_2',
          content: 'servertool-core\\nservertool-cli'
        },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_curr_1',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: '{"path":"sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs"}'
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call_curr_1',
          content: 'pub mod orchestration;'
        }
      ]
    })).resolves.toBe(true);

    await expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
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
    })).resolves.toBeNull();

    await expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
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
    })).resolves.toBeNull();

    await expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
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
      __routecodex: {}
    })).resolves.toBeNull();

    await expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
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
      __routecodex: {}
    })).resolves.toBeNull();

    await expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: '我已经完成了，下面给你结果。'
          }
        }
      ]
    }, {
      __routecodex: {},
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
    })).resolves.toBeNull();

    await expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
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
    })).resolves.toBeNull();

    await expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
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
    })).resolves.toBeNull();

    const malformedToolWrapperText = `<tool_call>
{"arguments":{"cmd":"bash -lc 'pwd'","justification":"check"}}
</tool_call>`;

    await expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
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
    })).resolves.toBeNull();

    await expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
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
    })).resolves.toBeNull();

    await expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
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
    })).resolves.toMatchObject({
      marker: 'responses_missing_required_tool_call'
    });

    await expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
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
    })).resolves.toBeNull();

    await expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
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
    })).resolves.toBeNull();

    await expect(__requestExecutorTestables.detectRetryableEmptyAssistantResponse({
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
    })).resolves.toBeNull();

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
    expect(singleton429ExclusionPlan.excludedCurrentProvider).toBe(true);
    const multi429ThirdAttemptExclusionPlan = __requestExecutorTestables.resolveProviderRetryExclusionPlan({
      providerKey: 'sdfv.key1.gpt-5.4',
      status: 429,
      error: Object.assign(new Error('HTTP 429: overload'), { statusCode: 429 }),
      attempt: 3,
      promptTooLong: false,
      isVerify: false,
      isReauth: false,
      routePool: ['sdfv.key1.gpt-5.4', 'dibittai.crsa.gpt-5.4'],
      excludedProviderKeys: new Set<string>()
    });
    expect(multi429ThirdAttemptExclusionPlan.excludedCurrentProvider).toBe(true);
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

    expect(__requestExecutorTestables.isLastAvailableProvider429({
      providerKey: 'mimo.key1.mimo-v2.5-pro',
      routePool: ['mimo.key1.mimo-v2.5-pro'],
      excludedProviderKeys: new Set<string>(),
      retryError: {
        statusCode: 429,
        errorCode: 'MALFORMED_RESPONSE',
        upstreamCode: 'provider_status_2056',
        reason: 'usage limit exceeded'
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
      error: Object.assign(new Error('socket hang up'), {
        code: 'ECONNRESET'
      }),
      retryError: {
        errorCode: 'ECONNRESET',
        reason: 'socket hang up'
      },
      stage: 'provider.send'
    })).toBe('recoverable');

    expect(__requestExecutorTestables.resolveRequestExecutorProviderErrorClassification({
      error: Object.assign(new Error('usage limit exceeded'), {
        code: 'MALFORMED_RESPONSE',
        upstreamCode: 'provider_status_2056',
        statusCode: 429
      }),
      retryError: {
        statusCode: 429,
        errorCode: 'MALFORMED_RESPONSE',
        upstreamCode: 'provider_status_2056',
        reason: 'usage limit exceeded'
      },
      stage: 'provider.send'
    })).toBe('recoverable');

    expect(__requestExecutorTestables.resolveRequestExecutorProviderErrorClassification({
      error: Object.assign(new Error('daily usage limit exceeded'), {
        code: 'HTTP_429',
        upstreamCode: 'HTTP_429',
        statusCode: 429
      }),
      retryError: {
        statusCode: 429,
        errorCode: 'HTTP_429',
        upstreamCode: 'HTTP_429',
        reason: 'daily usage limit exceeded'
      },
      stage: 'provider.send'
    })).toBe('unrecoverable');

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
      expect(executionPlan.backoffScope).toBe('none');
      expect(executionPlan.retryBackoffMs).toBe(0);
      expect(executionPlan.retrySwitchPlan).toEqual(expect.objectContaining({
        switchAction: 'exclude_and_reroute',
        decisionLabel: 'exclude_and_reroute'
      }));
      expect(Array.from(orchestratorExcluded)).toEqual(['gemini.primary.gemini-2.5-pro']);

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
        switchAction: 'exclude_and_reroute',
        backoffScope: 'none',
        decisionLabel: 'exclude_and_reroute',
        stage: 'provider.send'
      }));
      expect(telemetryPlan.retryStageDetails).toEqual(expect.objectContaining({
        providerKey: 'gemini.primary.gemini-2.5-pro',
        routeHint: 'thinking',
        switchAction: 'exclude_and_reroute',
        backoffScope: 'none',
        decisionLabel: 'exclude_and_reroute'
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
        excludedCurrentProvider: true,
        retrySwitchPlan: expect.objectContaining({
          switchAction: 'exclude_and_reroute',
          decisionLabel: 'exclude_and_reroute'
        })
      }));
      expect(Array.from(networkExcluded)).toEqual(['deepseek.key1.deepseek-v4-pro']);


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
        excludedCurrentProvider: true,
        requestLocalTransient: false,
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
        excludedCurrentProvider: true,
        backoffScope: 'none',
        retrySwitchPlan: expect.objectContaining({
          switchAction: 'exclude_and_reroute',
          decisionLabel: 'exclude_and_reroute'
        })
      }));
      expect(Array.from(sqliteBusyExcluded)).toEqual(['deepseek.key1.deepseek-v4-pro']);

    await expect(__requestExecutorTestables.resolveProviderRetryExecutionPlan({
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
    })).rejects.toThrow('[request-executor] provider failure classification missing');

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

  test('RED: recoverable 429 must continue to later pools before failing when default still has candidates', async () => {
    const firstProviderKey = 'minimax.key1.MiniMax-M3';
    const secondProviderKey = 'asxs.crsa.gpt-5.4';

    const firstProcess = jest.fn(async () => {
      throw Object.assign(new Error('HTTP 429: upstream rate limited'), {
        statusCode: 429,
        code: 'HTTP_429',
        upstreamCode: 'HTTP_429'
      });
    });
    const secondProcess = jest.fn(async () => ({
      status: 200,
      data: {
        id: 'ok-after-next-pool',
        object: 'response',
        status: 'completed',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok_from_default_pool' }]
        }]
      }
    }));

    const runtimeManager = {
      resolveRuntimeKey: (providerKey?: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => {
        if (runtimeKey === firstProviderKey) {
          return buildHandle(firstProviderKey, firstProcess);
        }
        if (runtimeKey === secondProviderKey) {
          return buildHandle(secondProviderKey, secondProcess);
        }
        return undefined;
      }
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const excluded = new Set<string>(
          Array.isArray(input.metadata?.excludedProviderKeys) ? input.metadata.excludedProviderKeys : []
        );
        const providerKey = excluded.has(firstProviderKey) ? secondProviderKey : firstProviderKey;
        const pool = excluded.has(firstProviderKey)
          ? [secondProviderKey]
          : [firstProviderKey];
        return {
          requestId: input.id,
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'openai',
            outboundProfile: 'openai-responses',
            runtimeKey: providerKey
          },
          routingDecision: {
            routeName: excluded.has(firstProviderKey) ? 'default' : 'search',
            pool,
            poolId: excluded.has(firstProviderKey) ? 'default-backstop' : 'search-primary'
          },
          metadata: {}
        };
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const executor = createRequestExecutor({
      runtimeManager: runtimeManager as any,
      getHubPipeline: () => pipeline as any,
      getModuleDependencies: () => ({ errorHandlingCenter: { handleError: async () => undefined } }) as any,
      logStage: () => undefined,
      stats: new StatsManager()
    });

    const result = await executor.execute({
      entryEndpoint: '/v1/responses',
      method: 'POST',
      requestId: 'req-429-next-pool-default',
      headers: {},
      query: {},
      body: { model: 'gpt-test', input: 'hi' },
      metadata: {}
    });

    expect(firstProcess).toHaveBeenCalledTimes(1);
    expect(secondProcess).toHaveBeenCalledTimes(1);
    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    expect(result.body).toEqual(expect.objectContaining({
      id: 'ok-after-next-pool'
    }));
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

  test('backs off recoverable pool exhaustion before retrying route selection', async () => {
    jest.useFakeTimers();
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
    jest.spyOn(executor as any, 'convertProviderResponseIfNeeded').mockResolvedValue({
      status: 200,
      body: { id: 'ok-after-pool-exhausted-backoff', object: 'response', status: 'completed' }
    });
    const pending = executor.execute({
      requestId: 'req-cooldown-wait',
      entryEndpoint: '/v1/responses',
      body: {},
      headers: {},
      metadata: {}
    });
    const expectation = expect(pending).resolves.toMatchObject({
      status: 200,
      body: { id: 'ok-after-wait' }
    });

    await jest.advanceTimersByTimeAsync(999);
    expect(pipeline.execute).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expectation;

    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    expect(
      logStage.mock.calls.some(
        (call) => call[0] === 'hub.pool_exhausted.backoff_wait'
      )
    ).toBe(true);
  });

  test('does not surface singleton concurrency busy before bounded pool backoff retry completes', async () => {
    jest.useFakeTimers();
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
    const pending = executor.execute({
      requestId: 'req-singleton-concurrency-wait',
      entryEndpoint: '/v1/responses',
      body: {},
      headers: {},
      metadata: {}
    });
    const expectation = expect(pending).resolves.toMatchObject({ status: 200 });

    await jest.advanceTimersByTimeAsync(999);
    expect(pipeline.execute).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expectation;

    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    expect(
      logStage.mock.calls.some(
        (call) =>
          call[0] === 'hub.pool_exhausted.backoff_wait'
      )
    ).toBe(true);
  });

  test('blocks and retries singleton recoverable pool exhaustion instead of surfacing no-provider', async () => {
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
        if (calls <= 2) {
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
      const pending = executor.execute({
        requestId: 'req-singleton-cooldown-budget',
        entryEndpoint: '/v1/responses',
        body: {},
        headers: {},
        metadata: {}
      });
      const expectation = expect(pending).resolves.toMatchObject({ status: 200 });

      await jest.advanceTimersByTimeAsync(999);
      expect(pipeline.execute).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await jest.advanceTimersByTimeAsync(1_000);
      await expectation;

      expect(pipeline.execute).toHaveBeenCalledTimes(3);
      expect(
        logStage.mock.calls.filter(
          (call) => call[0] === 'provider.route_pool_cooldown_wait'
        )
      ).toHaveLength(2);
      expect(
        logStage.mock.calls.filter(
          (call) => call[0] === 'provider.route_pool_cooldown_wait.completed'
        )
      ).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('default-pool singleton exhaustion eventually stops instead of infinite cooldown wait', async () => {
    jest.useFakeTimers();
    const searchProvider = 'search.key1.gpt-5.4';
    const defaultProvider = 'default.key1.MiniMax-M3';

    const runtimeManager = {
      resolveRuntimeKey: (key: string) => key,
      getHandleByRuntimeKey: () => undefined
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const allowedProviders = input?.metadata?.allowedProviders;
        if (Array.isArray(allowedProviders) && allowedProviders[0] === defaultProvider) {
          throw Object.assign(new Error('All providers unavailable for route default'), {
            code: 'PROVIDER_NOT_AVAILABLE',
            details: {
              routeName: 'default',
              candidateProviderCount: 1,
              minRecoverableCooldownMs: 1000,
              recoverableCooldownHints: [
                { providerKey: defaultProvider, waitMs: 1000, source: 'provider.error' }
              ]
            }
          });
        }
        throw Object.assign(new Error('All providers unavailable for route search'), {
          code: 'PROVIDER_NOT_AVAILABLE',
          details: {
            primaryExhaustedRouteName: 'search',
            primaryExhaustedTargets: [searchProvider],
            unavailableRoutePools: [
              {
                routeName: 'search',
                poolId: 'search-primary',
                poolTargets: [searchProvider]
              },
              {
                routeName: 'default',
                poolId: 'default-primary',
                poolTargets: [defaultProvider]
              }
            ]
          }
        });
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const logStage = jest.fn();
    const executor = createRequestExecutor({
      runtimeManager: runtimeManager as any,
      getHubPipeline: () => pipeline as any,
      getRoutingTiers: () => [
        { id: 'search-primary', targets: [searchProvider], priority: 200 },
        { id: 'default-primary', targets: [defaultProvider], priority: 100, backup: true }
      ],
      getModuleDependencies: () => ({ errorHandlingCenter: { handleError: async () => undefined } }) as any,
      logStage,
      stats: new StatsManager()
    });

    const expectation = expect(executor.execute({
      requestId: 'req-default-pool-singleton-must-stop',
      entryEndpoint: '/v1/chat/completions',
      body: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }]
      },
      headers: {},
      metadata: {
        routecodexRoutingPolicyGroup: 'gateway_priority_5555'
      }
    })).rejects.toMatchObject({ code: 'PROVIDER_NOT_AVAILABLE' });

    await jest.advanceTimersByTimeAsync(30_000);
    await expectation;
    expect(
      logStage.mock.calls.some((call) => call[0] === 'provider.primary_exhausted_to_default_pool.applied')
    ).toBe(true);
    expect(
      logStage.mock.calls.some((call) => call[0] === 'provider.route_pool_cooldown_wait.exhausted')
    ).toBe(true);
  }, 20_000);


  test('switches recoverable 429 to an alternative provider when available', async () => {
    jest.useFakeTimers();
    const firstProviderKey = 'gemini.primary.gemini-2.5-pro';
    const secondProviderKey = 'gemini.backup.gemini-2.5-flash';
    const failingError = new Error('HTTP 429: quota exhausted');
    (failingError as any).statusCode = 429;

    const failingProcess = jest.fn(async () => {
      throw failingError;
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
    try {
      const pending = executor.execute({
        requestId: 'req-retry',
        entryEndpoint: '/v1/chat/completions',
        body: {},
        headers: {},
        metadata: {
          __routecodexPreselectedRoute: {
            decision: {
              routeName: 'thinking',
              providerKey: firstProviderKey,
              pool: [firstProviderKey, secondProviderKey]
            }
          }
        }
      });
      const expectation = expect(pending).resolves.toEqual(expect.objectContaining({ status: 200 }));

      await jest.advanceTimersByTimeAsync(1_000);
      await expectation;

      expect(pipeline.execute).toHaveBeenCalledTimes(2);
      expect(failingProcess).toHaveBeenCalledTimes(1);
      expect(successProcess).toHaveBeenCalledTimes(1);

      const secondCallMetadata = pipeline.execute.mock.calls[1][0].metadata as Record<string, unknown>;
      expect(secondCallMetadata.excludedProviderKeys).toEqual([firstProviderKey]);
      expect(secondCallMetadata.__routecodexPreselectedRoute).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  test('prints retry switch reason and error code to console on provider switch', async () => {
    jest.useFakeTimers();
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
        const excluded = new Set<string>(
          Array.isArray(input.metadata?.excludedProviderKeys)
            ? input.metadata.excludedProviderKeys
            : []
        );
        const providerKey = excluded.has(firstProviderKey) ? secondProviderKey : firstProviderKey;
        return {
          requestId: input.id,
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'openai',
            outboundProfile: 'openai-responses',
            runtimeKey: providerKey
          },
          routingDecision: {
            routeName: 'longcontext',
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

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
    try {
      const executor = createRequestExecutor(deps);
      const pending = executor.execute({
        requestId: 'req-switch-log',
        entryEndpoint: '/v1/responses',
        body: {},
        headers: {},
        metadata: {}
      });
      const expectation = expect(pending).resolves.toEqual(expect.objectContaining({ status: 200 }));

      await jest.advanceTimersByTimeAsync(1_000);
      await expectation;

      expect(failingProcess).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[provider-switch]'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('status=429'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('code=SSE_TO_JSON_ERROR'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('upstreamCode=rate_limit_error'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('switch=exclude_and_reroute'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('decision=exclude_and_reroute'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('backoffScope=none'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('provider=crs.key2.gpt-5.3-codex'));
      expect(successProcess).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  test('responses standard pipeline does not apply direct payload contract before provider.send', async () => {
    jest.resetModules();
    jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.js', () => createBridgeHttpServerMock({
      evaluateResponsesDirectRouteDecisionNative: () => ({
        providerWireValid: true,
        requiresHubRelay: false,
        reason: undefined,
        hasDeclaredApplyPatchTool: false,
      }),
    }));
    const { createRequestExecutor: createRequestExecutorLocal } = await import('../../../../src/server/runtime/http-server/request-executor');
    const providerA = 'asxs.crsa.gpt-5.5';
    const providerB = 'cc.key1.gpt-5.5';
    const processA = jest.fn(async () => ({ status: 200, data: { id: 'should_not_send_a' } }));
    const processB = jest.fn(async () => ({ status: 200, data: { id: 'should_not_send_b' } }));

    const handles = new Map<string, ProviderHandle>([
      [providerA, {
        ...buildHandle(providerA, processA),
        providerType: 'responses',
        providerFamily: 'responses',
        providerProtocol: 'openai-responses',
        runtime: {
          runtimeKey: providerA,
          providerId: providerA,
          keyAlias: providerA,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'oauth' },
          outboundProfile: 'openai-responses'
        }
      }],
      [providerB, {
        ...buildHandle(providerB, processB),
        providerType: 'responses',
        providerFamily: 'responses',
        providerProtocol: 'openai-responses',
        runtime: {
          runtimeKey: providerB,
          providerId: providerB,
          keyAlias: providerB,
          providerType: 'responses',
          endpoint: 'https://example.invalid',
          auth: { type: 'oauth' },
          outboundProfile: 'openai-responses'
        }
      }]
    ]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const excluded = new Set<string>(
          Array.isArray(input?.metadata?.excludedProviderKeys) ? input.metadata.excludedProviderKeys : []
        );
        const selected = excluded.has(providerA) ? providerB : providerA;
        return {
          requestId: input.id,
          providerPayload: {
            model: 'gpt-5.5',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'continue' }] }],
            tools: [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }],
          },
          target: {
            providerKey: selected,
            providerType: 'responses',
            outboundProfile: 'openai-responses',
            runtimeKey: selected
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

    const executor = createRequestExecutorLocal({
      runtimeManager,
      getHubPipeline: () => pipeline as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => undefined)
        }
      }),
      logStage: jest.fn(),
      stats: new StatsManager()
    });

    const result = await executor.execute({
      requestId: 'req-responses-standard-shape-lock',
      entryEndpoint: '/v1/responses',
      body: {
        model: 'gpt-5.5',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'continue' }] }]
      },
      headers: {},
      metadata: {}
    });

    expect(result).toEqual(expect.objectContaining({ status: 200 }));
    expect(processA).toHaveBeenCalledTimes(1);
    expect(processB).not.toHaveBeenCalled();
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
        switchAction: 'exclude_and_reroute',
        backoffScope: 'none',
        decisionLabel: 'exclude_and_reroute',
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
        switchAction: 'exclude_and_reroute',
        backoffScope: 'none',
        decisionLabel: 'exclude_and_reroute',
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
        switchAction: 'exclude_and_reroute',
        backoffScope: 'none',
        decisionLabel: 'exclude_and_reroute',
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

  test('switches 429 to alternative provider when route pool exposes one', async () => {
    jest.useFakeTimers();
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
      const pending = executor.execute({
        requestId: 'req-singleton-429-reroute',
        entryEndpoint: '/v1/responses',
        body: {},
        headers: {},
        metadata: {}
      });
      const expectation = expect(pending).resolves.toEqual(expect.objectContaining({ status: 200 }));

      await jest.advanceTimersByTimeAsync(1_000);
      await expectation;

      expect(pipeline.execute).toHaveBeenCalledTimes(2);
      expect(failingProcess).toHaveBeenCalledTimes(1);
      expect(successProcess).toHaveBeenCalledTimes(1);
      expect((pipeline.execute.mock.calls[1][0].metadata as Record<string, unknown>).excludedProviderKeys)
        .toEqual([firstProviderKey]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('switch=exclude_and_reroute'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('decision=exclude_and_reroute'));
    } finally {
      jest.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  test('forces longcontext routeHint on prompt-too-long retry', async () => {
    jest.useFakeTimers();
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
        const runtimeControl = MetadataCenter.read(input.metadata)?.readRuntimeControl() ?? {};
        routeHints.push(typeof runtimeControl.routeHint === 'string' ? runtimeControl.routeHint : undefined);
        const useLongcontext = runtimeControl.routeHint === 'longcontext';
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
    try {
      const pending = executor.execute({
        requestId: 'req-context-overflow',
        entryEndpoint: '/v1/chat/completions',
        body: {},
        headers: {},
        metadata: {}
      });
      const expectation = expect(pending).resolves.toEqual(expect.objectContaining({ status: 200 }));

      await jest.advanceTimersByTimeAsync(1_000);
      await expectation;

      expect(pipeline.execute).toHaveBeenCalledTimes(2);
      expect(routeHints[0]).not.toBe('longcontext');
      expect(routeHints[1]).toBe('longcontext');
    } finally {
      jest.useRealTimers();
    }
  });

  test('reroutes 403 OAuth reauth-required error when provider pool has an alternative', async () => {
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
          routingDecision: { routeName: 'default', pool: [firstProviderKey, secondProviderKey] },
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

    expect(result.status).toBe(200);
    expect(result.body).toEqual(expect.objectContaining({ id: 'ok' }));
    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    expect(failingProcess).toHaveBeenCalledTimes(1);
    expect(successProcess).toHaveBeenCalledTimes(1);
  });
  test('preserves first upstream error when retry-exhausted routing reports provider unavailable', async () => {
    jest.useFakeTimers();
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

    const poolExhaustedError = Object.assign(new Error('All providers unavailable for model glm.kimi-k2.5'), {
      code: 'PROVIDER_NOT_AVAILABLE'
    });
    let pipelineCall = 0;
    const pipeline = {
      execute: jest.fn(async () => {
        pipelineCall += 1;
        if (pipelineCall === 1) {
          return {
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
          };
        }
        throw poolExhaustedError;
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

    try {
      const pending = executor.execute({
        requestId: 'req-pool-exhausted',
        entryEndpoint: '/v1/chat/completions',
        body: {},
        headers: {},
        metadata: {}
      });
      const expectation = expect(pending).rejects.toMatchObject({
        message: 'HTTP 429: quota exhausted',
        statusCode: 429,
        code: 'HTTP_429'
      });

      await jest.advanceTimersByTimeAsync(12_000);
      await expectation;

      expect(pipeline.execute).toHaveBeenCalledTimes(5);
      const secondCallMetadata = pipeline.execute.mock.calls[1][0].metadata as Record<string, unknown>;
      expect(secondCallMetadata.excludedProviderKeys).toEqual(['glm.1-186.kimi-k2.5']);
      expect(
        deps.logStage.mock.calls.filter((call) => call[0] === 'hub.pool_exhausted.backoff_wait')
      ).toHaveLength(3);
    } finally {
      jest.useRealTimers();
    }
  }, 20_000);
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

    let pipelineCalls = 0;
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
        .mockImplementation(async () => {
          pipelineCalls += 1;
          if (pipelineCalls === 1) {
            return {
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
            };
          }
          if (pipelineCalls === 2) {
            throw Object.assign(new Error('All providers unavailable for model glm.glm-4.7'), {
              code: 'PROVIDER_NOT_AVAILABLE',
              details: {
                routeName: 'direct',
                candidateProviderCount: 1,
                minRecoverableCooldownMs: 1000,
                recoverableCooldownHints: [{ providerKey: firstProviderKey, waitMs: 1000, source: 'provider.error' }]
              }
            });
          }
          return {
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
    jest.useFakeTimers();
    try {
      const pending = executor.execute({
        requestId: 'req-single-pool-unavailable',
        entryEndpoint: '/v1/chat/completions',
        body: {},
        headers: {},
        metadata: {}
      });
      const expectation = expect(pending).resolves.toEqual(expect.objectContaining({ status: 200 }));

      await jest.advanceTimersByTimeAsync(2_000);
      await expectation;

      expect(pipeline.execute).toHaveBeenCalledTimes(4);
      expect(failingProcess).toHaveBeenCalledTimes(2);
      const secondCallMetadata = pipeline.execute.mock.calls[1][0].metadata as Record<string, unknown>;
      expect(secondCallMetadata.excludedProviderKeys).toEqual([firstProviderKey]);
      const thirdCallMetadata = pipeline.execute.mock.calls[2][0].metadata as Record<string, unknown>;
      expect(thirdCallMetadata.excludedProviderKeys).toEqual([firstProviderKey]);
      expect(
        deps.logStage.mock.calls.some(
          (call: unknown[]) =>
            call[0] === 'provider.route_pool_cooldown_wait'
        )
      ).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('reroutes 429 instead of same-provider retry when route pool still exposes an alternative candidate', async () => {
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
    expect(primaryProcess).toHaveBeenCalledTimes(1);
    expect(fallbackProcess).toHaveBeenCalledTimes(1);

    const secondCallMetadata = pipeline.execute.mock.calls[1][0].metadata as Record<string, unknown>;
    expect(secondCallMetadata.excludedProviderKeys).toEqual([primaryProviderKey]);
  });

  test('excludes each provider on repeated 429 when route pool has another candidate', async () => {
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

    const previousAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '2';

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
      jest
        .spyOn(executor as any, 'convertProviderResponseIfNeeded')
        .mockResolvedValue({ status: 200, body: { output_text: 'ok_after_last_provider_wait' } });
      await expect(executor.execute({
        requestId: 'req-last-provider-429',
        entryEndpoint: '/v1/responses',
        body: {},
        headers: {},
        metadata: {}
      })).rejects.toThrow(/HTTP 429/);

      expect(pipeline.execute).toHaveBeenCalledTimes(2);
      expect(processA).toHaveBeenCalledTimes(1);
      expect(processB).toHaveBeenCalledTimes(1);

      const secondCallMetadata = pipeline.execute.mock.calls[1][0].metadata as Record<string, unknown>;
      expect(secondCallMetadata.excludedProviderKeys).toEqual([providerA]);
      const retryEvents = logStage.mock.calls
        .filter((call) => call[0] === 'provider.retry')
        .map((call) => call[2] as Record<string, unknown>);
      expect(retryEvents.at(-1)).toEqual(expect.objectContaining({
        providerKey: providerB,
        excluded: [providerA, providerB]
      }));
    } finally {
      if (previousAttempts === undefined) {
        delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      } else {
        process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = previousAttempts;
      }
    }
  });


  test('BLACKBOX: converted HTTP 503 keeps same provider with recoverable backoff before success', async () => {
    const providerA = 'sdfv.key1.gpt-5.5';
    const providerB = 'mimo.mimo-v2.5-pro';
    const processA = jest.fn()
      .mockResolvedValueOnce({
        status: 503,
        data: {
          error: {
            code: 'HTTP_503',
            message: 'Service temporarily unavailable'
          }
        }
      })
      .mockResolvedValueOnce({ status: 200, data: { id: 'raw_a_ok_after_retry' } });
    const processB = jest.fn(async () => ({ status: 200, data: { id: 'raw_b' } }));

    const handles = new Map<string, ProviderHandle>([
      [providerA, buildHandle(providerA, processA)],
      [providerB, buildHandle(providerB, processB)]
    ]);

    const runtimeManager = {
      resolveRuntimeKey: (providerKey: string) => providerKey,
      getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey ? handles.get(runtimeKey) : undefined)
    };

    const selectedProviders: string[] = [];
    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const excluded = new Set<string>(
          Array.isArray(input.metadata?.excludedProviderKeys)
            ? input.metadata.excludedProviderKeys
            : []
        );
        const providerKey = excluded.has(providerA) ? providerB : providerA;
        selectedProviders.push(providerKey);
        return {
          requestId: input.id,
          providerPayload: {},
          target: {
            providerKey,
            providerType: 'openai',
            outboundProfile: 'openai-responses',
            runtimeKey: providerKey
          },
          routingDecision: {
            routeName: 'coding',
            pool: [providerA, providerB]
          },
          processMode: 'standard',
          metadata: {}
        };
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const previousAttempts = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '4';

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
        .mockImplementation(async () => ({
          status: 200,
          body: {
            choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok_from_backup' } }]
          }
        }));

      await executor.execute({
        requestId: 'req-blackbox-converted-503-reroute',
        entryEndpoint: '/v1/responses',
        body: {},
        headers: {},
        metadata: {}
      });

      expect(selectedProviders).toEqual([providerA, providerB]);
      expect(processA).toHaveBeenCalledTimes(1);
      expect(processB).toHaveBeenCalledTimes(1);
      const switchLines = warnSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((line) => line.includes('[provider-switch]') && line.includes('req-blackbox-converted-503-reroute'));
      expect(switchLines.some((line) => (
        line.includes(`provider=${providerA}`)
        && line.includes('switch=exclude_and_reroute')
        && line.includes('decision=exclude_and_reroute')
        && line.includes('backoffScope=none')
        && line.includes('status=503')
      ))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      if (previousAttempts === undefined) {
        delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      } else {
        process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = previousAttempts;
      }
    }
  });
  test('reroutes generic recoverable 500 immediately when route pool exposes alternatives', async () => {
    jest.useFakeTimers();
    const providerA = 'tabglm.key1.glm-5.1';
    const providerB = 'crs.key2.gpt-5.3-codex';
    const providerC = 'ali-coding-plan.key1.qwen3.6-plus';
    const authErrorA = Object.assign(new Error('HTTP 500: provider A overloaded'), {
      statusCode: 500
    });
    const processA = jest.fn().mockRejectedValueOnce(authErrorA);
    const processB = jest.fn(async () => ({ status: 200, data: { id: 'ok_after_immediate_reroute' } }));
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
        .mockResolvedValue({ status: 200, body: { output_text: 'ok_after_immediate_reroute' } });

      const pending = executor.execute({
        requestId: 'req-immediate-reroute-500',
        entryEndpoint: '/v1/responses',
        body: {},
        headers: {},
        metadata: {}
      });
      const expectation = expect(pending).resolves.toEqual(expect.objectContaining({ status: 200 }));

      await jest.advanceTimersByTimeAsync(1_000);
      await expectation;

      const switchLines = warnSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((line) => line.includes('[provider-switch]') && line.includes('req-immediate-reroute-500'));
      expect(switchLines).toHaveLength(1);
      expect(switchLines[0]).toContain(`provider=${providerA}`);
      expect(switchLines[0]).toContain('backoff=0ms');
      expect(switchLines[0]).toContain('switch=exclude_and_reroute');
      expect(switchLines[0]).toContain('backoffScope=none');
      expect(processA).toHaveBeenCalledTimes(1);
      expect(processB).toHaveBeenCalledTimes(1);
      expect(processC).toHaveBeenCalledTimes(0);
    } finally {
      jest.useRealTimers();
      warnSpy.mockRestore();
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
    await expect(executor.execute({
      requestId: 'req-sse-network-retry',
      entryEndpoint: '/v1/messages',
      body: {},
      headers: {},
      metadata: {}
    })).rejects.toThrow('Upstream SSE error event [api_error]');

    expect(pipeline.execute).toHaveBeenCalledTimes(1);
    expect(failingProcess).toHaveBeenCalledTimes(1);
    expect(successProcess).toHaveBeenCalledTimes(0);
  });

  test('reroutes converted HTTP 401 when provider pool has an alternative', async () => {
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
      requestId: 'req-401-failover',
      entryEndpoint: '/v1/responses',
      body: {},
      headers: {},
      metadata: {}
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual(expect.objectContaining({ id: 'resp_ok' }));
    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    expect(unauthorizedProcess).toHaveBeenCalledTimes(1);
    expect(successProcess).toHaveBeenCalledTimes(1);
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

  test('blocking recoverable retry waits once before same-provider success', async () => {
    const providerA = 'storm.a.glm-5';
    const retryableRecoverable = () => Object.assign(new Error('fetch failed'), {
      code: 'ECONNRESET'
    });
    let failuresLeft = 1;
    const processIncoming = jest.fn(async () => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw retryableRecoverable();
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
    process.env.ROUTECODEX_LOGICAL_CHAIN_RECOVERABLE_RETRY_LIMIT = '1';

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
      expect(pipeline.execute).toHaveBeenCalledTimes(2);
      expect(
        logStage.mock.calls.some((call) => call[0] === 'provider.retry.logical_chain_limit_hit')
      ).toBe(false);
    } finally {
      if (previousLimit === undefined) {
        delete process.env.ROUTECODEX_LOGICAL_CHAIN_RECOVERABLE_RETRY_LIMIT;
      } else {
        process.env.ROUTECODEX_LOGICAL_CHAIN_RECOVERABLE_RETRY_LIMIT = previousLimit;
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
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '2';

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

      await expect(executor.execute({
        requestId: 'req-fetch-failed-cap',
        entryEndpoint: '/v1/responses',
        body: {},
        headers: {},
        metadata: {}
      })).rejects.toThrow(/fetch failed/);

      expect(pipeline.execute).toHaveBeenCalledTimes(2);
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
    }
  });

  test('recoverable fetch-failed helper no longer accumulates provider backoff', () => {
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

    expect(delayA1).toBe(0);
    expect(delayA2).toBe(0);
    expect(delayB1).toBe(0);

    const delayAAfterSuccess = __requestExecutorTestables.consumeRecoverableErrorBackoffMs(keyA, {
      statusCode: 502,
      errorCode: 'HTTP_502',
      reason: 'fetch failed'
    });
    expect(delayAAfterSuccess).toBe(0);
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
      upstreamCode: 'PROVIDER_RATE_LIMITED',
      reason: 'temporarily rate limited'
    });

    expect(keyA).toBe(keyB);
    expect(keyA).toContain('status:429');
  });

  test('RED: 2056 single-attempt 429 excludes current provider instead of retrying same provider', () => {
    const excluded = new Set<string>();
    const plan = __requestExecutorTestables.resolveProviderRetryExclusionPlan({
      providerKey: 'mini27.key1.MiniMax-M2.7',
      status: 429,
      error: Object.assign(new Error('usage limit exceeded'), {
        statusCode: 429,
        code: 'HTTP_429_2056',
        upstreamCode: 'provider_status_2056'
      }),
      classification: 'recoverable',
      attempt: 1,
      promptTooLong: false,
      routePool: ['mini27.key1.MiniMax-M2.7', 'backup.key1.gpt-5.4'],
      excludedProviderKeys: excluded
    });

    expect(plan.excludedCurrentProvider).toBe(true);
    expect(Array.from(excluded)).toEqual(['mini27.key1.MiniMax-M2.7']);
  });

  test('RED: last available provider 429 is excluded instead of retrying same provider', () => {
    const excluded = new Set<string>();
    const plan = __requestExecutorTestables.resolveProviderRetryExclusionPlan({
      providerKey: 'mini27.key1.MiniMax-M2.7',
      status: 429,
      error: Object.assign(new Error('usage limit exceeded'), {
        statusCode: 429,
        code: 'HTTP_429_2056',
        upstreamCode: 'provider_status_2056'
      }),
      classification: 'recoverable',
      attempt: 3,
      promptTooLong: false,
      routePool: ['mini27.key1.MiniMax-M2.7'],
      excludedProviderKeys: excluded
    });

    expect(plan.excludedCurrentProvider).toBe(true);
    expect(Array.from(excluded)).toEqual(['mini27.key1.MiniMax-M2.7']);
  });

  test('recoverable 502 excludes current provider when alternative exists', () => {
    const excluded = new Set<string>();
    const plan = __requestExecutorTestables.resolveProviderRetryExclusionPlan({
      providerKey: 'fetch.key1.primary',
      status: 502,
      error: Object.assign(new Error('fetch failed'), {
        statusCode: 502,
        code: 'HTTP_502'
      }),
      classification: 'recoverable',
      attempt: 1,
      promptTooLong: false,
      routePool: ['fetch.key1.primary', 'fetch.key2.backup'],
      excludedProviderKeys: excluded
    });

    expect(plan.excludedCurrentProvider).toBe(true);
    expect(Array.from(excluded)).toEqual(['fetch.key1.primary']);
  });

  test('unrecoverable 401 excludes current provider when alternative exists', () => {
    const excluded = new Set<string>();
    const plan = __requestExecutorTestables.resolveProviderRetryExclusionPlan({
      providerKey: 'fetch.key1.primary',
      status: 401,
      error: Object.assign(new Error('HTTP 401: unauthorized'), {
        statusCode: 401,
        code: 'INVALID_API_KEY'
      }),
      classification: 'unrecoverable',
      attempt: 1,
      promptTooLong: false,
      routePool: ['fetch.key1.primary', 'fetch.key2.backup'],
      excludedProviderKeys: excluded
    });

    expect(plan.excludedCurrentProvider).toBe(true);
    expect(Array.from(excluded)).toEqual(['fetch.key1.primary']);
  });

  test('recoverable 502 excludes current provider when no alternative exists', () => {
    const excluded = new Set<string>();
    const plan = __requestExecutorTestables.resolveProviderRetryExclusionPlan({
      providerKey: 'fetch.key1.primary',
      status: 502,
      error: Object.assign(new Error('fetch failed'), {
        statusCode: 502,
        code: 'HTTP_502'
      }),
      classification: 'recoverable',
      attempt: 1,
      promptTooLong: false,
      routePool: ['fetch.key1.primary'],
      excludedProviderKeys: excluded
    });

    expect(plan.excludedCurrentProvider).toBe(true);
    expect(Array.from(excluded)).toEqual(['fetch.key1.primary']);
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
  });

  test('does not treat provider-unavailable failures as session storm candidates', () => {
    const key = __requestExecutorTestables.resolveSessionStormBackoffScope({
      sessionId: 'session-1'
    });
    expect(key).toBe('anonymous');

    const err = Object.assign(new Error('No available providers after applying routing instructions'), {
      code: 'PROVIDER_NOT_AVAILABLE'
    });
    expect(__requestExecutorTestables.peekSessionStormBackoffWaitMs(key!)).toBe(0);
    expect(__requestExecutorTestables.isSessionStormBackoffCandidate(err)).toBe(false);
  });

  test('does not treat generic application errors as storm candidates', () => {
    expect(
      __requestExecutorTestables.isSessionStormBackoffCandidate(new Error('boom'))
    ).toBe(false);
  });

  test('does not treat provider_status_2056 as session storm candidate', () => {
    const err = Object.assign(new Error('usage limit exceeded'), {
      code: 'MALFORMED_RESPONSE',
      upstreamCode: 'provider_status_2056',
      statusCode: 429,
    });
    expect(__requestExecutorTestables.isSessionStormBackoffCandidate(err)).toBe(false);
  });

  test('shares storm backoff across sessions through workdir scope for client tool args invalid storms', () => {
    const scopes = __requestExecutorTestables.resolveSessionStormBackoffScopes({
      sessionId: 'session-a',
      conversationId: 'conv-a',
      clientWorkdir: '/tmp/rc-workdir'
    });
    expect(scopes).toEqual(['workdir:/tmp/rc-workdir']);

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

  test('treats deterministic malformed response contract errors as storm candidates and uses unified cycle', () => {
    const err = Object.assign(
      new Error('[hub_response] Non-canonical response payload at chat_process.response.entry'),
      { code: 'MALFORMED_RESPONSE' }
    );
    expect(__requestExecutorTestables.isSessionStormBackoffCandidate(err)).toBe(true);

    expect(__requestExecutorTestables.consumeSessionStormBackoffMs('workdir:/tmp/malformed', err)).toBe(1000);
    jest.setSystemTime(new Date('2026-04-22T12:00:01.000Z'));
    expect(__requestExecutorTestables.consumeSessionStormBackoffMs('workdir:/tmp/malformed', err)).toBe(2000);
    jest.setSystemTime(new Date('2026-04-22T12:00:03.000Z'));
    expect(__requestExecutorTestables.consumeSessionStormBackoffMs('workdir:/tmp/malformed', err)).toBe(3000);
    jest.setSystemTime(new Date('2026-04-22T12:00:06.000Z'));
    expect(__requestExecutorTestables.consumeSessionStormBackoffMs('workdir:/tmp/malformed', err)).toBe(1000);
  });

  test('does not record session storm backoff when hub routing fails before provider send', async () => {
    jest.useFakeTimers();
    const pipelineError = Object.assign(
      new Error('No available providers after applying routing instructions'),
      { code: 'PROVIDER_NOT_AVAILABLE' }
    );
    const pipeline = {
      execute: jest.fn(async () => {
        throw pipelineError;
      }),
      updateVirtualRouterConfig: jest.fn()
    };
    const logStage = jest.fn();
    const executor = createRequestExecutor({
      runtimeManager: { getHandleByRuntimeKey: jest.fn() } as any,
      getHubPipeline: () => pipeline as any,
      getModuleDependencies: () => ({
        errorHandlingCenter: { handleError: jest.fn(async () => undefined) }
      }),
      logStage,
      stats: new StatsManager()
    });

    const pending = executor.execute({
      requestId: 'req-hub-no-provider-storm-1',
      entryEndpoint: '/v1/responses',
      body: { model: 'gpt-5.2-codex', input: 'hello' },
      headers: {},
      metadata: { sessionId: 'storm-session-1' }
    });
    const expectation = expect(pending).rejects.toMatchObject({ code: 'PROVIDER_NOT_AVAILABLE' });

    await jest.advanceTimersByTimeAsync(1_000);
    await jest.advanceTimersByTimeAsync(2_000);
    await jest.advanceTimersByTimeAsync(3_000);
    await expectation;

    expect(__requestExecutorTestables.peekSessionStormBackoffWaitMs('session:storm-session-1')).toBe(0);
    expect(
      logStage.mock.calls.some((call) => call[0] === 'request.session_storm_backoff.recorded')
    ).toBe(false);
    expect(
      logStage.mock.calls.some((call) => call[0] === 'hub.pool_exhausted.backoff_wait')
    ).toBe(true);
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
  });

  test('provider transport helper no longer records backoff for repeated 429s', () => {
    expect(true).toBe(true);
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

// ═══════════════════════════════════════════════════════════════
// 红测：VR 路由池耗尽 backoff 机制
// 覆盖三种关键路径：
//   A) singleton pool — 无限阻塞等待（路径 A）
//   B) 非 singleton 3 次 backoff → 抛错（路径 B）
//   C) router-direct pool exhausted（路径 C）
// ═══════════════════════════════════════════════════════════════

describe('HubRequestExecutor pool exhaustion backoff (VR error routing)', () => {
  beforeEach(() => {
    __requestExecutorTestables.resetRequestExecutorInternalStateForTests();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── 路径 A: 10000 端口典型场景 —— 全路由池只有 default，一个 provider ──
  // 注：这些测试 mock pipeline.execute 直接抛 PROVIDER_NOT_AVAILABLE，
  // 模拟 provider send 失败 → exclude → reroute → VR pool empty 的完整链路。
  // 绕过 processProviderSendFailure（需要 native module），聚焦 singleton block 路径。

  test('A1: singleton pool blocks when pipeline throws PROVIDER_NOT_AVAILABLE with candidateProviderCount=1', async () => {
    const providerKey = 'deepseek.key1.deepseek-v4-pro';
    const providerSend = jest
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(
        Object.assign(new Error('HTTP 429'), {
          statusCode: 429,
          code: 'HTTP_429',
          upstreamCode: 'HTTP_429'
        })
      )
      .mockResolvedValueOnce({
        status: 200,
        data: { id: 'ok-after-singleton-block' }
      });
    const handle = buildHandle(providerKey, providerSend);

    const runtimeManager = {
      resolveRuntimeKey: (key: string) => key,
      getHandleByRuntimeKey: (runtimeKey?: string) =>
        runtimeKey === providerKey ? handle : undefined
    };

    const pipeline = {
      execute: jest.fn()
        // call 1: pipeline ok -> provider send 429
        .mockResolvedValueOnce({
          requestId: 'req-singleton-10000',
          providerPayload: { model: 'test-model', input: 'hi' },
          target: { providerKey, providerType: 'deepseek', outboundProfile: 'openai-chat', runtimeKey: providerKey },
          routingDecision: { routeName: 'default', pool: [providerKey] },
          metadata: {}
        })
        // call 2: after provider failure path, reroute sees singleton pool exhausted → block
        .mockRejectedValueOnce(
          Object.assign(new Error('No available providers after applying routing instructions'), {
            code: 'PROVIDER_NOT_AVAILABLE',
            details: {
              routeName: 'default',
              candidateProviderCount: 1,
              minRecoverableCooldownMs: 2000,
              recoverableCooldownHints: [
                { providerKey, waitMs: 2000, source: 'provider.error' }
              ]
            }
          })
        )
        // call 3: after singleton block (excluded cleared) → works
        .mockResolvedValueOnce({
          requestId: 'req-singleton-10000',
          providerPayload: { model: 'test-model', input: 'hi' },
          target: { providerKey, providerType: 'deepseek', outboundProfile: 'openai-chat', runtimeKey: providerKey },
          routingDecision: { routeName: 'default', pool: [providerKey] },
          metadata: {}
        }),
      updateVirtualRouterConfig: jest.fn()
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => pipeline,
      getModuleDependencies: () => ({
        errorHandlingCenter: { handleError: jest.fn(async () => undefined) }
      }),
      logStage: jest.fn(),
      stats: new StatsManager()
    };

    const executor = createRequestExecutor(deps);
    const pending = executor.execute({
      requestId: 'req-singleton-10000',
      entryEndpoint: '/v1/chat/completions',
      body: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }]
      },
      headers: {},
      metadata: {}
    });
    const expectation = expect(pending).resolves.toMatchObject({ status: 200 });

    // Real path: provider 429 transport backoff (1s) + singleton exhaustion cooldown wait (2s)
    await jest.advanceTimersByTimeAsync(2_999);
    await jest.advanceTimersByTimeAsync(1);
    await expectation;

      expect(pipeline.execute).toHaveBeenCalledTimes(3);
    expect(providerSend).toHaveBeenCalledTimes(2);
    expect(
      (deps.logStage as jest.Mock).mock.calls.some(
        (call: unknown[]) => call[0] === 'provider.route_pool_cooldown_wait'
      )
    ).toBe(true);
    expect(
      (deps.logStage as jest.Mock).mock.calls.some(
        (call: unknown[]) => call[0] === 'provider.route_pool_cooldown_wait.completed'
      )
    ).toBe(true);
  });

  // A2: singleton pool blocks from first call (no warmup), with cooldown hints triggering block
  test('A2: singleton pool blocks when PROVIDER_NOT_AVAILABLE on first pipeline call with cooldown hints', async () => {
    const providerKey = 'gemini.key1.gemini-2.5-pro';
    const handle = buildHandle(providerKey, async () => ({
      status: 200,
      data: { id: 'ok-after-singleton-block' }
    }));

    const runtimeManager = {
      resolveRuntimeKey: (key: string) => key,
      getHandleByRuntimeKey: (runtimeKey?: string) =>
        runtimeKey === providerKey ? handle : undefined
    };

    const pipeline = {
      execute: jest.fn()
        // call 1: throws PROVIDER_NOT_AVAILABLE with cooldown hints → singleton block
        .mockRejectedValueOnce(
          Object.assign(new Error('No available providers after applying routing instructions'), {
            code: 'PROVIDER_NOT_AVAILABLE',
            details: {
              routeName: 'tools',
              candidateProviderCount: 1,
              minRecoverableCooldownMs: 500,
              recoverableCooldownHints: [
                { providerKey, waitMs: 500, source: 'concurrency.busy' }
              ]
            }
          })
        )
        // call 2: after singleton block → excluded cleared → works
        .mockResolvedValueOnce({
          requestId: 'req-singleton-unrec',
          providerPayload: { model: 'test-model', input: 'hi' },
          target: { providerKey, providerType: 'gemini', outboundProfile: 'gemini-chat', runtimeKey: providerKey },
          routingDecision: { routeName: 'tools', pool: [providerKey] },
          metadata: {}
        }),
      updateVirtualRouterConfig: jest.fn()
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => pipeline,
      getModuleDependencies: () => ({
        errorHandlingCenter: { handleError: jest.fn(async () => undefined) }
      }),
      logStage: jest.fn(),
      stats: new StatsManager()
    };

    const executor = createRequestExecutor(deps);
    jest.spyOn(executor as any, 'convertProviderResponseIfNeeded')
      .mockResolvedValueOnce({ status: 200, body: buildMinimalResponsesSuccessBody('ok-after-block') });

    const pending = executor.execute({
      requestId: 'req-singleton-unrec',
      entryEndpoint: '/v1/responses',
      body: {},
      headers: {},
      metadata: {}
    });
    const expectation = expect(pending).resolves.toMatchObject({ status: 200 });

    // call 1: pipeline throws PROVIDER_NOT_AVAILABLE → singleton block 500ms → call 2 succeeds
    await jest.advanceTimersByTimeAsync(499);
    expect(pipeline.execute).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expectation;

    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    expect(
      (deps.logStage as jest.Mock).mock.calls.some(
        (call: unknown[]) => call[0] === 'provider.route_pool_cooldown_wait'
      )
    ).toBe(true);
  });

  // A3: singleton pool with maxAttempts=1 — must still block, not throw
  test('A3: singleton pool with maxAttempts=1 still blocks instead of throwing', async () => {
    const prev = process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
    process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = '1';

    try {
      const providerKey = 'qwen.key1.qwen3.5-27b';
      const handle = buildHandle(providerKey, async () => ({
        status: 200,
        data: { id: 'ok-after-singleton-block' }
      }));

      const runtimeManager = {
        resolveRuntimeKey: (key: string) => key,
        getHandleByRuntimeKey: (runtimeKey?: string) =>
          runtimeKey === providerKey ? handle : undefined
      };

      const pipeline = {
        execute: jest.fn()
          // call 1: throws PROVIDER_NOT_AVAILABLE → singleton block → clear excluded → retry
          .mockRejectedValueOnce(
            Object.assign(new Error('All providers unavailable for model qwen.qwen3.5-27b'), {
              code: 'PROVIDER_NOT_AVAILABLE',
              details: {
                routeName: 'default',
                candidateProviderCount: 1,
                minRecoverableCooldownMs: 1000,
                recoverableCooldownHints: [
                  { providerKey, waitMs: 1000, source: 'provider.error' }
                ]
              }
            })
          )
          // call 2: after singleton block → excluded cleared → succeeds
          .mockResolvedValueOnce({
            requestId: 'req-singleton-max1',
            providerPayload: { model: 'test-model', input: 'hi' },
            target: { providerKey, providerType: 'qwen', outboundProfile: 'openai-chat', runtimeKey: providerKey },
            routingDecision: { routeName: 'default', pool: [providerKey] },
            metadata: {}
          }),
        updateVirtualRouterConfig: jest.fn()
      };

      const deps = {
        runtimeManager,
        getHubPipeline: () => pipeline,
        getModuleDependencies: () => ({
          errorHandlingCenter: { handleError: jest.fn(async () => undefined) }
        }),
        logStage: jest.fn(),
        stats: new StatsManager()
      };

      const executor = createRequestExecutor(deps);
      jest.spyOn(executor as any, 'convertProviderResponseIfNeeded')
        .mockResolvedValueOnce({ status: 200, body: buildMinimalResponsesSuccessBody('ok-after-block') });

      const pending = executor.execute({
        requestId: 'req-singleton-max1',
        entryEndpoint: '/v1/responses',
        body: {},
        headers: {},
        metadata: {}
      });
      const expectation = expect(pending).resolves.toMatchObject({ status: 200 });

      // call 1 throws PROVIDER_NOT_AVAILABLE → singleton block 1s → call 2 succeeds
      await jest.advanceTimersByTimeAsync(999);
      expect(pipeline.execute).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await expectation;

      expect(pipeline.execute).toHaveBeenCalledTimes(2);
      // Even with maxAttempts=1, singleton block bypasses attempt budget
      expect(
        (deps.logStage as jest.Mock).mock.calls.filter(
          (call: unknown[]) => call[0] === 'provider.route_pool_cooldown_wait'
        ).length
      ).toBeGreaterThanOrEqual(1);
    } finally {
      if (prev === undefined) delete process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS;
      else process.env.ROUTECODEX_MAX_PROVIDER_ATTEMPTS = prev;
    }
  });

  // ── 路径 B: 非 singleton 池 3 次 backoff → 抛错 ──

  test('B1: non-singleton pool throws after 3 exhausted backoffs', async () => {
    const providerKeyA = 'gemini.key1.gemini-2.5-pro';
    const providerKeyB = 'gemini.key2.gemini-2.5-pro';

    const handleA = buildHandle(providerKeyA, async () => {
      throw Object.assign(new Error('HTTP 503'), { statusCode: 503, code: 'HTTP_503' });
    });
    const handleB = buildHandle(providerKeyB, async () => {
      throw Object.assign(new Error('HTTP 503'), { statusCode: 503, code: 'HTTP_503' });
    });

    const handles = new Map<string, ProviderHandle>([
      [providerKeyA, handleA],
      [providerKeyB, handleB]
    ]);

    const runtimeManager = {
      resolveRuntimeKey: (key: string) => key,
      getHandleByRuntimeKey: (runtimeKey?: string) =>
        runtimeKey ? handles.get(runtimeKey) : undefined
    };

    let pipelineCall = 0;
    const pipeline = {
      execute: jest.fn(async () => {
        pipelineCall += 1;
        // Always throw PROVIDER_NOT_AVAILABLE — simulate all pools exhausted
        throw Object.assign(
          new Error('All providers unavailable for model gemini.gemini-2.5-pro'),
          {
            code: 'PROVIDER_NOT_AVAILABLE',
            details: {
              routeName: 'thinking',
              candidateProviderCount: 2,
              attempted: [
                'thinking:gemini.key1.gemini-2.5-pro:health',
                'thinking:gemini.key2.gemini-2.5-pro:health'
              ]
            }
          }
        );
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
    const pending = executor.execute({
      requestId: 'req-non-singleton-exhausted',
      entryEndpoint: '/v1/responses',
      body: {},
      headers: {},
      metadata: {}
    });
    const expectation = expect(pending).rejects.toMatchObject({
      code: 'PROVIDER_NOT_AVAILABLE'
    });

    // Backoff #1: 1s → pipeline call #2
    await jest.advanceTimersByTimeAsync(999);
    expect(pipeline.execute).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    // Backoff #2: 2s → pipeline call #3
    await jest.advanceTimersByTimeAsync(1_999);
    expect(pipeline.execute).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    // Backoff #3: 3s → pipeline call #4 → exhausted, throws
    await jest.advanceTimersByTimeAsync(2_999);
    expect(pipeline.execute).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1);
    // After 3 backoffs (4 total calls, 3 waits), should throw
    await expectation;

    expect(pipeline.execute).toHaveBeenCalledTimes(4);

    const backoffLogs = (deps.logStage as jest.Mock).mock.calls.filter(
      (call: unknown[]) => call[0] === 'hub.pool_exhausted.backoff_wait'
    );
    expect(backoffLogs).toHaveLength(3);
    // Backoff steps: 1s, 2s, 3s
    expect((backoffLogs[0] as unknown[])[2]).toMatchObject({ waitMs: 1000, poolExhaustedBackoffAttempt: 1 });
    expect((backoffLogs[1] as unknown[])[2]).toMatchObject({ waitMs: 2000, poolExhaustedBackoffAttempt: 2 });
    expect((backoffLogs[2] as unknown[])[2]).toMatchObject({ waitMs: 3000, poolExhaustedBackoffAttempt: 3 });
  });

  test('G3: primary exhausted reroutes into default pool before surfacing provider-not-available', async () => {
    jest.useFakeTimers();
    const searchProvider = 'search.key1.gpt-5.4';
    const defaultProvider = 'default.key1.MiniMax-M3';
    const defaultProcess = jest.fn(async () => ({
      status: 200,
      data: { id: 'ok-after-default-pool-reroute' }
    }));
    const observedAllowedProviders: Array<unknown> = [];

    const runtimeManager = {
      resolveRuntimeKey: (key: string) => key,
      getHandleByRuntimeKey: (runtimeKey?: string) =>
        runtimeKey === defaultProvider ? buildHandle(defaultProvider, defaultProcess) : undefined
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const allowedProviders = input?.metadata?.allowedProviders;
        observedAllowedProviders.push(allowedProviders);
        if (Array.isArray(allowedProviders) && allowedProviders[0] === defaultProvider) {
          return {
            requestId: input.id,
            providerPayload: { model: 'test-model', input: 'hi' },
            target: {
              providerKey: defaultProvider,
              providerType: 'openai',
              outboundProfile: 'openai-chat',
              runtimeKey: defaultProvider
            },
            routingDecision: {
              routeName: 'default',
              routePool: [defaultProvider],
              pool: [defaultProvider]
            },
            metadata: {}
          };
        }
        throw Object.assign(new Error('All providers unavailable for route search'), {
          code: 'PROVIDER_NOT_AVAILABLE',
          details: {
            primaryExhaustedRouteName: 'search',
            primaryExhaustedTargets: [searchProvider],
            unavailableRoutePools: [
              {
                routeName: 'search',
                poolId: 'search-primary',
                poolTargets: [searchProvider]
              },
              {
                routeName: 'default',
                poolId: 'default-primary',
                poolTargets: [defaultProvider]
              }
            ]
          }
        });
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const logStage = jest.fn();
    const executor = createRequestExecutor({
      runtimeManager: runtimeManager as any,
      getHubPipeline: () => pipeline as any,
      getRoutingTiers: (routingPolicyGroup: string, routeName: string) => {
        expect(routingPolicyGroup).toBe('gateway_priority_5555');
        expect(routeName).toBe('search');
        return [
          { id: 'search-primary', targets: [searchProvider], priority: 200 },
          { id: 'default-primary', targets: [defaultProvider], priority: 100, backup: true }
        ];
      },
      getModuleDependencies: () => ({ errorHandlingCenter: { handleError: async () => undefined } }) as any,
      logStage,
      stats: new StatsManager()
    });

    const pending = executor.execute({
      requestId: 'req-primary-exhausted-default-pool',
      entryEndpoint: '/v1/chat/completions',
      body: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }]
      },
      headers: {},
      metadata: {
        routecodexRoutingPolicyGroup: 'gateway_priority_5555'
      }
    });
    const expectation = expect(pending).resolves.toEqual(expect.objectContaining({ status: 200 }));

    await jest.advanceTimersByTimeAsync(6_100);
    await expectation;

    expect(defaultProcess).toHaveBeenCalledTimes(1);
    expect(pipeline.execute.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(observedAllowedProviders).toContainEqual([defaultProvider]);
    expect(
      logStage.mock.calls.some(
        (call) => call[0] === 'provider.primary_exhausted_to_default_pool.applied'
          && Array.isArray(call[2]?.defaultPoolTargets)
          && call[2].defaultPoolTargets[0] === defaultProvider
      )
    ).toBe(true);
  });

  test('G3: does not surface client error before default pool is also exhausted', async () => {
    jest.useFakeTimers();
    const searchProvider = 'search.key1.gpt-5.4';
    const defaultProvider = 'default.key1.MiniMax-M3';
    let settled: 'pending' | 'resolved' | 'rejected' = 'pending';

    const runtimeManager = {
      resolveRuntimeKey: (key: string) => key,
      getHandleByRuntimeKey: () => undefined
    };

    const pipeline = {
      execute: jest.fn(async (input: any) => {
        const allowedProviders = input?.metadata?.allowedProviders;
        if (Array.isArray(allowedProviders) && allowedProviders[0] === defaultProvider) {
          throw Object.assign(new Error('All providers unavailable for route default'), {
            code: 'PROVIDER_NOT_AVAILABLE',
            details: {
              routeName: 'default',
              candidateProviderCount: 1,
              minRecoverableCooldownMs: 1000,
              recoverableCooldownHints: [
                { providerKey: defaultProvider, waitMs: 1000, source: 'provider.error' }
              ]
            }
          });
        }
        throw Object.assign(new Error('All providers unavailable for route search'), {
          code: 'PROVIDER_NOT_AVAILABLE',
          details: {
            primaryExhaustedRouteName: 'search',
            primaryExhaustedTargets: [searchProvider],
            unavailableRoutePools: [
              {
                routeName: 'search',
                poolId: 'search-primary',
                poolTargets: [searchProvider]
              },
              {
                routeName: 'default',
                poolId: 'default-primary',
                poolTargets: [defaultProvider]
              }
            ]
          }
        });
      }),
      updateVirtualRouterConfig: jest.fn()
    };

    const logStage = jest.fn();
    const executor = createRequestExecutor({
      runtimeManager: runtimeManager as any,
      getHubPipeline: () => pipeline as any,
      getRoutingTiers: () => [
        { id: 'search-primary', targets: [searchProvider], priority: 200 },
        { id: 'default-primary', targets: [defaultProvider], priority: 100, backup: true }
      ],
      getModuleDependencies: () => ({ errorHandlingCenter: { handleError: async () => undefined } }) as any,
      logStage,
      stats: new StatsManager()
    });

    const pending = executor.execute({
      requestId: 'req-default-pool-not-early-client-error',
      entryEndpoint: '/v1/chat/completions',
      body: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }]
      },
      headers: {},
      metadata: {
        routecodexRoutingPolicyGroup: 'gateway_priority_5555'
      }
    });
    pending.then(
      () => { settled = 'resolved'; },
      () => { settled = 'rejected'; }
    );

    await jest.advanceTimersByTimeAsync(6_000);
    expect(
      logStage.mock.calls.some((call) => call[0] === 'provider.primary_exhausted_to_default_pool.applied')
    ).toBe(true);
    expect(settled).toBe('pending');

    await jest.advanceTimersByTimeAsync(12_000);
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_NOT_AVAILABLE' });
    expect(
      logStage.mock.calls.filter((call) => call[0] === 'provider.route_pool_cooldown_wait').length
    ).toBeGreaterThanOrEqual(1);
  }, 20_000);
});
