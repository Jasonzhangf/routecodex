import fs from 'node:fs';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { ServerSideToolEngineResult } from '../../sharedmodule/llmswitch-core/src/servertool/types.js';

const DEFAULT_PRIMARY_AUTO_HOOK_IDS: string[] = [];

const orchestrateServertoolEngineMock = jest.fn();
const readServertoolPrimaryAutoHookIdsWithNativeMock = jest.fn(() => DEFAULT_PRIMARY_AUTO_HOOK_IDS);
const planEngineSelectionStartWithNativeMock = jest.fn(() => ({
  overrides: {
    disableToolCallHandlers: true,
    includeAutoHookIds: DEFAULT_PRIMARY_AUTO_HOOK_IDS
  },
  primaryAutoHookIds: DEFAULT_PRIMARY_AUTO_HOOK_IDS
}));
const resolveEngineSelectionAfterRunWithNativeMock = jest.fn(() => ({
  rerunOverrides: null
}));

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/run-server-side-tool-engine-shell.js',
  () => ({
    orchestrateServertoolEngine: orchestrateServertoolEngineMock
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/timeout-error-block.js',
  () => ({
    createServertoolProviderProtocolErrorFromPlan: jest.fn((plan: unknown) => plan),
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
  '../../sharedmodule/llmswitch-core/src/servertool/metadata-center-carrier.js',
  () => ({
    attachStopGatewayContext: jest.fn(),
    inspectStopGatewaySignal: jest.fn(() => ({
      observed: true,
      reason: 'stop',
      source: 'chat',
      eligible: true
    })),
    readRuntimeControlFromAnyBoundMetadataCenter: jest.fn(() => null),
    readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter: jest.fn(() => null),
    writeRuntimeControlToBoundMetadataCenter: jest.fn()
  })
);

jest.unstable_mockModule(
  'rcc-llmswitch-core/native/servertool-wrapper',
  () => ({
    buildServertoolPostflightObservationSummaryWithNative: jest.fn(),
    containsSyntheticRouteCodexControlTextWithNative: jest.fn(() => false),
    detectProviderResponseShapeWithNative: jest.fn(() => 'chat_completion'),
    extractServertoolResponseStageOrchestrationShellResultWithNative: jest.fn((output: any) => output.shellResult),
    materializeServertoolResponseStageOrchestrationOutputWithNative: jest.fn(),
    planEngineSelectionStartWithNative: planEngineSelectionStartWithNativeMock,
    planServertoolEngineRuntimeActionWithNative: jest.fn((input: any) => ({
      action: 'return_servertool_cli_projection_final',
      executed: true,
      progressStatus: 'completed',
      finalPayloadSource: 'engine_result',
      projectedFlowId: input.currentFlowId
    })),
    planServertoolEnginePreflightWithNative: jest.fn(() => ({
      action: 'continue_to_engine',
      attachStopGatewayContext: false,
      result: {
        kind: 'continue',
        stopSignal: {
          observed: true,
          reason: 'stop',
          source: 'chat',
          eligible: true
        }
      }
    })),
    planServertoolEngineTriggerObservationWithNative: jest.fn(() => ({
      logStopEntry: null,
      logStopCompare: null
    })),
    planServertoolResponseStageGateWithNative: jest.fn(),
    planServertoolTimeoutErrorWithNative: jest.fn(),
    planStoplessExecutionWithNative: jest.fn((input: any) => ({
      execution: input.execution,
      orchestrationPlan: {
        isStopMessageFlow: false,
        action: 'return_servertool_cli_projection_final'
      }
    })),
    readServertoolPrimaryAutoHookIdsWithNative: readServertoolPrimaryAutoHookIdsWithNativeMock,
    resolveEngineSelectionAfterRunWithNative: resolveEngineSelectionAfterRunWithNativeMock,
    resolveServertoolEngineMatchHitWithNative: jest.fn((input: any) => ({
      flowId: input.execution.flowId
    })),
    resolveServertoolEngineOrchestrationPreflightDecisionWithNative: jest.fn((input: any) => ({
      returnPreflightChat: false,
      stopSignal: input.preflight.stopSignal
    })),
    resolveServertoolEnginePostflightPayloadWithNative: jest.fn((input: any) => input.engineResult.finalChatResponse),
    resolveServertoolEnginePreflightDecisionWithNative: jest.fn((input: any) => ({
      result: input.preflightAction.result,
      shouldRunSideEffects: false
    })),
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
    resolveServertoolResponseStageOrchestrationGateApplicationWithNative: jest.fn(),
    resolveServertoolTimeoutMsFromEnvCandidatesWithNative: jest.fn(() => 1000)
  })
);

const { runServerToolOrchestrationShell } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.js'
);

function makeResult(partial: Partial<ServerSideToolEngineResult> = {}): ServerSideToolEngineResult {
  return {
    mode: 'tool_flow',
    finalChatResponse: { id: 'chatcmpl-engine-selection' },
    execution: { flowId: 'selected_flow' },
    ...partial
  };
}

async function runPublicEngineSelection() {
  return runServerToolOrchestrationShell({
    chat: { id: 'chatcmpl-engine-selection-input' },
    adapterContext: {} as any,
    requestId: 'req-engine-selection',
    entryEndpoint: '/v1/chat/completions'
  });
}

describe('servertool engine selection block', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    readServertoolPrimaryAutoHookIdsWithNativeMock.mockReturnValue(DEFAULT_PRIMARY_AUTO_HOOK_IDS);
    planEngineSelectionStartWithNativeMock.mockReturnValue({
      overrides: {
        disableToolCallHandlers: true,
        includeAutoHookIds: DEFAULT_PRIMARY_AUTO_HOOK_IDS
      },
      primaryAutoHookIds: DEFAULT_PRIMARY_AUTO_HOOK_IDS
    });
    resolveEngineSelectionAfterRunWithNativeMock.mockReturnValue({
      rerunOverrides: null
    });
    orchestrateServertoolEngineMock.mockResolvedValue(makeResult());
  });

  test('standalone engine selection block stays deleted and engine shell consumes native plan directly', () => {
    const deletedPath = 'sharedmodule/llmswitch-core/src/servertool/engine-selection-block.ts';
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts',
      'utf8'
    );

    expect(fs.existsSync(deletedPath)).toBe(false);
    expect(source).not.toContain("from './engine-selection-block.js'");
    expect(source).toContain('readServertoolPrimaryAutoHookIdsWithNative');
    expect(source).toContain('planEngineSelectionStartWithNative');
    expect(source).toContain('resolveEngineSelectionAfterRunWithNative');
    expect(source).toContain('runServertoolEngineWithNativeSelectionPlan({');
    expect(source).not.toContain('primaryAutoHookIds.length');
    expect(source).not.toContain("mode === 'passthrough'");
    expect(source).not.toContain("if (afterRunPlan.action === 'rerun_excluding_primary_hooks')");
    expect(source).not.toContain('switch (afterRunPlan.action)');
    expect(source).not.toContain("[servertool] invalid engine selection action");
  });

  test('runs primary hooks first and returns current result when Rust selection says no rerun', async () => {
    await expect(runPublicEngineSelection()).resolves.toEqual({
      chat: { id: 'chatcmpl-engine-selection' },
      executed: true,
      flowId: 'selected_flow'
    });

    expect(readServertoolPrimaryAutoHookIdsWithNativeMock).toHaveBeenCalledTimes(1);
    expect(planEngineSelectionStartWithNativeMock).toHaveBeenCalledWith({
      primaryAutoHookIds: DEFAULT_PRIMARY_AUTO_HOOK_IDS
    });
    expect(orchestrateServertoolEngineMock).toHaveBeenCalledTimes(1);
    expect(orchestrateServertoolEngineMock).toHaveBeenCalledWith(expect.objectContaining({
      disableToolCallHandlers: true,
      includeAutoHookIds: DEFAULT_PRIMARY_AUTO_HOOK_IDS
    }));
    expect(resolveEngineSelectionAfterRunWithNativeMock).toHaveBeenCalledWith({
      primaryAutoHookIds: DEFAULT_PRIMARY_AUTO_HOOK_IDS,
      engineResult: expect.objectContaining({
        execution: { flowId: 'selected_flow' }
      })
    });
  });

  test('reruns with Rust-projected overrides after primary pass result has no execution', async () => {
    orchestrateServertoolEngineMock
      .mockResolvedValueOnce(makeResult({ mode: 'passthrough', execution: null }))
      .mockResolvedValueOnce(makeResult({ execution: { flowId: 'fallback_flow' } }));
    resolveEngineSelectionAfterRunWithNativeMock.mockReturnValue({
      rerunOverrides: {
        excludeAutoHookIds: DEFAULT_PRIMARY_AUTO_HOOK_IDS
      }
    });

    await expect(runPublicEngineSelection()).resolves.toEqual({
      chat: { id: 'chatcmpl-engine-selection' },
      executed: true,
      flowId: 'fallback_flow'
    });

    expect(orchestrateServertoolEngineMock).toHaveBeenCalledTimes(2);
    expect(orchestrateServertoolEngineMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      disableToolCallHandlers: true,
      includeAutoHookIds: DEFAULT_PRIMARY_AUTO_HOOK_IDS
    }));
    expect(orchestrateServertoolEngineMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      excludeAutoHookIds: DEFAULT_PRIMARY_AUTO_HOOK_IDS
    }));
    expect(resolveEngineSelectionAfterRunWithNativeMock).toHaveBeenCalledWith({
      primaryAutoHookIds: DEFAULT_PRIMARY_AUTO_HOOK_IDS,
      engineResult: expect.objectContaining({
        mode: 'passthrough',
        execution: null
      })
    });
  });
});
