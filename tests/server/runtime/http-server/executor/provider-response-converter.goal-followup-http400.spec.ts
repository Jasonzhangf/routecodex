import { describe, expect, it, jest } from '@jest/globals';

const mockConvertProviderResponse = jest.fn();
const mockCreateSnapshotRecorder = jest.fn(async () => ({ record: () => {} }));
const mockPersistStoplessGoalStateSnapshot = jest.fn();
const mockSyncReasoningStopModeFromRequest = jest.fn(() => 'off');
const mockSyncStoplessGoalStateFromRequest = jest.fn(() => ({ stickyKey: 'session:goal-followup-http400', hadDirective: false, directiveTypes: [] }));
const mockLoadRoutingInstructionStateSync = jest.fn(() => null);
const mockReadStoplessGoalState = jest.fn((adapterContext: Record<string, unknown>) => {
  const sessionId = typeof adapterContext?.sessionId === 'string' ? adapterContext.sessionId : undefined;
  return {
    ...(sessionId ? { stickyKey: `session:${sessionId}` } : {}),
    state: mockLoadRoutingInstructionStateSync(sessionId ? `session:${sessionId}` : '')?.stoplessGoalState,
  };
});

const mockBridgeModule = () => ({
  convertProviderResponse: mockConvertProviderResponse,
  createSnapshotRecorder: mockCreateSnapshotRecorder,
  syncReasoningStopModeFromRequest: mockSyncReasoningStopModeFromRequest,
  syncStoplessGoalStateFromRequest: mockSyncStoplessGoalStateFromRequest,
  persistStoplessGoalStateSnapshot: mockPersistStoplessGoalStateSnapshot,
  loadRoutingInstructionStateSync: mockLoadRoutingInstructionStateSync,
  readStoplessGoalState: mockReadStoplessGoalState,
  sanitizeFollowupText: async (raw: unknown) => (typeof raw === 'string' ? raw : ''),
});

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);

describe('provider-response-converter goal active followup HTTP_400 guard', () => {
  it('stops active goal after repeated irrecoverable provider.followup HTTP_400 failures', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockPersistStoplessGoalStateSnapshot.mockReset();
    mockSyncReasoningStopModeFromRequest.mockReset();
    mockSyncReasoningStopModeFromRequest.mockReturnValue('off');
    mockSyncStoplessGoalStateFromRequest.mockReset();
    mockSyncStoplessGoalStateFromRequest.mockReturnValue({ stickyKey: 'session:goal-followup-http400', hadDirective: false, directiveTypes: [] });
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

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const pipelineMetadata: Record<string, unknown> = {
      sessionId: 'goal-followup-http400',
      stoplessGoalState: {
        status: 'active',
        objective: 'keep going',
        updatedAt: Date.now(),
        createdAt: Date.now(),
      },
    };

    const baseOptions = {
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      requestId: 'req_goal_followup_http400',
      wantsStream: true,
      processMode: 'standard',
      requestSemantics: {
        __routecodex: {
          serverToolFollowup: true,
          serverToolFollowupSource: 'servertool.stop_message_auto',
        },
      } as any,
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
      } as any,
      pipelineMetadata,
    };

    await expect(
      convertProviderResponseIfNeeded(baseOptions as any, {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined,
        },
        executeNested: async () => ({ body: { ok: true } } as any),
      })
    ).rejects.toThrow('previous_response_id is only supported on Responses WebSocket v2');

    expect((pipelineMetadata.stoplessGoalState as any)?.status).toBe('active');
    expect((pipelineMetadata.stoplessGoalState as any)?.consecutiveIrrecoverableErrors).toBe(1);

    await expect(
      convertProviderResponseIfNeeded(
        {
          ...baseOptions,
          requestId: 'req_goal_followup_http400_2',
          pipelineMetadata,
        } as any,
        {
          runtimeManager: {
            resolveRuntimeKey: () => undefined,
            getHandleByRuntimeKey: () => undefined,
          },
          executeNested: async () => ({ body: { ok: true } } as any),
        }
      )
    ).rejects.toThrow('previous_response_id is only supported on Responses WebSocket v2');

    expect((pipelineMetadata.stoplessGoalState as any)?.status).toBe('stopped');
    expect((pipelineMetadata.stoplessGoalState as any)?.errorClass).toBe('repeated_irrecoverable_error');
    expect((pipelineMetadata.stoplessGoalState as any)?.consecutiveIrrecoverableErrors).toBe(2);
    expect(mockPersistStoplessGoalStateSnapshot).toHaveBeenCalled();
  });
});
