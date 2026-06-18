import { describe, expect, it, jest } from '@jest/globals';
import { createBridgeHttpServerMock } from '../../../../helpers/bridge-http-server-mock.js';
import { MetadataCenter } from '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const mockConvertProviderResponse = jest.fn();
const mockCreateSnapshotRecorder = jest.fn(async () => ({ record: () => {} }));
const mockPersistStoplessGoalStateSnapshot = jest.fn();
const mockSyncReasoningStopModeFromRequest = jest.fn(() => 'off');
const mockSyncStoplessGoalStateFromRequest = jest.fn(() => ({ stateKey: 'session:goal-followup-http400', hadDirective: false, directiveTypes: [] }));
const mockLoadRoutingInstructionStateSync = jest.fn(() => null);
const mockRequireCoreDist = jest.fn(() => ({
  normalizeResponsesToolCallArgumentsForClientWithNative: () => ({}),
}));
const mockImportCoreDist = jest.fn(async () => ({
  normalizeResponsesToolCallArgumentsForClientWithNative: (payload: unknown) =>
    (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>,
}));
const mockReadStoplessGoalState = jest.fn((adapterContext: Record<string, unknown>) => {
  const sessionId = typeof adapterContext?.sessionId === 'string' ? adapterContext.sessionId : undefined;
  return {
    ...(sessionId ? { stateKey: `session:${sessionId}` } : {}),
    state: mockLoadRoutingInstructionStateSync(sessionId ? `session:${sessionId}` : '')?.stoplessGoalState,
  };
});

const mockBridgeModule = () => createBridgeHttpServerMock({
  convertProviderResponse: mockConvertProviderResponse,
  createSnapshotRecorder: mockCreateSnapshotRecorder,
  syncReasoningStopModeFromRequest: mockSyncReasoningStopModeFromRequest,
  syncStoplessGoalStateFromRequest: mockSyncStoplessGoalStateFromRequest,
  persistStoplessGoalStateSnapshot: mockPersistStoplessGoalStateSnapshot,
  loadRoutingInstructionStateSync: mockLoadRoutingInstructionStateSync,
  readStoplessGoalState: mockReadStoplessGoalState,
  requireCoreDist: mockRequireCoreDist,
  importCoreDist: mockImportCoreDist,
  updateResponsesContractProbeFromSseChunkNative: () => ({}),
  buildResponsesTerminalSseFramesFromProbeNative: () => [],
  resolveRelayResponsesClientSseStreamForHttp: () => undefined,
  sanitizeFollowupText: async (raw: unknown) => (typeof raw === 'string' ? raw : ''),
});

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);

function buildBaseOptions(pipelineMetadata: Record<string, unknown>, requestId = 'req_goal_followup'): any {
  return {
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses',
    requestId,
    wantsStream: true,
    processMode: 'standard',
    requestSemantics: {
      __routecodex: {
        serverToolFollowup: true,
        serverToolFollowupSource: 'servertool.stop_message_auto',
      },
    },
    originalRequest: {
      model: 'gpt-5.3-codex',
      input: '继续执行',
    },
    response: {
      body: {
        id: 'resp_followup_1',
        object: 'response',
        status: 'completed',
        output: [],
      },
    },
    pipelineMetadata,
  };
}

function bindPipelineMetadataFollowupTruth(
  pipelineMetadata: Record<string, unknown>,
  sessionId: string
): MetadataCenter {
  const center = MetadataCenter.attach(pipelineMetadata);
  center.writeRequestTruth(
    'sessionId',
    sessionId,
    {
      module: 'tests/server/runtime/http-server/executor/provider-response-converter.goal-followup-http400.spec.ts',
      symbol: 'bindPipelineMetadataFollowupTruth',
      stage: 'test'
    }
  );
  center.writeRuntimeControl(
    'serverToolFollowup',
    true,
    {
      module: 'tests/server/runtime/http-server/executor/provider-response-converter.goal-followup-http400.spec.ts',
      symbol: 'bindPipelineMetadataFollowupTruth',
      stage: 'test'
    }
  );
  return center;
}

async function loadConverter() {
  const mod = await import('../../../../../src/server/runtime/http-server/executor/provider-response-converter.js');
  return mod.convertProviderResponseIfNeeded;
}

function createDeps() {
  return {
    runtimeManager: {
      resolveRuntimeKey: () => undefined,
      getHandleByRuntimeKey: () => undefined,
    },
    executeNested: async () => ({ body: { ok: true } } as any),
  };
}

