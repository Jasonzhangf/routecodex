import { jest } from '@jest/globals';
import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../../src/server/runtime/handlers/types.js';
import type { HubPipeline, ProviderHandle } from '../../../../src/server/runtime/http-server/types.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';

const mockRebindResponsesConversationRequestId = jest.fn(async () => undefined);
const mockExecuteHubPipelineNative = jest.fn();

const mockBridgeModule = () => ({
  loadRoutingInstructionStateSync: () => null,
  saveRoutingInstructionStateAsync: () => {},
  saveRoutingInstructionStateSync: () => {},
  extractSessionIdentifiersFromMetadata: () => ({}),
  rebindResponsesConversationRequestId: mockRebindResponsesConversationRequestId,
  captureResponsesRequestContextForRequest: jest.fn(async () => undefined),
  clearResponsesConversationByRequestId: jest.fn(async () => undefined),
  syncReasoningStopModeFromRequest: () => 'off',
  sanitizeFollowupText: async (raw: unknown) => (typeof raw === 'string' ? raw : ''),
  createSnapshotRecorder: jest.fn(async () => ({ record: () => {} })),
  convertProviderResponse: jest.fn(async () => ({ body: { ok: true } })),
  writeSnapshotViaHooks: jest.fn(async () => {}),
  preloadCriticalBridgeRuntimeModules: jest.fn(async () => ({ loaded: [] })),
  resumeResponsesConversation: jest.fn(async () => ({ payload: {}, meta: {} })),
  resumeLatestResponsesContinuationByScope: jest.fn(async () => null),
  createResponsesSseToJsonConverter: jest.fn(async () => ({ convertSseToJson: async () => ({}) })),
  resolveRelayResponsesClientSseStreamForHttp: jest.fn(async () => undefined),
  reprojectDirectChatToolCallStreamForHttp: jest.fn(async () => undefined),
  reportProviderErrorToRouterPolicy: jest.fn(async (event: unknown) => event),
  reportProviderSuccessToRouterPolicy: jest.fn(async (event: unknown) => event),
  bootstrapVirtualRouterConfig: jest.fn(),
  createHubPipelineNative: jest.fn(() => 'mock_hub_pipeline_handle'),
  executeHubPipelineNative: jest.fn(async () => ({ metadata: {} })),
  updateHubPipelineVirtualRouterConfigNative: jest.fn(),
  updateHubPipelineEngineDepsNative: jest.fn(),
  routeHubPipelineVirtualRouterNative: jest.fn(async () => ({ diagnostics: {} })),
  diagnoseHubPipelineVirtualRouterNative: jest.fn(async () => ({ diagnostics: {} })),
  getHubPipelineVirtualRouterStatusNative: jest.fn(async () => ({})),
  markHubPipelineVirtualRouterConcurrencyScopeBusyNative: jest.fn(),
  disposeHubPipelineNative: jest.fn(),
  mapChatToolsToBridgeJson: jest.fn(async () => []),
  buildAnthropicResponseFromChatJson: jest.fn(async () => ({})),
  injectMcpToolsForChatJson: jest.fn(async () => []),
  injectMcpToolsForResponsesJson: jest.fn(async () => []),
  convertResponsesRequestToChatNative: jest.fn((payload: unknown) => ({ payload })),
  evaluateResponsesDirectRouteDecisionNative: jest.fn(async () => ({ mode: 'passthrough' })),
  projectSseErrorEventPayloadNative: jest.fn(() => ({})),
  classifyProviderFailure: jest.fn(() => ({ code: 'UNKNOWN', retryable: false })),
  deriveFinishReasonNative: jest.fn(() => undefined),
});

