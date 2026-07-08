import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const inspectStopGatewaySignalMock = jest.fn();
const attachStopGatewayContextMock = jest.fn();
const containsSyntheticRouteCodexControlTextMock = jest.fn(() => false);
const planServertoolEnginePreflightWithNativeMock = jest.fn();
const resolveServertoolEnginePreflightDecisionWithNativeMock = jest.fn((input: any) => ({
  result: input.preflightAction.result,
  shouldRunSideEffects: input.preflightAction.action !== 'return_original_chat'
}));
const resolveServertoolEngineOrchestrationPreflightDecisionWithNativeMock = jest.fn();
const resolveServertoolEngineSkipDecisionWithNativeMock = jest.fn();
const resolveServertoolTimeoutMsFromEnvCandidatesWithNativeMock = jest.fn(() => 1000);
const planServertoolEngineTriggerObservationWithNativeMock = jest.fn(() => ({
  logStopEntry: null,
  logStopCompare: null
}));
const logStopEntryMock = jest.fn();
const logProgressMock = jest.fn();
const logAutoHookTraceMock = jest.fn();
const logStopCompareMock = jest.fn();
const orchestrateServertoolEngineMock = jest.fn();
const planEngineSelectionStartWithNativeMock = jest.fn(() => ({
  overrides: {},
  primaryAutoHookIds: []
}));
const resolveEngineSelectionAfterRunWithNativeMock = jest.fn(() => ({
  rerunOverrides: null
}));

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/metadata-center-carrier.js',
  () => ({
    inspectStopGatewaySignal: inspectStopGatewaySignalMock,
    attachStopGatewayContext: attachStopGatewayContextMock,
    readProviderProtocolFromAnyBoundMetadataCenter: jest.fn(() => 'openai-chat'),
    readStopMessageCompareContext: jest.fn(() => null),
    readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter: jest.fn(() => null),
    readRuntimeControlFromAnyBoundMetadataCenter: jest.fn(() => null),
    writeRuntimeControlToBoundMetadataCenter: jest.fn(),
  })
);