describe('provider-response-converter goal active stopless guard', () => {
  it('stops active goal after 5 consecutive followup HTTP_400 failures', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockPersistStoplessGoalStateSnapshot.mockReset();
    mockSyncReasoningStopModeFromRequest.mockReset();
    mockSyncReasoningStopModeFromRequest.mockReturnValue('off');
    mockSyncStoplessGoalStateFromRequest.mockReset();
    mockSyncStoplessGoalStateFromRequest.mockReturnValue({ stateKey: 'session:goal-followup-http400', hadDirective: false, directiveTypes: [] });
    mockLoadRoutingInstructionStateSync.mockReset();
    mockLoadRoutingInstructionStateSync.mockReturnValue(null);

    const buildFollowup400 = () =>
      Object.assign(new Error('HTTP 400: {"error":{"message":"previous_response_id is only supported on Responses WebSocket v2"}}'), {
        code: 'HTTP_400',
        status: 400,
        statusCode: 400,
        retryable: false,
        upstreamCode: 'HTTP_400',
        requestExecutorProviderErrorStage: 'provider.followup',
      });

    mockConvertProviderResponse.mockImplementation(async () => {
      throw buildFollowup400();
    });

    const convertProviderResponseIfNeeded = await loadConverter();

    const pipelineMetadata: Record<string, unknown> = {
      sessionId: 'goal-followup-http400',
      stoplessGoalState: {
        status: 'active',
        objective: 'keep going',
        updatedAt: Date.now(),
        createdAt: Date.now(),
      },
    };
    const center = bindPipelineMetadataFollowupTruth(pipelineMetadata, 'goal-followup-http400');

    for (let index = 1; index <= 4; index += 1) {
      await expect(
        convertProviderResponseIfNeeded(buildBaseOptions(pipelineMetadata, `req_goal_followup_http400_${index}`), createDeps() as any)
      ).rejects.toThrow('previous_response_id is only supported on Responses WebSocket v2');
      expect((pipelineMetadata.stoplessGoalState as any)?.status).toBe('active');
      expect((pipelineMetadata.stoplessGoalState as any)?.consecutiveIrrecoverableErrors).toBe(index);
      expect(center.readRuntimeControl().stoplessGoalStatus).toBe('active');
    }

    await expect(
      convertProviderResponseIfNeeded(buildBaseOptions(pipelineMetadata, 'req_goal_followup_http400_5'), createDeps() as any)
    ).rejects.toThrow('previous_response_id is only supported on Responses WebSocket v2');

    expect((pipelineMetadata.stoplessGoalState as any)?.status).toBe('stopped');
    expect((pipelineMetadata.stoplessGoalState as any)?.errorClass).toBe('repeated_irrecoverable_error');
    expect((pipelineMetadata.stoplessGoalState as any)?.consecutiveIrrecoverableErrors).toBe(5);
    expect(center.readRuntimeControl().stoplessGoalStatus).toBe('stopped');
    expect(mockPersistStoplessGoalStateSnapshot).toHaveBeenCalled();
  });

  it('counts retryable HTTP_502 followup failures toward the same 5-error stop threshold', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockPersistStoplessGoalStateSnapshot.mockReset();

    const buildFollowup502 = () =>
      Object.assign(new Error('HTTP 502: {"error":{"message":"Upstream request failed","type":"upstream_error"}}'), {
        code: 'HTTP_502',
        status: 502,
        statusCode: 502,
        retryable: true,
        upstreamCode: 'HTTP_502',
        requestExecutorProviderErrorStage: 'provider.followup',
      });

    mockConvertProviderResponse.mockImplementation(async () => {
      throw buildFollowup502();
    });

    const convertProviderResponseIfNeeded = await loadConverter();
    const pipelineMetadata: Record<string, unknown> = {
      sessionId: 'goal-followup-http502',
      stoplessGoalState: {
        status: 'active',
        objective: 'keep going',
        updatedAt: Date.now(),
        createdAt: Date.now(),
      },
    };
    bindPipelineMetadataFollowupTruth(pipelineMetadata, 'goal-followup-http502');

    for (let index = 1; index <= 5; index += 1) {
      await expect(
        convertProviderResponseIfNeeded(buildBaseOptions(pipelineMetadata, `req_goal_followup_http502_${index}`), createDeps() as any)
      ).rejects.toThrow('Upstream request failed');
    }

    expect((pipelineMetadata.stoplessGoalState as any)?.status).toBe('stopped');
    expect((pipelineMetadata.stoplessGoalState as any)?.consecutiveIrrecoverableErrors).toBe(5);
  });

  it('resets consecutive error count after a successful non-error followup turn', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockPersistStoplessGoalStateSnapshot.mockReset();

    let call = 0;
    mockConvertProviderResponse.mockImplementation(async () => {
      call += 1;
      if (call <= 2) {
        throw Object.assign(new Error('HTTP 400: bad request'), {
          code: 'HTTP_400',
          status: 400,
          statusCode: 400,
          retryable: false,
          upstreamCode: 'HTTP_400',
          requestExecutorProviderErrorStage: 'provider.followup',
        });
      }
      return {
        body: {
          id: 'resp_success_1',
          object: 'response',
          status: 'requires_action',
          output: [{ type: 'function_call', name: 'apply_patch', arguments: '{}', call_id: 'call_1' }],
        },
      };
    });

    const convertProviderResponseIfNeeded = await loadConverter();
    const pipelineMetadata: Record<string, unknown> = {
      sessionId: 'goal-followup-reset-errors',
      stoplessGoalState: {
        status: 'active',
        objective: 'keep going',
        updatedAt: Date.now(),
        createdAt: Date.now(),
      },
    };
    bindPipelineMetadataFollowupTruth(pipelineMetadata, 'goal-followup-reset-errors');

    await expect(convertProviderResponseIfNeeded(buildBaseOptions(pipelineMetadata, 'req_err_1'), createDeps() as any)).rejects.toThrow('bad request');
    await expect(convertProviderResponseIfNeeded(buildBaseOptions(pipelineMetadata, 'req_err_2'), createDeps() as any)).rejects.toThrow('bad request');
    expect((pipelineMetadata.stoplessGoalState as any)?.consecutiveIrrecoverableErrors).toBe(2);

    const result = await convertProviderResponseIfNeeded(buildBaseOptions(pipelineMetadata, 'req_reset_success'), createDeps() as any);
    expect((result as any).body?.status).toBe('requires_action');
    expect((pipelineMetadata.stoplessGoalState as any)?.consecutiveIrrecoverableErrors).toBe(0);
    expect((pipelineMetadata.stoplessGoalState as any)?.consecutiveNoProgress).toBe(0);
    expect((pipelineMetadata.stoplessGoalState as any)?.status).toBe('active');
  });

  it('stops active goal after 5 consecutive finish_reason=stop responses', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockPersistStoplessGoalStateSnapshot.mockReset();

    mockConvertProviderResponse.mockImplementation(async () => ({
      body: {
        id: 'resp_stop_1',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'done' }],
          },
        ],
      },
    }));

    const convertProviderResponseIfNeeded = await loadConverter();
    const pipelineMetadata: Record<string, unknown> = {
      sessionId: 'goal-followup-stop-streak',
      stoplessGoalState: {
        status: 'active',
        objective: 'keep going',
        updatedAt: Date.now(),
        createdAt: Date.now(),
      },
    };
    bindPipelineMetadataFollowupTruth(pipelineMetadata, 'goal-followup-stop-streak');

    for (let index = 1; index <= 4; index += 1) {
      const result = await convertProviderResponseIfNeeded(buildBaseOptions(pipelineMetadata, `req_stop_${index}`), createDeps() as any);
      expect((result as any).body?.status).toBe('completed');
      expect((pipelineMetadata.stoplessGoalState as any)?.status).toBe('active');
      expect((pipelineMetadata.stoplessGoalState as any)?.consecutiveNoProgress).toBe(index);
    }

    await convertProviderResponseIfNeeded(buildBaseOptions(pipelineMetadata, 'req_stop_5'), createDeps() as any);
    expect((pipelineMetadata.stoplessGoalState as any)?.status).toBe('stopped');
    expect((pipelineMetadata.stoplessGoalState as any)?.consecutiveNoProgress).toBe(5);
    expect((pipelineMetadata.stoplessGoalState as any)?.errorClass).toBe('repeated_no_progress_stop');
  });

  it('resets stop streak when followup yields tool_calls progress', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockPersistStoplessGoalStateSnapshot.mockReset();

    let call = 0;
    mockConvertProviderResponse.mockImplementation(async () => {
      call += 1;
      if (call <= 2 || call >= 4) {
        return {
          body: {
            id: `resp_stop_${call}`,
            object: 'response',
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
          },
        };
      }
      return {
        body: {
          id: 'resp_tool_1',
          object: 'response',
          status: 'requires_action',
          output: [{ type: 'function_call', name: 'apply_patch', arguments: '{}', call_id: 'call_reset_1' }],
        },
      };
    });

    const convertProviderResponseIfNeeded = await loadConverter();
    const pipelineMetadata: Record<string, unknown> = {
      sessionId: 'goal-followup-stop-reset',
      stoplessGoalState: {
        status: 'active',
        objective: 'keep going',
        updatedAt: Date.now(),
        createdAt: Date.now(),
      },
    };
    bindPipelineMetadataFollowupTruth(pipelineMetadata, 'goal-followup-stop-reset');

    await convertProviderResponseIfNeeded(buildBaseOptions(pipelineMetadata, 'req_stop_reset_1'), createDeps() as any);
    await convertProviderResponseIfNeeded(buildBaseOptions(pipelineMetadata, 'req_stop_reset_2'), createDeps() as any);
    expect((pipelineMetadata.stoplessGoalState as any)?.consecutiveNoProgress).toBe(2);

    await convertProviderResponseIfNeeded(buildBaseOptions(pipelineMetadata, 'req_stop_reset_tool'), createDeps() as any);
    expect((pipelineMetadata.stoplessGoalState as any)?.consecutiveNoProgress).toBe(0);

    await convertProviderResponseIfNeeded(buildBaseOptions(pipelineMetadata, 'req_stop_reset_3'), createDeps() as any);
    expect((pipelineMetadata.stoplessGoalState as any)?.consecutiveNoProgress).toBe(1);
    expect((pipelineMetadata.stoplessGoalState as any)?.status).toBe('active');
  });
});