const mockRoutingIntegrationsModule = () => ({
  bootstrapVirtualRouterConfig: jest.fn(async (input: unknown) => ({ config: input, runtime: {}, targetRuntime: {} })),
  compileRouteCodexRuntimeManifest: jest.fn(async () => ({
    manifestVersion: 'routecodex.runtime-config.v1',
    virtualRouterBootstrapInput: {},
    pipelineRuntimeConfig: {}
  })),
  compileRouteCodexRuntimeManifestSync: jest.fn(() => ({
    manifestVersion: 'routecodex.runtime-config.v1',
    virtualRouterBootstrapInput: {},
    pipelineRuntimeConfig: {}
  })),
  collectRouteCodexV2ConfigSourceErrorsSync: jest.fn(() => []),
  normalizeRouteCodexV2RuntimeSourceSync: jest.fn((input: unknown) => input ?? {}),
  resolvePrimaryRouteCodexRoutingPolicyGroupSync: jest.fn(() => 'default'),
  extractRouteCodexMaterializedProviderConfigsSync: jest.fn(() => null),
  materializeRouteCodexUserConfigFromManifestSync: jest.fn((userConfig: unknown) => userConfig ?? {}),
  buildRouteCodexProviderProfilesSync: jest.fn(() => ({})),
  buildRouteCodexForwarderProfilesSync: jest.fn(() => ({})),
  parseRouteCodexTomlRecord: jest.fn(async () => ({})),
  parseRouteCodexTomlRecordSync: jest.fn(() => ({})),
  serializeRouteCodexTomlRecord: jest.fn(async () => ''),
  serializeRouteCodexTomlRecordSync: jest.fn(() => ''),
  updateRouteCodexTomlStringScalarInTable: jest.fn(async (input: any) => input?.raw ?? ''),
  updateRouteCodexTomlStringScalarInTableSync: jest.fn((input: any) => input?.raw ?? ''),
  decodeRouteCodexUserConfigTextSync: jest.fn(() => ({ format: 'toml', parsed: {} })),
  decodeRouteCodexProviderConfigTextSync: jest.fn(() => ({ format: 'toml', parsed: {} })),
  detectRouteCodexUserConfigFormatSync: jest.fn(() => 'toml'),
  detectRouteCodexProviderConfigFormatSync: jest.fn(() => 'toml'),
  writeRouteCodexUserConfigFileNativeSync: jest.fn((input: any) => ({
    path: input?.configPath ?? '',
    format: 'toml',
    raw: '',
    parsed: input?.parsed ?? {}
  })),
  writeRouteCodexProviderConfigFileNativeSync: jest.fn((input: any) => ({
    path: input?.configPath ?? '',
    format: 'toml',
    raw: '',
    parsed: input?.parsed ?? {}
  })),
  updateRouteCodexUserConfigStringScalarNativeSync: jest.fn((input: any) => ({
    path: input?.configPath ?? '',
    format: 'toml',
    raw: '',
    parsed: {}
  })),
  loadRouteCodexConfigNativeSync: jest.fn(() => ({ configPath: '', userConfig: {}, providerProfiles: {} })),
  coerceRouteCodexProviderConfigV2: jest.fn(async (parsed: unknown) => parsed ?? null),
  coerceRouteCodexProviderConfigV2Sync: jest.fn((parsed: unknown) => parsed ?? null),
  planRouteCodexProviderConfigV2FilesSync: jest.fn(() => []),
  resolveRouteCodexProviderConfigV2IdentitySync: jest.fn((input: any) => ({ providerId: input?.dirId ?? 'provider', provider: input?.provider ?? {} })),
  loadRouteCodexProviderConfigsV2FromRootSync: jest.fn(() => ({})),
  planAuthFileResolutionNativeSync: jest.fn((input: any) => ({ kind: 'literal', value: input?.keyId ?? '', cacheKey: input?.keyId ?? '' })),
  resolveAuthFileKeyNativeSync: jest.fn((input: any) => ({ kind: 'literal', value: input?.keyId ?? '', cacheKey: input?.keyId ?? '' })),
  planProviderConfigRootNativeSync: jest.fn((rootDir?: string) => ({ rootDir })),
  planRouteCodexConfigLoaderPathsNativeSync: jest.fn((input: any) => ({ explicitPath: input?.explicitPath, providerRootDir: input?.routecodexProviderDir ?? input?.rccProviderDir })),
  resolveRouteCodexConfigPathNativeSync: jest.fn(() => ''),
  resolveRccUserDirNativeSync: jest.fn(() => '/tmp/.rcc'),
  resolveRccPathNativeSync: jest.fn((segments: string[] = []) => ['/tmp/.rcc', ...segments].join('/')),
  resolveRccSnapshotsDirNativeSync: jest.fn(() => '/tmp/.rcc/snapshots'),
  createHubPipelineNative: jest.fn(() => 'mock_hub_pipeline_handle'),
  executeHubPipelineNative: mockExecuteHubPipelineNative,
  updateHubPipelineVirtualRouterConfigNative: jest.fn(),
  updateHubPipelineEngineDepsNative: jest.fn(),
  routeHubPipelineVirtualRouterNative: jest.fn(async () => ({ diagnostics: {} })),
  diagnoseHubPipelineVirtualRouterNative: jest.fn(async () => ({ diagnostics: {} })),
  getHubPipelineVirtualRouterStatusNative: jest.fn(async () => ({})),
  markHubPipelineVirtualRouterConcurrencyScopeBusyNative: jest.fn(),
  markHubPipelineVirtualRouterConcurrencyScopeIdleNative: jest.fn(),
  disposeHubPipelineNative: jest.fn(),
});

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/routing-integrations.js', mockRoutingIntegrationsModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/runtime-integrations.js', mockBridgeModule);