jest.unstable_mockModule(
  'rcc-llmswitch-core/native/servertool-wrapper',
  () => ({
    buildServertoolPostflightObservationSummaryWithNative: jest.fn(),
    buildServertoolAutoHookTraceProgressEventWithNative: jest.fn(),
    buildServertoolStopCompareProgressEventWithNative: jest.fn(),
    buildServertoolStopEntryProgressEventWithNative: jest.fn(),
    buildServertoolMatchSkippedProgressEventWithNative: jest.fn(),
    normalizeServertoolProgressFlowIdWithNative: jest.fn((value: any) => value),
    normalizeServertoolProgressResultWithNative: jest.fn((value: any) => value),
    normalizeStopMessageCompareContextWithNative: jest.fn((value: any) => value),
    formatStopMessageCompareContextWithNative: jest.fn(() => ''),
    shouldUseServertoolGoldProgressHighlightWithNative: jest.fn(() => false),
    containsSyntheticRouteCodexControlTextWithNative: containsSyntheticRouteCodexControlTextMock,
    readServertoolPrimaryAutoHookIdsWithNative: jest.fn(() => []),
    planEngineSelectionStartWithNative: planEngineSelectionStartWithNativeMock,
    resolveEngineSelectionAfterRunWithNative: resolveEngineSelectionAfterRunWithNativeMock,
    planServertoolResponseStageGateWithNative: jest.fn(),
    runServertoolResponseStageWithNative: jest.fn(() => ({ toolCalls: [] })),
    readServertoolEntryBaseObjectWithNative: jest.fn((input: any) => input?.chatResponse ?? {}),
    resolveServertoolEntryPreflightWithNative: jest.fn(() => ({ action: 'continue' })),
    resolveServertoolEntryPreflightApplicationWithNative: jest.fn(() => ({ returnPassthrough: false })),
    resolveServertoolRunEngineEntryPreflightDecisionWithNative: jest.fn(),
    resolveServertoolRunEngineEntryPreflightApplicationWithNative: jest.fn(),
    resolveServertoolRunEnginePrepassDecisionWithNative: jest.fn(),
    resolveServertoolRunEnginePrepassApplicationWithNative: jest.fn(),
    resolveServertoolResponseStagePrepassInitialDecisionWithNative: jest.fn(),
    resolveServertoolResponseStagePrepassInitialApplicationWithNative: jest.fn(),
    resolveServertoolResponseStagePrepassAfterAutoHookWithNative: jest.fn(),
    resolveServertoolResponseStageAutoHookPreDecisionWithNative: jest.fn(),
    resolveServertoolResponseStageAutoHookPreApplicationWithNative: jest.fn(),
    resolveServertoolResponseStageAutoHookPostDecisionWithNative: jest.fn(),
    resolveServertoolResponseStageAutoHookPostApplicationWithNative: jest.fn(),
    finalizeServertoolResponseStageWithNative: jest.fn(),
    extractServertoolResponseStageOrchestrationShellResultWithNative: jest.fn(),
    materializeServertoolResponseStageOrchestrationOutputWithNative: jest.fn(),
    resolveServertoolResponseStageOrchestrationGateApplicationWithNative: jest.fn(),
    detectProviderResponseShapeWithNative: jest.fn(),
    planServertoolBuiltinAutoHandlerEntriesWithNative: jest.fn(() => []),
    planServertoolAutoHookQueueItemsWithNative: jest.fn(() => []),
    resolveAutoHookRuntimeAttemptDecisionWithNative: jest.fn(),
    resolveAutoHookCallerFinalizationDecisionWithNative: jest.fn(),
    runStoplessBuiltinHandlerForRuntimeWithNative: jest.fn(),
    planServertoolRegistryBuiltinAutoHookEntriesWithNative: jest.fn(() => []),
    resolveServertoolRegistryHandlerWithNative: jest.fn(),
    planServertoolEntryContextWithNative: jest.fn(),
    materializeServertoolPlannedResultWithNative: jest.fn(),
    createServertoolExecutionLoopStateWithNative: jest.fn(),
    resolveServertoolExecutionLoopInitialDecisionWithNative: jest.fn(),
    applyServertoolExecutionLoopInitialDecisionWithNative: jest.fn(),
    resolveServertoolExecutionLoopResultDecisionWithNative: jest.fn(),
    applyServertoolExecutionLoopResultDecisionWithNative: jest.fn(),
    appendServertoolExecutedRecordWithNative: jest.fn(),
    planServertoolToolCallDispatchWithNative: jest.fn(),
    planServertoolExecutionDispatchErrorWithNative: jest.fn(),
    planServertoolHandlerErrorExecutionLoopEffectWithNative: jest.fn(),
    buildServertoolHandlerErrorToolOutputPayloadWithNative: jest.fn(),
    materializeNativeToolCallExecutionOutcomeWithNative: jest.fn(),
    resolveServertoolPreExecutionBranchDecisionWithNative: jest.fn(),
    resolveServertoolPostExecutionBranchDecisionWithNative: jest.fn(),
    buildServertoolCliProjectionRuntimeBranchWithNative: jest.fn(),
    buildServertoolDispatchPlanInputWithNative: jest.fn(),
    resolveServertoolProgressStageWithNative: jest.fn(),
    resolveServertoolProgressToolNameWithNative: jest.fn(),
    planServertoolTimeoutWatcherWithNative: jest.fn(() => ({ armed: false, timeoutMs: 1000 })),
    isAdapterClientDisconnectedWithNative: jest.fn(),
    createServertoolProviderProtocolErrorFromPlanWithNative: jest.fn((input: any) => input),
    planServertoolEngineRuntimeActionWithNative: jest.fn(),
    planServertoolEnginePreflightWithNative: planServertoolEnginePreflightWithNativeMock,
    planServertoolEngineTriggerObservationWithNative: planServertoolEngineTriggerObservationWithNativeMock,
    resolveServertoolEngineMatchHitWithNative: jest.fn(),
    resolveServertoolEnginePreflightDecisionWithNative: resolveServertoolEnginePreflightDecisionWithNativeMock,
    resolveServertoolEnginePostflightPayloadWithNative: jest.fn(),
    resolveServertoolEngineSkipDecisionWithNative: resolveServertoolEngineSkipDecisionWithNativeMock,
    resolveServertoolEngineOrchestrationPreflightDecisionWithNative: resolveServertoolEngineOrchestrationPreflightDecisionWithNativeMock,
    resolveServertoolTimeoutMsFromEnvCandidatesWithNative: resolveServertoolTimeoutMsFromEnvCandidatesWithNativeMock,
    planServertoolTimeoutErrorWithNative: jest.fn(),
    planStoplessExecutionWithNative: jest.fn(),
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/run-server-side-tool-engine-shell.js',
  () => ({
    orchestrateServertoolEngine: orchestrateServertoolEngineMock
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/progress-log-block.js',
  () => ({
    appendServertoolMatchSkippedProgressEvent: jest.fn(),
    createServertoolProgressLogger: jest.fn(() => ({
      logStopEntry: logStopEntryMock,
      logProgress: logProgressMock,
      logAutoHookTrace: logAutoHookTraceMock,
      logStopCompare: logStopCompareMock
    }))
  })
);

const { runServerToolOrchestrationShell } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.js'
);

describe('engine-preflight-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveServertoolEnginePreflightDecisionWithNativeMock.mockImplementation((input: any) => ({
      result: input.preflightAction.result,
      shouldRunSideEffects: input.preflightAction.action !== 'return_original_chat'
    }));
    resolveServertoolEngineOrchestrationPreflightDecisionWithNativeMock.mockImplementation(({ preflight }: any) => {
      if (preflight.kind === 'continue') {
        return {
          returnPreflightChat: false,
          stopSignal: preflight.stopSignal
        };
      }
      return {
        returnPreflightChat: true,
        chat: preflight.chat
      };
    });
    planEngineSelectionStartWithNativeMock.mockReturnValue({
      overrides: {},
      primaryAutoHookIds: []
    });
    resolveEngineSelectionAfterRunWithNativeMock.mockReturnValue({
      rerunOverrides: null
    });
    orchestrateServertoolEngineMock.mockResolvedValue({
      mode: 'passthrough',
      finalChatResponse: { id: 'chat-3' },
      execution: null,
      metadataWritePlan: null
    });
    resolveServertoolEngineSkipDecisionWithNativeMock.mockImplementation((input: any) => ({
      returnSkipped: true,
      triggerResult: 'skipped_passthrough',
      skipReason: 'passthrough',
      shellResult: {
        chat: input.finalChatResponse,
        executed: false
      }
    }));
    inspectStopGatewaySignalMock.mockReturnValue({
      observed: true,
      eligible: true,
      source: 'chat',
      reason: 'stop_schema_missing',
      choiceIndex: 0,
      hasToolCalls: false,
    });
    planServertoolEnginePreflightWithNativeMock.mockReturnValue({
      action: 'continue_to_engine',
      attachStopGatewayContext: true,
      result: {
        kind: 'continue',
        stopSignal: {
          observed: true,
          eligible: true,
          source: 'chat',
          reason: 'stop_schema_missing',
          choiceIndex: 0,
          hasToolCalls: false,
        }
      },
      logStopEntry: {
        stage: 'entry',
        result: 'observed',
        includeChoiceFacts: true
      }
    });
  });

  async function runPublicPreflight(chat: Record<string, unknown>) {
    return runServerToolOrchestrationShell({
      chat: chat as any,
      adapterContext: {} as any,
      requestId: `req-${String(chat.id ?? 'preflight')}`,
      entryEndpoint: '/v1/chat/completions'
    });
  }

  test('keeps engine preflight planning and stop-gateway wiring in the owner shell', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts',
        'utf8'
      )
    );

    expect(await import('node:fs').then((fs) => fs.existsSync('sharedmodule/llmswitch-core/src/servertool/engine-preflight-shell.ts'))).toBe(false);
    expect(source).toContain('planServertoolEnginePreflightWithNative');
    expect(source).not.toContain('export function runEnginePreflight(');
    expect(source).not.toContain('args.adapterContext as Record<string, unknown>');
    expect(source).toContain('function runPreflightSideEffects(');
    expect(source).toContain('inspectStopGatewaySignal(');
    expect(source).toContain('attachStopGatewayContext(');
    expect(source).toContain('containsSyntheticRouteCodexControlTextWithNative(');
    expect(source).not.toContain('stopSignal.observed && preflightAction.action');
    expect(source).not.toContain('if (stopSignal.observed) {');
    expect(source).not.toContain("if (preflightAction.action === 'return_original_chat')");
    expect(source).not.toContain("if (preflightAction.action === 'return_original_chat_direct_passthrough')");
    expect(source).not.toContain("case 'return_original_chat'");
    expect(source).not.toContain("case 'return_original_chat_direct_passthrough'");
    expect(source).not.toContain("case 'continue_to_engine'");
    expect(source).toContain('chat: args.chat');
    expect(source).toContain('stopSignal,');
    expect(source).toContain('resolveServertoolEnginePreflightDecisionWithNative');
    expect(source).toContain('return preflightDecision.result');
    expect(source).toContain('preflightAction.attachStopGatewayContext === true');
    expect(source).toContain('preflightAction.logStopEntry');
    expect(source).toContain('preflightAction.logStopCompare');
    expect(source).not.toContain("return { kind: 'return_original_chat'");
    expect(source).not.toContain("return { kind: 'return_original_chat_direct_passthrough'");
    expect(source).not.toContain("return { kind: 'continue'");
    expect(source).not.toContain('preflightAction.logStopEntry.stage');
    expect(source).not.toContain('preflightAction.logStopEntry.result');
    expect(source).not.toContain('String(preflightAction.action)');
    expect(source).not.toContain('./stop-gateway-context.js');
    expect(source).not.toContain('./orchestration-policy-block.js');
  });

  test('fails fast when native preflight decision rejects action', async () => {
    planServertoolEnginePreflightWithNativeMock.mockReturnValue({
      action: 'unknown_preflight_action',
      attachStopGatewayContext: true,
      result: {
        kind: 'continue',
        stopSignal: { observed: true }
      },
      logStopEntry: {
        stage: 'entry',
        result: 'observed',
        includeChoiceFacts: true
      },
      logStopCompare: {
        stage: 'entry'
      }
    });
    resolveServertoolEnginePreflightDecisionWithNativeMock.mockImplementation(() => {
      throw new Error('[servertool] invalid engine preflight action');
    });

    await expect(
      runPublicPreflight({ id: 'chat-invalid-action' })
    ).rejects.toThrow('[servertool] invalid engine preflight action');

    expect(attachStopGatewayContextMock).not.toHaveBeenCalled();
    expect(logStopEntryMock).not.toHaveBeenCalled();
    expect(logStopCompareMock).not.toHaveBeenCalled();
  });

  test('returns original chat when native preflight says so', async () => {
    planServertoolEnginePreflightWithNativeMock.mockReturnValue({
      action: 'return_original_chat',
      attachStopGatewayContext: false,
      result: {
        kind: 'return_original_chat',
        chat: { id: 'chat-1' }
      }
    });

    const result = await runPublicPreflight({ id: 'chat-1' });

    expect(result).toEqual({
      chat: { id: 'chat-1' },
      executed: false
    });
    expect(attachStopGatewayContextMock).not.toHaveBeenCalled();
    expect(orchestrateServertoolEngineMock).not.toHaveBeenCalled();
  });

  test('returns direct passthrough and logs trigger when native preflight disables stopless', async () => {
    planServertoolEnginePreflightWithNativeMock.mockReturnValue({
      action: 'return_original_chat_direct_passthrough',
      attachStopGatewayContext: true,
      result: {
        kind: 'return_original_chat_direct_passthrough',
        chat: { id: 'chat-2' }
      },
      logStopEntry: {
        stage: 'trigger',
        result: 'skipped_direct_passthrough',
        includeChoiceFacts: false
      },
      logStopCompare: {
        stage: 'trigger'
      }
    });

    const result = await runServerToolOrchestrationShell({
      chat: { id: 'chat-2' } as any,
      adapterContext: {} as any,
      requestId: 'req-chat-2',
      entryEndpoint: '/v1/chat/completions',
      stageRecorder: {
        record: jest.fn()
      } as any
    });

    expect(result).toEqual({
      chat: { id: 'chat-2' },
      executed: false
    });
    expect(attachStopGatewayContextMock).toHaveBeenCalled();
    expect(logStopEntryMock).toHaveBeenCalledWith(
      'trigger',
      'skipped_direct_passthrough',
      expect.objectContaining({ reason: 'stop_schema_missing', source: 'chat', eligible: true })
    );
    expect(logStopCompareMock).toHaveBeenCalledWith('trigger');
  });

  test('continues with stop signal and logs observed entry', async () => {
    const result = await runServerToolOrchestrationShell({
      chat: { id: 'chat-3' } as any,
      adapterContext: {} as any,
      requestId: 'req-chat-3',
      entryEndpoint: '/v1/chat/completions',
      stageRecorder: {
        record: jest.fn()
      } as any
    });

    expect(result).toEqual({
      chat: { id: 'chat-3' },
      executed: false
    });
    expect(attachStopGatewayContextMock).toHaveBeenCalled();
    expect(logStopEntryMock).toHaveBeenCalledWith(
      'entry',
      'observed',
      expect.objectContaining({ reason: 'stop_schema_missing', source: 'chat', eligible: true })
    );
    expect(logStopCompareMock).not.toHaveBeenCalled();
  });
});
