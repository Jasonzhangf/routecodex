import { jest } from '@jest/globals';
import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../../src/server/runtime/handlers/types.js';
import type { HubPipeline } from '../../../../src/server/runtime/http-server/types.js';
import type { ProviderHandle } from '../../../../src/server/runtime/http-server/types.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import { MetadataCenter } from '../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const mockRebindResponsesConversationRequestId = jest.fn(async () => {
  throw new Error('rebind failed');
});
const mockExecuteHubPipelineNative = jest.fn();

const mockBridgeModule = () => ({
  loadRoutingInstructionStateSync: () => null,
  saveRoutingInstructionStateAsync: () => {},
  saveRoutingInstructionStateSync: () => {},
  extractSessionIdentifiersFromMetadata: () => ({}),
  extractContinuationContextSessionIdentifiersFromMetadata: () => ({}),
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
  resolveBaseDir: jest.fn(),
  mapChatToolsToBridgeJson: jest.fn(async () => []),
  buildAnthropicResponseFromChatJson: jest.fn(async () => ({})),
  injectMcpToolsForChatJson: jest.fn(async () => []),
  injectMcpToolsForResponsesJson: jest.fn(async () => []),
  convertResponsesRequestToChatNative: jest.fn((payload: unknown) => ({ payload })),
  evaluateResponsesDirectRouteDecisionNative: jest.fn(async () => ({ mode: 'passthrough' })),
  hasDeclaredApplyPatchToolNative: jest.fn(() => false),
  projectSseErrorEventPayloadNative: jest.fn(() => ({})),
  classifyProviderFailure: jest.fn(() => ({ code: 'UNKNOWN', retryable: false })),
  getNetworkErrorCodes: jest.fn(() => []),
  deriveFinishReasonNative: jest.fn(() => undefined),
  importCoreDist: jest.fn(async (subpath?: string) => {
    if (!subpath || subpath === 'native/router-hotpath/native-shared-conversion-semantics') {
      return {
        normalizeResponsesToolCallArgumentsForClientWithNative: () => ({})
      };
    }
    return {};
  })
});

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);

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
  resolveBaseDir: jest.fn(() => process.cwd()),
});

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/routing-integrations.js', mockRoutingIntegrationsModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/routing-integrations.ts', mockRoutingIntegrationsModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/runtime-integrations.js', mockBridgeModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/runtime-integrations.ts', mockBridgeModule);


const mockProviderRequestContextModule = () => ({
  resolveProviderRequestContext: () => ({
    requestId: 'rebased_request_id',
    providerProtocol: 'openai-responses',
    providerModel: 'mimo-v2.5-pro',
    providerLabel: 'mimo.key1.mimo-v2.5-pro'
  })
});

jest.unstable_mockModule('../../../../src/server/runtime/http-server/executor/provider-request-context.js', mockProviderRequestContextModule);
jest.unstable_mockModule('../../../../src/server/runtime/http-server/executor/provider-request-context.ts', mockProviderRequestContextModule);