const mockProviderRequestContextModule = () => ({
  resolveProviderRequestContext: ({ target }: { target?: { providerKey?: string } }) => ({
    requestId: `rebased_${target?.providerKey ?? 'unknown'}`,
    providerProtocol: 'openai-responses',
    providerModel: `${target?.providerKey ?? 'unknown'}-model`,
    providerLabel: `${target?.providerKey ?? 'unknown'}-label`
  })
});

jest.unstable_mockModule('../../../../src/server/runtime/http-server/executor/provider-request-context.js', mockProviderRequestContextModule);
jest.unstable_mockModule('../../../../src/server/runtime/http-server/executor/provider-request-context.ts', mockProviderRequestContextModule);

describe('HubRequestExecutor pre-send failure reroute', () => {
  it('reroutes recoverable rebind failures instead of surfacing them before the route pool is exhausted', async () => {
    jest.resetModules();
    mockRebindResponsesConversationRequestId.mockReset();
    mockExecuteHubPipelineNative.mockReset();
    mockRebindResponsesConversationRequestId
      .mockRejectedValueOnce(Object.assign(new Error('rebind failed'), {
        code: 'HTTP_502',
        upstreamCode: 'HTTP_502',
        status: 502,
        statusCode: 502
      }))
      .mockResolvedValueOnce(undefined);

    const { HubRequestExecutor, __requestExecutorTestables } = await import(
      '../../../../src/server/runtime/http-server/request-executor.js'
    );
    __requestExecutorTestables.resetRequestExecutorInternalStateForTests();

    const processIncoming1 = jest.fn(async () => ({ status: 200, data: { id: 'resp_should_not_happen' } }));
    const processIncoming2 = jest.fn(async () => ({ status: 200, body: { id: 'resp_ok' } }));
    const handle1: ProviderHandle = {
      providerType: 'openai',
      providerFamily: 'openai',
      providerId: 'p1',
      providerProtocol: 'openai-responses',
      runtime: {},
      instance: { processIncoming: processIncoming1, cleanup: jest.fn() }
    } as unknown as ProviderHandle;
    const handle2: ProviderHandle = {
      providerType: 'openai',
      providerFamily: 'openai',
      providerId: 'p2',
      providerProtocol: 'openai-responses',
      runtime: {},
      instance: { processIncoming: processIncoming2, cleanup: jest.fn() }
    } as unknown as ProviderHandle;

    const provider1 = 'openai.key1.gpt-5.4';
    const provider2 = 'openai.key2.gpt-5.4';
    const routePool = [provider1, provider2];

    const firstResult: PipelineExecutionResult = {
      providerPayload: { model: 'gpt-5.4', input: 'ping1' },
      target: {
        providerKey: provider1,
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:key1',
        processMode: 'standard'
      },
      routingDecision: { routeName: 'default', pool: routePool, providerProtocol: 'openai-responses' } as any,
      processMode: 'standard',
      metadata: {}
    };
    const secondResult: PipelineExecutionResult = {
      providerPayload: { model: 'gpt-5.4', input: 'ping2' },
      target: {
        providerKey: provider2,
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:key2',
        processMode: 'standard'
      },
      routingDecision: { routeName: 'default', pool: routePool, providerProtocol: 'openai-responses' } as any,
      processMode: 'standard',
      metadata: {}
    };

    mockExecuteHubPipelineNative
      .mockReturnValueOnce(firstResult)
      .mockReturnValueOnce(secondResult);
    const fakePipeline = 'mock_hub_pipeline_handle' as unknown as HubPipeline;

    const deps = {
      runtimeManager: {
        resolveRuntimeKey: jest.fn((providerKey?: string) => (
          providerKey === provider1 ? 'runtime:key1' : 'runtime:key2'
        )),
        getHandleByRuntimeKey: jest.fn((runtimeKey?: string) => (
          runtimeKey === 'runtime:key1' ? handle1 : handle2
        ))
      },
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies => ({
        errorHandlingCenter: {
          handleError: jest.fn().mockResolvedValue({ success: true })
        }
      } as unknown as ModuleDependencies),
      logStage: jest.fn(),
      stats: {
        recordRequestStart: jest.fn(),
        recordCompletion: jest.fn(),
        bindProvider: jest.fn(),
        recordToolUsage: jest.fn()
      }
    };

    const executor = new HubRequestExecutor(deps as any);
    jest.spyOn(executor as any, 'convertProviderResponseIfNeeded').mockResolvedValue({
      status: 200,
      body: { id: 'resp_ok', object: 'response', output: [] }
    });

    const request: PipelineExecutionInput = {
      requestId: 'req_pre_send_reroute',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { model: 'gpt-5.4', input: [{ role: 'user', content: 'ping' }] },
      metadata: { stream: false, inboundStream: false }
    };

    const result = await executor.execute(request);

    expect(result.usageLogInfo?.providerKey).toBe(provider2);
    expect(processIncoming1).not.toHaveBeenCalled();
    expect(processIncoming2).toHaveBeenCalledTimes(1);
    expect(mockRebindResponsesConversationRequestId).toHaveBeenCalledTimes(2);
    expect((deps.logStage as jest.Mock).mock.calls.some(
      (call) => call[0] === 'provider.runtime_resolve.error' && call[1] === 'rebased_openai.key1.gpt-5.4'
    )).toBe(true);
  });

  it('rebinds Responses conversation from the last provider id after provider send reroute', async () => {
    jest.resetModules();
    mockRebindResponsesConversationRequestId.mockReset();
    mockExecuteHubPipelineNative.mockReset();
    mockRebindResponsesConversationRequestId.mockResolvedValue(undefined);

    const { HubRequestExecutor, __requestExecutorTestables } = await import(
      '../../../../src/server/runtime/http-server/request-executor.js'
    );
    __requestExecutorTestables.resetRequestExecutorInternalStateForTests();

    const processIncoming1 = jest.fn(async () => {
      throw Object.assign(new Error('fetch failed'), {
        code: 'ECONNRESET',
        upstreamCode: 'ECONNRESET',
        status: 502,
        statusCode: 502,
        retryable: true,
        requestExecutorProviderErrorStage: 'provider.send'
      });
    });
    const processIncoming2 = jest.fn(async () => ({ status: 200, body: { id: 'resp_ok' } }));
    const handle1: ProviderHandle = {
      providerType: 'openai',
      providerFamily: 'openai',
      providerId: 'p1',
      providerProtocol: 'openai-responses',
      runtime: {},
      instance: { processIncoming: processIncoming1, cleanup: jest.fn() }
    } as unknown as ProviderHandle;
    const handle2: ProviderHandle = {
      providerType: 'openai',
      providerFamily: 'openai',
      providerId: 'p2',
      providerProtocol: 'openai-responses',
      runtime: {},
      instance: { processIncoming: processIncoming2, cleanup: jest.fn() }
    } as unknown as ProviderHandle;

    const provider1 = 'openai.key1.gpt-5.4';
    const provider2 = 'openai.key2.gpt-5.4';
    const routePool = [provider1, provider2];

    const firstResult: PipelineExecutionResult = {
      providerPayload: { model: 'gpt-5.4', input: 'ping1' },
      target: {
        providerKey: provider1,
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:key1',
        processMode: 'standard'
      },
      routingDecision: { routeName: 'default', pool: routePool, providerProtocol: 'openai-responses' } as any,
      processMode: 'standard',
      metadata: {}
    };
    const secondResult: PipelineExecutionResult = {
      providerPayload: { model: 'gpt-5.4', input: 'ping2' },
      target: {
        providerKey: provider2,
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:key2',
        processMode: 'standard'
      },
      routingDecision: { routeName: 'default', pool: routePool, providerProtocol: 'openai-responses' } as any,
      processMode: 'standard',
      metadata: {}
    };

    mockExecuteHubPipelineNative
      .mockReturnValueOnce(firstResult)
      .mockReturnValueOnce(secondResult);
    const fakePipeline = 'mock_hub_pipeline_handle' as unknown as HubPipeline;

    const deps = {
      runtimeManager: {
        resolveRuntimeKey: jest.fn((providerKey?: string) => (
          providerKey === provider1 ? 'runtime:key1' : 'runtime:key2'
        )),
        getHandleByRuntimeKey: jest.fn((runtimeKey?: string) => (
          runtimeKey === 'runtime:key1' ? handle1 : handle2
        ))
      },
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies => ({
        errorHandlingCenter: {
          handleError: jest.fn().mockResolvedValue({ success: true })
        }
      } as unknown as ModuleDependencies),
      logStage: jest.fn(),
      stats: {
        recordRequestStart: jest.fn(),
        recordCompletion: jest.fn(),
        bindProvider: jest.fn(),
        recordToolUsage: jest.fn()
      }
    };

    const executor = new HubRequestExecutor(deps as any);
    jest.spyOn(executor as any, 'convertProviderResponseIfNeeded').mockResolvedValue({
      status: 200,
      body: { id: 'resp_ok', object: 'response', output: [] }
    });

    const request: PipelineExecutionInput = {
      requestId: 'req_provider_send_reroute',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { model: 'gpt-5.4', input: [{ role: 'user', content: 'ping' }] },
      metadata: { stream: false, inboundStream: false }
    };

    const result = await executor.execute(request);

    expect(result.usageLogInfo?.providerKey).toBe(provider2);
    expect(processIncoming1).toHaveBeenCalledTimes(1);
    expect(processIncoming2).toHaveBeenCalledTimes(1);
    expect(mockRebindResponsesConversationRequestId).toHaveBeenNthCalledWith(
      1,
      'req_provider_send_reroute',
      'rebased_openai.key1.gpt-5.4'
    );
    expect(mockRebindResponsesConversationRequestId).toHaveBeenNthCalledWith(
      2,
      'rebased_openai.key1.gpt-5.4',
      'rebased_openai.key2.gpt-5.4'
    );
  });
});
