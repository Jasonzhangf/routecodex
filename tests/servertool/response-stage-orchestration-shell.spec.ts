import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const planServertoolResponseStageGateWithNative = jest.fn();
const resolveServertoolResponseStageOrchestrationGateApplicationWithNative = jest.fn();
const materializeServertoolResponseStageOrchestrationOutputWithNative = jest.fn();
const extractServertoolResponseStageOrchestrationShellResultWithNative = jest.fn((output: any) => output.shellResult);
const detectProviderResponseShapeWithNative = jest.fn(() => 'chat_completion');
const readRuntimeControlFromAnyBoundMetadataCenter = jest.fn(() => ({}));
const inspectStopGatewaySignal = jest.fn(() => ({
  observed: true,
  reason: 'stop',
  source: 'chat',
  eligible: true
}));
const runServerToolOrchestrationShell = jest.fn();
const planEngineSelectionStartWithNative = jest.fn(() => ({
  overrides: {},
  primaryAutoHookIds: []
}));
const resolveEngineSelectionAfterRunWithNative = jest.fn(() => ({
  rerunOverrides: null
}));

jest.unstable_mockModule(
  'rcc-llmswitch-core/native/servertool-wrapper',
  () => ({
    buildServertoolPostflightObservationSummaryWithNative: jest.fn(),
    containsSyntheticRouteCodexControlTextWithNative: jest.fn(),
    planServertoolResponseStageGateWithNative,
    detectProviderResponseShapeWithNative,
    materializeServertoolResponseStageOrchestrationOutputWithNative,
    extractServertoolResponseStageOrchestrationShellResultWithNative,
    resolveServertoolResponseStageOrchestrationGateApplicationWithNative,
    readServertoolPrimaryAutoHookIdsWithNative: jest.fn(() => []),
    planEngineSelectionStartWithNative,
    resolveEngineSelectionAfterRunWithNative,
    planServertoolEngineRuntimeActionWithNative: jest.fn((input: any) => ({
      action: 'return_servertool_cli_projection_final',
      executed: true,
      flowIdSource: 'engine_execution',
      progressStatus: 'completed',
      finalPayloadSource: 'engine_result',
      projectedFlowId: input.currentFlowId
    })),
    planServertoolEnginePreflightWithNative: jest.fn(),
    planServertoolEngineTriggerObservationWithNative: jest.fn(() => ({
      logStopEntry: null,
      logStopCompare: null
    })),
    resolveServertoolEngineMatchHitWithNative: jest.fn((input: any) => ({
      flowId: input.execution.flowId
    })),
    resolveServertoolEnginePreflightDecisionWithNative: jest.fn(() => ({
      result: {
        kind: 'continue',
        stopSignal: { observed: true, reason: 'stop', source: 'chat', eligible: true }
      },
      shouldRunSideEffects: false
    })),
    resolveServertoolEnginePostflightPayloadWithNative: jest.fn((input: any) => input.engineResult.finalChatResponse),
    resolveServertoolEngineSkipDecisionWithNative: jest.fn((input: any) => input.hasExecution
      ? { returnSkipped: false }
      : {
          returnSkipped: true,
          triggerResult: 'skipped_passthrough',
          skipReason: 'passthrough',
          shellResult: {
            chat: input.finalChatResponse,
            executed: false
          }
        }),
    resolveServertoolEngineOrchestrationPreflightDecisionWithNative: jest.fn(() => ({
      returnPreflightChat: false,
      stopSignal: { observed: true, reason: 'stop', source: 'chat', eligible: true }
    })),
    resolveServertoolTimeoutMsFromEnvCandidatesWithNative: jest.fn(),
    planServertoolTimeoutErrorWithNative: jest.fn(),
    planStoplessExecutionWithNative: jest.fn((input: any) => ({
      execution: input.execution,
      orchestrationPlan: {
        isStopMessageFlow: false,
        action: 'return_servertool_cli_projection_final'
      }
    }))
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/metadata-center-carrier.js',
  () => ({
    attachStopGatewayContext: jest.fn(),
    inspectStopGatewaySignal,
    readRuntimeControlFromAnyBoundMetadataCenter,
    readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter: jest.fn(() => null),
    writeRuntimeControlToBoundMetadataCenter: jest.fn()
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/timeout-error-block.js',
  () => ({
    createServertoolProviderProtocolErrorFromPlan: jest.fn((plan: any) => plan),
    withTimeout: jest.fn((promise: Promise<unknown>) => promise)
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/progress-log-block.js',
  () => ({
    appendServertoolMatchSkippedProgressEvent: jest.fn(),
    createServertoolProgressLogger: jest.fn(() => ({
      logStopEntry: jest.fn(),
      logProgress: jest.fn(),
      logAutoHookTrace: jest.fn(),
      logStopCompare: jest.fn()
    }))
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/run-server-side-tool-engine-shell.js',
  () => ({
    orchestrateServertoolEngine: jest.fn(async () => {
      const result = await runServerToolOrchestrationShell();
      return {
        mode: result.executed ? 'tool_flow' : 'passthrough',
        finalChatResponse: result.chat,
        execution: result.executed
          ? {
              flowId: result.flowId ?? 'flow_response_stage'
            }
          : null,
        metadataWritePlan: null
      };
    })
  })
);

const { runServertoolResponseStageOrchestrationShell } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.js'
);

describe('response-stage-orchestration-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    planServertoolResponseStageGateWithNative.mockReturnValue({
      nextAction: 'continue_to_execution',
      shouldBypass: false,
      responseHookMatched: false,
      responseHookRequired: false
    });
    resolveServertoolResponseStageOrchestrationGateApplicationWithNative.mockReturnValue({
      bypass: false,
      runOrchestration: true
    });
    materializeServertoolResponseStageOrchestrationOutputWithNative.mockImplementation((input: any) =>
      input?.orchestrationExecuted === true
        ? {
            payload: input.executedPayload,
            executed: true,
            flowId: String(input.orchestrationFlowId ?? '').trim(),
            returnedExecutedPayload: true,
            shellResult: {
              payload: input.executedPayload,
              executed: true,
              flowId: String(input.orchestrationFlowId ?? '').trim()
            },
            recordEvent: {
              executed: true,
              flowId: String(input.orchestrationFlowId ?? '').trim(),
              inputShape: input.inputShape,
              outputShape: input.outputShape
            }
          }
        : {
            payload: input.originalPayload,
            executed: false,
            returnedExecutedPayload: false,
            shellResult: {
              payload: input.originalPayload,
              executed: false
            },
            recordEvent: {
              executed: false,
              inputShape: input.inputShape
            }
          }
    );
    runServerToolOrchestrationShell.mockResolvedValue({
      chat: { id: 'resp_1' },
      executed: false
    });
    planEngineSelectionStartWithNative.mockReturnValue({
      overrides: {},
      primaryAutoHookIds: []
    });
    resolveEngineSelectionAfterRunWithNative.mockReturnValue({
      rerunOverrides: null
    });
  });

  test('rejects bypass gate payload without skipReason at native parser boundary', async () => {
    const { parseServertoolResponseStageGatePayload } = await import(
      '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-analysis.js'
    );

    expect(parseServertoolResponseStageGatePayload(JSON.stringify({
      nextAction: 'bypass',
      shouldBypass: true,
      responseHookMatched: false,
      responseHookRequired: false
    }))).toBeNull();
  });

  test('keeps bypass skipReason validation out of the orchestration shell', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(
      'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts',
      'utf8'
    );
    expect(await import('node:fs').then((fs) => fs.existsSync('sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.ts'))).toBe(false);

    expect(source).not.toContain("throw new Error('[servertool] native response-stage gate bypass missing skipReason')");
    expect(source).not.toContain('typeof gatePlan.skipReason');
    expect(source).not.toContain('gatePlan.skipReason.trim()');
    expect(source).not.toContain('gatePlan.skipReason as string');
    expect(source).not.toContain('String(gateRuntimeAction.action)');
    expect(source).not.toContain('switch (gateRuntimeAction.action)');
    expect(source).not.toContain('String(outputPlan.returnAction)');
    expect(source).not.toContain('switch (outputPlan.returnAction)');
    expect(source).not.toContain("gatePlan.nextAction === 'bypass'");
    expect(source).not.toContain("if (gateRuntimeAction.action === 'return_passthrough_bypass')");
    expect(source).not.toContain('if (orchestration.executed)');
    expect(source).not.toContain('if (output.returnedExecutedPayload)');
    expect(source).not.toContain('chat: options.payload as JsonObject');
    expect(source).not.toContain('options.adapterContext as Record<string, unknown>');
    expect(source).not.toContain('[servertool.detail]');
    expect(source).not.toContain('ROUTECODEX_STAGE_TIMING');
    expect(source).not.toContain('const orchestrationStart = Date.now()');
    expect(source).not.toContain('Date.now() - orchestrationStart');
    expect(source).not.toContain('forceLog: forceDetailLog');
    expect(source).toContain('chat: options.payload');
    expect(source).toContain('adapterContext: options.adapterContext');
    expect(source).not.toContain("gateDecision.action === 'return_passthrough_bypass'");
    expect(source).not.toContain(".action === 'return_passthrough_bypass'");
    expect(source).toContain('resolveServertoolResponseStageOrchestrationGateApplicationWithNative({');
    expect(source).toContain('if (gateApplication.bypass)');
    expect(source).toContain('materializeServertoolResponseStageOrchestrationOutputWithNative({');
    expect(source).toContain('extractServertoolResponseStageOrchestrationShellResultWithNative(output)');
    expect(source).not.toContain('return output.shellResult');
  });

  test('returns native skipReason without TS fallback or whitelist filtering', async () => {
    const stageRecorder = { record: jest.fn() };
    planServertoolResponseStageGateWithNative.mockReturnValue({
      nextAction: 'bypass',
      shouldBypass: true,
      responseHookMatched: false,
      responseHookRequired: false,
      skipReason: 'empty_assistant_payload'
    });
    resolveServertoolResponseStageOrchestrationGateApplicationWithNative.mockReturnValue({
      bypass: true,
      runOrchestration: false,
      skipReason: 'empty_assistant_payload'
    });

    await expect(
      runServertoolResponseStageOrchestrationShell({
        payload: { id: 'resp_2' },
        adapterContext: {} as any,
        requestId: 'req-native-skip',
        entryEndpoint: '/v1/responses',
        stageRecorder: stageRecorder as any
      })
    ).resolves.toEqual({
      payload: { id: 'resp_2' },
      executed: false,
      skipReason: 'empty_assistant_payload'
    });
    expect(stageRecorder.record).toHaveBeenCalledWith(
      'HubRespChatProcess03Governed.servertool_orchestration',
      expect.objectContaining({
        executed: false,
        skipReason: 'empty_assistant_payload',
        inputShape: 'chat_completion'
      })
    );
    expect(runServerToolOrchestrationShell).not.toHaveBeenCalled();
    expect(resolveServertoolResponseStageOrchestrationGateApplicationWithNative).toHaveBeenCalledWith({
      baseObject: { id: 'resp_2' },
      responseStageGatePlan: {
        nextAction: 'bypass',
        shouldBypass: true,
        responseHookMatched: false,
        responseHookRequired: false,
        skipReason: 'empty_assistant_payload'
      }
    });
  });

  test('uses native orchestration output materializer for executed response projection', async () => {
    const stageRecorder = { record: jest.fn() };
    runServerToolOrchestrationShell.mockResolvedValue({
      chat: { id: 'resp_executed' },
      executed: true,
      flowId: ' flow_executed '
    });
    materializeServertoolResponseStageOrchestrationOutputWithNative.mockReturnValue({
      payload: { id: 'resp_executed' },
      executed: true,
      flowId: 'flow_executed',
      returnedExecutedPayload: true,
      shellResult: {
        payload: { id: 'resp_executed' },
        executed: true,
        flowId: 'flow_executed'
      },
      recordEvent: {
        executed: true,
        flowId: 'flow_executed',
        inputShape: 'chat_completion',
        outputShape: 'chat_completion'
      }
    });

    await expect(
      runServertoolResponseStageOrchestrationShell({
        payload: { id: 'resp_input' },
        adapterContext: {} as any,
        requestId: 'req-output-plan',
        entryEndpoint: '/v1/chat/completions',
        stageRecorder: stageRecorder as any
      })
    ).resolves.toEqual({
      payload: { id: 'resp_executed' },
      executed: true,
      flowId: 'flow_executed'
    });

    expect(materializeServertoolResponseStageOrchestrationOutputWithNative).toHaveBeenCalledWith({
      originalPayload: { id: 'resp_input' },
      executedPayload: { id: 'resp_executed' },
      orchestrationExecuted: true,
      orchestrationFlowId: ' flow_executed ',
      inputShape: 'chat_completion',
      outputShape: 'chat_completion'
    });
    expect(extractServertoolResponseStageOrchestrationShellResultWithNative).toHaveBeenCalledWith(
      expect.objectContaining({
        shellResult: {
          payload: { id: 'resp_executed' },
          executed: true,
          flowId: 'flow_executed'
        }
      })
    );
    expect(stageRecorder.record).toHaveBeenCalledWith(
      'HubRespChatProcess03Governed.servertool_orchestration',
      expect.objectContaining({
        executed: true,
        flowId: 'flow_executed',
        inputShape: 'chat_completion',
        outputShape: 'chat_completion'
      })
    );
  });

  test('uses native orchestration output materializer for original response projection', async () => {
    const stageRecorder = { record: jest.fn() };
    runServerToolOrchestrationShell.mockResolvedValue({
      chat: { id: 'resp_ignored' },
      executed: false
    });
    materializeServertoolResponseStageOrchestrationOutputWithNative.mockReturnValue({
      payload: { id: 'resp_original' },
      executed: false,
      returnedExecutedPayload: false,
      shellResult: {
        payload: { id: 'resp_original' },
        executed: false
      },
      recordEvent: {
        executed: false,
        inputShape: 'chat_completion'
      }
    });

    await expect(
      runServertoolResponseStageOrchestrationShell({
        payload: { id: 'resp_original' },
        adapterContext: {} as any,
        requestId: 'req-output-original',
        entryEndpoint: '/v1/responses',
        stageRecorder: stageRecorder as any
      })
    ).resolves.toEqual({
      payload: { id: 'resp_original' },
      executed: false
    });

    expect(materializeServertoolResponseStageOrchestrationOutputWithNative).toHaveBeenCalledWith({
      originalPayload: { id: 'resp_original' },
      executedPayload: { id: 'resp_ignored' },
      orchestrationExecuted: false,
      orchestrationFlowId: undefined,
      inputShape: 'chat_completion',
      outputShape: undefined
    });
    expect(extractServertoolResponseStageOrchestrationShellResultWithNative).toHaveBeenCalledWith(
      expect.objectContaining({
        shellResult: {
          payload: { id: 'resp_original' },
          executed: false
        }
      })
    );
    expect(stageRecorder.record).toHaveBeenCalledWith(
      'HubRespChatProcess03Governed.servertool_orchestration',
      expect.objectContaining({
        executed: false,
        inputShape: 'chat_completion'
      })
    );
  });
});
