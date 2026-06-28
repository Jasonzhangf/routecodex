import { jest } from '@jest/globals';
import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../../src/server/runtime/handlers/types.js';
import type { HubPipeline, ProviderHandle } from '../../../../src/server/runtime/http-server/types.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';

const mockRebindResponsesConversationRequestId = jest.fn(async () => undefined);

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
  getHubPipelineCtor: jest.fn(),
  getHubPipelineCtorForImpl: jest.fn(),
  resolveBaseDir: jest.fn(),
  mapChatToolsToBridgeJson: jest.fn(async () => []),
  buildAnthropicResponseFromChatJson: jest.fn(async () => ({})),
  injectMcpToolsForChatJson: jest.fn(async () => []),
  injectMcpToolsForResponsesJson: jest.fn(async () => []),
  deriveFinishReasonNative: jest.fn(() => undefined),
  importCoreDist: jest.fn(async (subpath?: string) => {
    if (subpath === 'native/router-hotpath/native-hub-pipeline-resp-semantics') {
      return {
        normalizeResponsesToolCallArgumentsForClientWithNative: () => ({})
      };
    }
    return {};
  })
});

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);

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
      instance: { processIncoming: processIncoming1, cleanup: jest.fn() }
    } as unknown as ProviderHandle;
    const handle2: ProviderHandle = {
      providerType: 'openai',
      providerFamily: 'openai',
      providerId: 'p2',
      providerProtocol: 'openai-responses',
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
      routingDecision: { routeName: 'default', pool: routePool } as any,
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
      routingDecision: { routeName: 'default', pool: routePool } as any,
      processMode: 'standard',
      metadata: {}
    };

    const fakePipeline: HubPipeline = {
      execute: jest.fn()
        .mockResolvedValueOnce(firstResult)
        .mockResolvedValueOnce(secondResult)
    };

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
      body: { model: 'gpt-5.4', input: 'ping' },
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
});