describe('HubRequestExecutor requestId rebind', () => {
  it('reroutes recoverable responses conversation requestId rebind failures when another provider remains in the route pool', async () => {
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

    const { HubRequestExecutor } = await import('../../../../src/server/runtime/http-server/request-executor.js');

    const processIncoming1 = jest.fn(async () => ({ ok: true }));
    const processIncoming2 = jest.fn(async () => ({ status: 200, body: { id: 'resp_ok' } }));
    const handle1: ProviderHandle = {
      providerType: 'gemini',
      providerFamily: 'gemini',
      providerId: 'mimo1',
      providerProtocol: 'openai-responses',
      runtime: {},
      instance: {
        processIncoming: processIncoming1,
        cleanup: jest.fn()
      }
    } as unknown as ProviderHandle;
    const handle2: ProviderHandle = {
      providerType: 'gemini',
      providerFamily: 'gemini',
      providerId: 'mimo2',
      providerProtocol: 'openai-responses',
      runtime: {},
      instance: {
        processIncoming: processIncoming2,
        cleanup: jest.fn()
      }
    } as unknown as ProviderHandle;

    const provider1 = 'mimo.key1';
    const provider2 = 'mimo.key2';
    const routePool = [provider1, provider2];

    const pipelineResult1: PipelineExecutionResult = {
      providerPayload: { data: { model: 'mimo-v2.5-pro', messages: [{ role: 'user', content: 'ping' }] } },
      target: {
        providerKey: provider1,
        providerType: 'gemini',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:key1',
        processMode: 'standard'
      },
      routingDecision: { routeName: 'default', pool: routePool, providerProtocol: 'openai-responses' } as any,
      processMode: 'standard',
      metadata: {}
    };
    const pipelineResult2: PipelineExecutionResult = {
      providerPayload: { data: { model: 'mimo-v2.5-pro', messages: [{ role: 'user', content: 'ping' }] } },
      target: {
        providerKey: provider2,
        providerType: 'gemini',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:key2',
        processMode: 'standard'
      },
      routingDecision: { routeName: 'default', pool: routePool, providerProtocol: 'openai-responses' } as any,
      processMode: 'standard',
      metadata: {}
    };

    mockExecuteHubPipelineNative
      .mockReturnValueOnce(pipelineResult1)
      .mockReturnValueOnce(pipelineResult2);
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
    jest.spyOn(executor as any, 'convertProviderResponseIfNeeded').mockResolvedValue({ status: 200, body: { ok: true } });

    const request: PipelineExecutionInput = {
      requestId: 'req_test',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: {
        model: 'mimo-v2.5-pro',
        input: [{ role: 'user', content: 'ping' }],
        messages: [{ role: 'user', content: 'ping' }]
      },
      metadata: { stream: false, inboundStream: false }
    };

    const result = await executor.execute(request);
    expect(result.usageLogInfo?.providerKey).toBe(provider2);
    expect(mockRebindResponsesConversationRequestId).toHaveBeenCalledTimes(2);
    expect(processIncoming1).not.toHaveBeenCalled();
    expect(processIncoming2).toHaveBeenCalledTimes(1);
    expect((deps.logStage as jest.Mock).mock.calls.some((call) => call[0] === 'responsesConversation.rebindRequestId.error')).toBe(true);
    expect((deps.logStage as jest.Mock).mock.calls.some(
      (call) => call[0] === 'provider.runtime_resolve.error' && call[1] === 'rebased_request_id'
    )).toBe(true);
  });

  it('passes serverToolsEnabled=false when nested followup metadata disables stopMessage', async () => {
    jest.resetModules();
    mockRebindResponsesConversationRequestId.mockImplementationOnce(async () => undefined);
    mockExecuteHubPipelineNative.mockReset();

    const { HubRequestExecutor } = await import('../../../../src/server/runtime/http-server/request-executor.js');

    const processIncoming = jest.fn(async () => ({ status: 200, data: { id: 'resp_nested_stop_disabled', object: 'response', output: [] } }));
    const handle: ProviderHandle = {
      providerType: 'openai',
      providerFamily: 'openai',
      providerId: 'cc',
      providerProtocol: 'openai-responses',
      runtime: {},
      instance: {
        processIncoming,
        cleanup: jest.fn()
      }
    } as unknown as ProviderHandle;

    const pipelineResult: PipelineExecutionResult = {
      providerPayload: { model: 'gpt-5.5', input: 'continue' },
      target: {
        providerKey: 'cc.key1.gpt-5.5',
        providerType: 'openai',
        outboundProfile: 'openai-responses',
        runtimeKey: 'runtime:cc',
        processMode: 'chat'
      },
      routingDecision: { routeName: 'thinking', pool: ['cc.key1.gpt-5.5'], providerProtocol: 'openai-responses' } as any,
      processMode: 'chat',
      metadata: {}
    };

    mockExecuteHubPipelineNative.mockReturnValue(pipelineResult);
    const fakePipeline = 'mock_hub_pipeline_handle' as unknown as HubPipeline;

    const deps = {
      runtimeManager: {
        resolveRuntimeKey: jest.fn().mockReturnValue('runtime:cc'),
        getHandleByRuntimeKey: jest.fn().mockReturnValue(handle)
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
    const metadata = {
      stream: false,
      inboundStream: false
    } as Record<string, unknown>;
    MetadataCenter.attach(metadata).writeRuntimeControl(
      'stopMessageEnabled',
      false,
      {
        module: 'tests/server/runtime/http-server/request-executor.rebind-failfast.spec.ts',
        symbol: 'nested_followup_test',
        stage: 'test_runtime_control'
      }
    );

    await executor.execute({
      requestId: 'req_nested_stop_disabled',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { model: 'gpt-5.5', input: [{ role: 'user', content: 'continue' }] },
      metadata
    });

    const responseConvertStartCall = (deps.logStage as jest.Mock).mock.calls.find(
      (call) => call[0] === 'provider.response_convert.start'
    );
    expect(responseConvertStartCall).toBeTruthy();
    expect(responseConvertStartCall?.[2]).toMatchObject({ serverToolsEnabled: false });
  });
});
