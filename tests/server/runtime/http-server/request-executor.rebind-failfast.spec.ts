import { jest } from '@jest/globals';
import type { PipelineExecutionInput, PipelineExecutionResult } from '../../../../src/server/runtime/handlers/types.js';
import type { HubPipeline } from '../../../../src/server/runtime/http-server/types.js';
import type { ProviderHandle } from '../../../../src/server/runtime/http-server/types.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';

const mockRebindResponsesConversationRequestId = jest.fn(async () => {
  throw new Error('rebind failed');
});

const mockBridgeModule = () => ({
  loadRoutingInstructionStateSync: () => null,
  saveRoutingInstructionStateAsync: () => {},
  saveRoutingInstructionStateSync: () => {},
  extractSessionIdentifiersFromMetadata: () => ({}),
  rebindResponsesConversationRequestId: mockRebindResponsesConversationRequestId,
  syncReasoningStopModeFromRequest: () => 'off',
  sanitizeFollowupText: async (raw: unknown) => (typeof raw === 'string' ? raw : ''),
  createSnapshotRecorder: jest.fn(async () => ({ record: () => {} })),
  convertProviderResponse: jest.fn(async () => ({ body: { ok: true } })),
  writeSnapshotViaHooks: jest.fn(async () => {}),
  preloadCriticalBridgeRuntimeModules: jest.fn(async () => ({ loaded: [] })),
  resumeResponsesConversation: jest.fn(async () => ({ payload: {}, meta: {} })),
  resumeLatestResponsesContinuationByScope: jest.fn(async () => null),
  createResponsesSseToJsonConverter: jest.fn(async () => ({ convertSseToJson: async () => ({}) })),
  reportProviderErrorToRouterPolicy: jest.fn(async (event: unknown) => event),
  reportProviderSuccessToRouterPolicy: jest.fn(async (event: unknown) => event),
  setProviderRuntimeQuotaHooks: jest.fn(async () => {}),
  setProviderRuntimeProviderQuotaHooks: jest.fn(async () => {}),
  resolveClockConfigSnapshot: jest.fn(async () => null),
  startClockDaemonIfNeededSnapshot: jest.fn(async () => false),
  setClockRuntimeHooksSnapshot: jest.fn(async () => false),
  buildHeartbeatInjectTextSnapshot: jest.fn(async () => null),
  resolveHeartbeatConfigSnapshot: jest.fn(async () => null),
  startHeartbeatDaemonIfNeededSnapshot: jest.fn(async () => false),
  setHeartbeatRuntimeHooksSnapshot: jest.fn(async () => false),
  loadHeartbeatStateSnapshot: jest.fn(async () => null),
  listHeartbeatStatesSnapshot: jest.fn(async () => []),
  listHeartbeatHistorySnapshot: jest.fn(async () => []),
  appendHeartbeatHistoryEventSnapshot: jest.fn(async () => false),
  setHeartbeatEnabledSnapshot: jest.fn(async () => null),
  runHeartbeatDaemonTickSnapshot: jest.fn(async () => false),
  reserveClockDueTasks: jest.fn(async () => ({ reservation: null })),
  commitClockDueReservation: jest.fn(async () => {}),
  listClockSessionIdsSnapshot: jest.fn(async () => []),
  listClockTasksSnapshot: jest.fn(async () => []),
  scheduleClockTasksSnapshot: jest.fn(async () => []),
  updateClockTaskSnapshot: jest.fn(async () => null),
  cancelClockTaskSnapshot: jest.fn(async () => false),
  clearClockTasksSnapshot: jest.fn(async () => 0),
  bootstrapVirtualRouterConfig: jest.fn(),
  getHubPipelineCtor: jest.fn(),
  getHubPipelineCtorForImpl: jest.fn(),
  resolveBaseDir: jest.fn(),
  mapChatToolsToBridgeJson: jest.fn(async () => []),
  buildAnthropicResponseFromChatJson: jest.fn(async () => ({})),
  injectMcpToolsForChatJson: jest.fn(async () => []),
  injectMcpToolsForResponsesJson: jest.fn(async () => [])
});

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);


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
  it('fails fast when responses conversation requestId rebind fails', async () => {
    jest.resetModules();
    mockRebindResponsesConversationRequestId.mockClear();

    const { HubRequestExecutor } = await import('../../../../src/server/runtime/http-server/request-executor.js');

    const processIncoming = jest.fn(async () => ({ ok: true }));
    const handle: ProviderHandle = {
      providerType: 'gemini',
      providerFamily: 'gemini',
      providerId: 'mimo',
      providerProtocol: 'openai-responses',
      instance: {
        processIncoming,
        cleanup: jest.fn()
      }
    } as unknown as ProviderHandle;

    const pipelineResult: PipelineExecutionResult = {
      providerPayload: { data: { model: 'mimo-v2.5-pro', messages: [{ role: 'user', content: 'ping' }] } },
      target: {
        providerKey: 'mimo.key1',
        providerType: 'gemini',
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

    const deps = {
      runtimeManager: {
        resolveRuntimeKey: jest.fn().mockReturnValue('runtime:key'),
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
    jest.spyOn(executor as any, 'convertProviderResponseIfNeeded').mockResolvedValue({ status: 200, body: { ok: true } });

    const request: PipelineExecutionInput = {
      requestId: 'req_test',
      entryEndpoint: '/v1/responses',
      headers: {},
      body: { model: 'mimo-v2.5-pro', messages: [{ role: 'user', content: 'ping' }] },
      metadata: { stream: false, inboundStream: false }
    };

    await expect(executor.execute(request)).rejects.toThrow('rebind failed');
    expect(mockRebindResponsesConversationRequestId).toHaveBeenCalledTimes(1);
    expect(processIncoming).not.toHaveBeenCalled();
    expect((deps.logStage as jest.Mock).mock.calls.some((call) => call[0] === 'responsesConversation.rebindRequestId.error')).toBe(true);
  });
});
