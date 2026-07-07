import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const inspectStopGatewaySignalMock = jest.fn();
const attachStopGatewayContextMock = jest.fn();
const containsSyntheticRouteCodexControlTextMock = jest.fn(() => false);
const planServertoolEnginePreflightWithNativeMock = jest.fn();
const resolveServertoolEnginePreflightDecisionWithNativeMock = jest.fn((input: any) => ({
  result: input.preflightAction.result,
  shouldRunSideEffects: input.preflightAction.action !== 'return_original_chat'
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
    planEngineSelectionStartWithNative: jest.fn(() => ({ overrides: {}, primaryAutoHookIds: [] })),
    resolveEngineSelectionAfterRunWithNative: jest.fn(() => ({ rerunOverrides: null })),
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
    planServertoolNoopExecutionLoopEffectWithNative: jest.fn(),
    buildServertoolHandlerErrorToolOutputPayloadWithNative: jest.fn(),
    materializeNativeToolCallExecutionOutcomeWithNative: jest.fn(),
    resolveServertoolPreExecutionBranchDecisionWithNative: jest.fn(),
    resolveServertoolPostExecutionBranchDecisionWithNative: jest.fn(),
    buildServertoolCliProjectionRuntimeBranchWithNative: jest.fn(),
    buildServertoolDispatchPlanInputWithNative: jest.fn(),
    resolveServertoolProgressStageWithNative: jest.fn(),
    resolveServertoolProgressToolNameWithNative: jest.fn(),
    planServertoolNoopOutcomeWithNative: jest.fn(),
    planServertoolTimeoutWatcherWithNative: jest.fn(),
    isAdapterClientDisconnectedWithNative: jest.fn(),
    createServertoolProviderProtocolErrorFromPlanWithNative: jest.fn((input: any) => input),
    planServertoolEngineRuntimeActionWithNative: jest.fn(),
    planServertoolEnginePreflightWithNative: planServertoolEnginePreflightWithNativeMock,
    planServertoolEngineTriggerObservationWithNative: jest.fn(),
    resolveServertoolEngineMatchHitWithNative: jest.fn(),
    resolveServertoolEnginePreflightDecisionWithNative: resolveServertoolEnginePreflightDecisionWithNativeMock,
    resolveServertoolEnginePostflightPayloadWithNative: jest.fn(),
    resolveServertoolEngineSkipDecisionWithNative: jest.fn(),
    resolveServertoolEngineOrchestrationPreflightDecisionWithNative: jest.fn(),
    resolveServertoolTimeoutMsFromEnvCandidatesWithNative: jest.fn(),
    planServertoolTimeoutErrorWithNative: jest.fn(),
    planStoplessExecutionWithNative: jest.fn(),
  })
);

const { runEnginePreflight } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.js'
);

describe('engine-preflight-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveServertoolEnginePreflightDecisionWithNativeMock.mockImplementation((input: any) => ({
      result: input.preflightAction.result,
      shouldRunSideEffects: input.preflightAction.action !== 'return_original_chat'
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

  test('keeps engine preflight planning and stop-gateway wiring in the owner shell', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts',
        'utf8'
      )
    );

    expect(await import('node:fs').then((fs) => fs.existsSync('sharedmodule/llmswitch-core/src/servertool/engine-preflight-shell.ts'))).toBe(false);
    expect(source).toContain('planServertoolEnginePreflightWithNative');
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

  test('fails fast when native preflight decision rejects action', () => {
    const logStopEntry = jest.fn();
    const logStopCompare = jest.fn();
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

    expect(() =>
      runEnginePreflight({
        chat: { id: 'chat-invalid-action' } as any,
        adapterContext: {} as any,
        logStopEntry,
        logStopCompare,
      })
    ).toThrow('[servertool] invalid engine preflight action');

    expect(attachStopGatewayContextMock).not.toHaveBeenCalled();
    expect(logStopEntry).not.toHaveBeenCalled();
    expect(logStopCompare).not.toHaveBeenCalled();
  });

  test('returns original chat when native preflight says so', () => {
    planServertoolEnginePreflightWithNativeMock.mockReturnValue({
      action: 'return_original_chat',
      attachStopGatewayContext: false,
      result: {
        kind: 'return_original_chat',
        chat: { id: 'chat-1' }
      }
    });

    const result = runEnginePreflight({
      chat: { id: 'chat-1' } as any,
      adapterContext: {} as any,
      logStopEntry: jest.fn(),
      logStopCompare: jest.fn(),
    });

    expect(result).toEqual({
      kind: 'return_original_chat',
      chat: { id: 'chat-1' },
    });
    expect(attachStopGatewayContextMock).not.toHaveBeenCalled();
  });

  test('returns direct passthrough and logs trigger when native preflight disables stopless', () => {
    const logStopEntry = jest.fn();
    const logStopCompare = jest.fn();
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

    const result = runEnginePreflight({
      chat: { id: 'chat-2' } as any,
      adapterContext: {} as any,
      logStopEntry,
      logStopCompare,
    });

    expect(result).toEqual({
      kind: 'return_original_chat_direct_passthrough',
      chat: { id: 'chat-2' },
    });
    expect(attachStopGatewayContextMock).toHaveBeenCalled();
    expect(logStopEntry).toHaveBeenCalledWith(
      'trigger',
      'skipped_direct_passthrough',
      expect.objectContaining({ reason: 'stop_schema_missing', source: 'chat', eligible: true })
    );
    expect(logStopCompare).toHaveBeenCalledWith('trigger');
  });

  test('continues with stop signal and logs observed entry', () => {
    const logStopEntry = jest.fn();
    const logStopCompare = jest.fn();

    const result = runEnginePreflight({
      chat: { id: 'chat-3' } as any,
      adapterContext: {} as any,
      logStopEntry,
      logStopCompare,
    });

    expect(result).toEqual({
      kind: 'continue',
      stopSignal: expect.objectContaining({ observed: true, reason: 'stop_schema_missing' }),
    });
    expect(attachStopGatewayContextMock).toHaveBeenCalled();
    expect(logStopEntry).toHaveBeenCalledWith(
      'entry',
      'observed',
      expect.objectContaining({ reason: 'stop_schema_missing', source: 'chat', eligible: true })
    );
    expect(logStopCompare).not.toHaveBeenCalled();
  });
});
