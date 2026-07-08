import * as fs from 'node:fs';
import { beforeEach, describe, expect, test, jest } from '@jest/globals';

const appendServertoolMatchSkippedProgressEventMock = jest.fn();
const logProgressMock = jest.fn();
const readRuntimeControlFromAnyBoundMetadataCenterMock = jest.fn(() => null);
const readRuntimeMetadataSnapshotFromAnyBoundMetadataCenterMock = jest.fn(() => null);
const buildServertoolPostflightObservationSummaryWithNativeMock = jest.fn();
const planServertoolEngineRuntimeActionWithNativeMock = jest.fn();
const resolveServertoolEngineMatchHitWithNativeMock = jest.fn();
const resolveServertoolEnginePostflightPayloadWithNativeMock = jest.fn();
const resolveServertoolEngineSkipDecisionWithNativeMock = jest.fn();
const planStoplessExecutionWithNativeMock = jest.fn();
const orchestrateServertoolEngineMock = jest.fn();
const planEngineSelectionStartWithNativeMock = jest.fn(() => ({
  overrides: {},
  primaryAutoHookIds: []
}));
const resolveEngineSelectionAfterRunWithNativeMock = jest.fn(() => ({
  rerunOverrides: null
}));

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/progress-log-block.js',
  () => ({
    appendServertoolMatchSkippedProgressEvent: appendServertoolMatchSkippedProgressEventMock,
    createServertoolProgressLogger: jest.fn(() => ({
      logStopEntry: jest.fn(),
      logProgress: logProgressMock,
      logAutoHookTrace: jest.fn(),
      logStopCompare: jest.fn()
    }))
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/run-server-side-tool-engine-shell.js',
  () => ({
    orchestrateServertoolEngine: orchestrateServertoolEngineMock
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
    readRuntimeControlFromAnyBoundMetadataCenter: readRuntimeControlFromAnyBoundMetadataCenterMock,
    readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter: readRuntimeMetadataSnapshotFromAnyBoundMetadataCenterMock,
    writeRuntimeControlToBoundMetadataCenter: jest.fn()
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
  'rcc-llmswitch-core/native/servertool-wrapper',
  () => ({
    buildServertoolPostflightObservationSummaryWithNative: buildServertoolPostflightObservationSummaryWithNativeMock,
    containsSyntheticRouteCodexControlTextWithNative: jest.fn(() => false),
    detectProviderResponseShapeWithNative: jest.fn(() => 'chat_completion'),
    extractServertoolResponseStageOrchestrationShellResultWithNative: jest.fn((output: any) => output.shellResult),
    materializeServertoolResponseStageOrchestrationOutputWithNative: jest.fn(),
    readServertoolPrimaryAutoHookIdsWithNative: jest.fn(() => []),
    planEngineSelectionStartWithNative: planEngineSelectionStartWithNativeMock,
    resolveEngineSelectionAfterRunWithNative: resolveEngineSelectionAfterRunWithNativeMock,
    planServertoolEngineRuntimeActionWithNative: planServertoolEngineRuntimeActionWithNativeMock,
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
    planServertoolResponseStageGateWithNative: jest.fn(),
    planServertoolEngineTriggerObservationWithNative: jest.fn(() => ({
      logStopEntry: null,
      logStopCompare: null
    })),
    resolveServertoolEngineMatchHitWithNative: resolveServertoolEngineMatchHitWithNativeMock,
    resolveServertoolEnginePreflightDecisionWithNative: jest.fn((input: any) => ({
      result: input.preflightAction.result,
      shouldRunSideEffects: false
    })),
    resolveServertoolEnginePostflightPayloadWithNative: resolveServertoolEnginePostflightPayloadWithNativeMock,
    resolveServertoolEngineSkipDecisionWithNative: resolveServertoolEngineSkipDecisionWithNativeMock,
    resolveServertoolEngineOrchestrationPreflightDecisionWithNative: jest.fn((input: any) => ({
      returnPreflightChat: false,
      stopSignal: input.preflight.stopSignal
    })),
    resolveServertoolResponseStageOrchestrationGateApplicationWithNative: jest.fn(),
    resolveServertoolTimeoutMsFromEnvCandidatesWithNative: jest.fn(() => 1000),
    planServertoolTimeoutErrorWithNative: jest.fn(),
    planStoplessExecutionWithNative: planStoplessExecutionWithNativeMock
  })
);

const { runServerToolOrchestrationShell } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.js'
);

function setSkippedEngineResult(chat: Record<string, unknown> = { id: 'chat-skip' }): void {
  orchestrateServertoolEngineMock.mockResolvedValue({
    mode: 'passthrough',
    finalChatResponse: chat,
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
}

function setHitEngineResult(args: {
  finalChatResponse?: Record<string, unknown>;
  execution?: Record<string, unknown>;
  projectedFlowId?: string;
} = {}): void {
  const execution = args.execution ?? { flowId: 'flow-match-hit' };
  orchestrateServertoolEngineMock.mockResolvedValue({
    mode: 'tool_flow',
    finalChatResponse: args.finalChatResponse ?? { id: 'chat-hit' },
    execution,
    metadataWritePlan: null
  });
  resolveServertoolEngineSkipDecisionWithNativeMock.mockReturnValue({
    returnSkipped: false
  });
  resolveServertoolEngineMatchHitWithNativeMock.mockImplementation((input: any) => {
    if (typeof input.execution?.flowId !== 'string') {
      throw new Error('Servertool match hit requires execution.flowId');
    }
    return { flowId: input.execution.flowId };
  });
  planStoplessExecutionWithNativeMock.mockImplementation((input: any) => ({
    execution: input.execution,
    orchestrationPlan: {
      isStopMessageFlow: false,
      action: 'return_servertool_cli_projection_final'
    }
  }));
  planServertoolEngineRuntimeActionWithNativeMock.mockImplementation((input: any) => ({
    action: 'return_servertool_cli_projection_final',
    executed: true,
    flowIdSource: 'engine_execution',
    progressStatus: 'completed (servertool cli projection; no reenter)',
    finalPayloadSource: 'engine_result',
    projectedFlowId: args.projectedFlowId ?? input.currentFlowId
  }));
  resolveServertoolEnginePostflightPayloadWithNativeMock.mockImplementation((input: any) => input.engineResult.finalChatResponse);
}

function runEngineForTest(stageRecorder?: { record: ReturnType<typeof jest.fn> }) {
  return runServerToolOrchestrationShell({
    chat: { id: 'chat-in' } as any,
    adapterContext: {} as any,
    requestId: 'req-engine-observation',
    entryEndpoint: '/v1/chat/completions',
    stageRecorder: stageRecorder as any
  });
}

describe('engine-observation-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    readRuntimeControlFromAnyBoundMetadataCenterMock.mockReturnValue(null);
    readRuntimeMetadataSnapshotFromAnyBoundMetadataCenterMock.mockReturnValue(null);
    buildServertoolPostflightObservationSummaryWithNativeMock.mockReturnValue({});
    planEngineSelectionStartWithNativeMock.mockReturnValue({
      overrides: {},
      primaryAutoHookIds: []
    });
    resolveEngineSelectionAfterRunWithNativeMock.mockReturnValue({
      rerunOverrides: null
    });
    setSkippedEngineResult();
  });

  test('engine.ts facade stays deleted and orchestration owner remains explicit', () => {
    expect(fs.existsSync('sharedmodule/llmswitch-core/src/servertool/engine.ts')).toBe(false);
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts',
      'utf8'
    );

    expect(source).toContain('export async function runServerToolOrchestrationShell(');
    expect(source).not.toContain('createServertoolObservation({');
    expect(source).toContain('recordServertoolEngineMatchSkipped({');
    expect(source).toContain('recordServertoolEngineMatchHit({');
    expect(source).toContain('runServertoolEnginePostflight');
    expect(source).toContain('runEnginePreflight');
    expect(source).toContain('planServertoolEngineRuntimeActionWithNative');
  });

  test('engine orchestration owns match logging fan-in without observation facade', async () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts',
      'utf8'
    );
    const orchestrationSource = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts',
      'utf8'
    );
    expect(fs.existsSync('sharedmodule/llmswitch-core/src/servertool/engine-observation-shell.ts')).toBe(false);

    expect(source).not.toContain('export function logServertoolNonBlocking(');
    expect(source).not.toContain('[servertool][non-blocking]');
    expect(source).not.toContain('export function createServertoolObservation(');
    expect(source).toContain('resolveServertoolEngineMatchHitWithNative({');
    expect(source).not.toContain('const flowId = args.execution.flowId');
    expect(source).not.toContain('flowId.trim()');
    expect(source).toContain('appendServertoolMatchSkippedProgressEvent({');
    expect(source).not.toContain('appendServerToolProgressFileEvent({');
    expect(source).not.toContain('readProviderProtocolFromAnyBoundMetadataCenter');
    expect(source).not.toContain(
      'Servertool observation requires metadata center runtime_control.providerProtocol'
    );
    expect(source).toContain("args.stageRecorder?.record('servertool.match'");
    expect(fs.existsSync('sharedmodule/llmswitch-core/src/servertool/match-log-block.ts')).toBe(false);
    expect(orchestrationSource).toContain('function createProgressObservation(');
    expect(orchestrationSource).toContain('createServertoolProgressLogger({');
    expect(orchestrationSource).not.toContain('readProviderProtocolFromAnyBoundMetadataCenter');
    expect(orchestrationSource).not.toContain(
      'Servertool engine orchestration requires metadata center runtime_control.providerProtocol'
    );
  });

  test('match stage recorder failures are fail-fast', async () => {
    const stageRecorder = {
      record: jest.fn(() => {
        throw new Error('stage recorder down');
      })
    };

    setSkippedEngineResult();
    await expect(runEngineForTest(stageRecorder)).rejects.toThrow('stage recorder down');

    setHitEngineResult({
      execution: {
        flowId: 'flow-match-hit',
        toolName: 'reasoningStop',
        toolCall: {
          id: 'call_match_hit',
          type: 'function',
          function: {
            name: 'reasoningStop',
            arguments: '{}'
          }
        },
        followup: null
      }
    });
    await expect(runEngineForTest(stageRecorder)).rejects.toThrow('stage recorder down');
  });

  test('match skipped consumes native skipReason instead of deriving it from engine mode', async () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts',
      'utf8'
    );
    const orchestrationSource = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts',
      'utf8'
    );

    expect(source).not.toContain("args.engineMode === 'passthrough' ? 'passthrough' : 'no_execution'");
    expect(orchestrationSource).not.toContain("engineSkipPlan.skipReason ?? 'no_execution'");
    expect(source).not.toContain('args.skipReason.trim()');
    expect(orchestrationSource).not.toContain('engineSkipPlan.skipReason.trim()');
    expect(orchestrationSource).not.toContain("throw new Error('[servertool] native engine skip plan missing skipReason')");
    expect(orchestrationSource).not.toContain('engineSkipPlan.skipReason as string');
    expect(orchestrationSource).toContain('skipReason: engineSkipDecision.skipReason');

    setSkippedEngineResult();
    await runEngineForTest();

    expect(appendServertoolMatchSkippedProgressEventMock).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'req-engine-observation',
      entryEndpoint: '/v1/chat/completions',
      skipReason: 'passthrough'
    }));
    expect(resolveServertoolEngineSkipDecisionWithNativeMock).toHaveBeenCalledWith(expect.objectContaining({
      engineMode: 'passthrough',
      hasExecution: false
    }));
  });

  test('match hit requires execution flowId instead of falling back to unknown', async () => {
    setHitEngineResult({
      execution: {
        toolName: 'reasoningStop',
        toolCall: {
          id: 'call_missing_flow',
          type: 'function',
          function: {
            name: 'reasoningStop',
            arguments: '{}'
          }
        },
        followup: null
      }
    });
    await expect(runEngineForTest()).rejects.toThrow('Servertool match hit requires execution.flowId');
  });

  test('postflight stage recorder failures are fail-fast', async () => {
    const stageRecorder = {
      record: jest.fn((stageId: string) => {
        if (stageId === 'servertool.execution') {
          throw new Error('postflight recorder down');
        }
      })
    };

    setHitEngineResult({
      execution: {
        flowId: 'flow-postflight-failfast',
        followup: null
      },
      finalChatResponse: {
        tool_outputs: [
          {
            tool_name: 'reasoningStop',
            tool_call_id: 'call_postflight_failfast',
            content: 'ok'
          }
        ]
      }
    });
    await expect(runEngineForTest(stageRecorder)).rejects.toThrow('postflight recorder down');
  });

  test('postflight observation summary is native-owned', async () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts',
      'utf8'
    );
    expect(fs.existsSync('sharedmodule/llmswitch-core/src/servertool/engine-postflight-shell.ts')).toBe(false);
    expect(source).toContain('buildServertoolPostflightObservationSummaryWithNative({');
    expect(source).not.toContain('const followupSummary: Record<string, unknown> = {');
    expect(source).not.toContain("if ('payload' in followup)");
    expect(source).not.toContain('followup.injection?.ops');
    expect(source).not.toContain("if (runtimeAction.action === 'return_servertool_cli_projection_final')");
    expect(source).not.toContain("if (runtimeAction.action === 'return_stop_message_terminal_final')");
    expect(source).not.toContain("if (runtimeAction.action === 'build_stop_message_cli_projection')");
    expect(source).not.toContain('switch (runtimeAction.finalPayloadSource)');
    expect(source).not.toContain("case 'engine_result'");
    expect(source).not.toContain("case 'stop_message_cli_projection'");
    expect(source).toContain('resolveServertoolEnginePostflightPayloadWithNative({');
    expect(source).not.toContain('resolvePostflightFlowId');
    expect(source).not.toContain('const projectedFlowId = runtimeAction.projectedFlowId;');
    expect(source).not.toContain('String((args.runtimeAction as { flowIdSource: unknown }).flowIdSource)');
    expect(source).not.toContain('runtimeAction.flowIdSource');
    expect(source).not.toContain('engineResult.execution?.flowId');
    expect(source).toContain('executed: runtimeAction.executed');
    expect(source).toContain('runtimeAction.progressStatus');
    expect(source).toContain('flowId: runtimeAction.projectedFlowId');
    expect(source).not.toContain('executed: true');
    expect(source).not.toContain('const nativeMetadataCenterSnapshot = metadataCenterSnapshot ?? (');
    expect(source).not.toContain('runtimeMetadataSnapshot?.metadataCenterSnapshot as Record<string, unknown>');
    expect(source).not.toContain('runtimeControl ? { runtimeControl } : null');
    expect(source).not.toContain("engineResult.metadataWritePlan && typeof engineResult.metadataWritePlan === 'object'");
    expect(source).not.toContain('projectNativeMetadataWritePlanToRuntimeControl(');
    expect(source).not.toContain('Object.keys(runtimeControl).length');
    expect(source).toContain('projectMetadataWritePlanToRuntimeControlWritePlanWithNative({');
    expect(source).toContain('plan: engineResult.metadataWritePlan');
    expect(source).toContain('if (writePlan.runtimeControl)');
    expect(source).toContain("engineResult.metadataWritePlan != null && typeof engineResult.metadataWritePlan === 'object'");
    expect(source).toContain('const metadataCenterSnapshot = runtimeMetadataSnapshot?.metadataCenterSnapshot;');
    expect(source).toContain('metadataCenterSnapshot: metadataCenterSnapshot ?? null');

    const stageRecorder = {
      record: jest.fn()
    };

    buildServertoolPostflightObservationSummaryWithNativeMock.mockReturnValue({
      mode: 'tool_flow',
      flowId: 'flow-postflight-summary',
      hasFollowup: true,
      toolOutputCount: 1,
      toolName: 'reasoningStop',
      toolCallId: 'call_postflight_summary',
      toolOutputContent: 'ok',
      followup: {
        mode: 'injection',
        injectionOps: ['append']
      }
    });
    setHitEngineResult({
      execution: {
        flowId: 'flow-postflight-summary',
        followup: {
          injection: {
            ops: [{ op: 'append' }, { op: 1 }]
          }
        }
      },
      finalChatResponse: {
        tool_outputs: [
          {
            tool_name: 'reasoningStop',
            tool_call_id: 'call_postflight_summary',
            content: 'ok'
          }
        ]
      }
    });
    await runEngineForTest(stageRecorder);

    expect(stageRecorder.record).toHaveBeenCalledWith(
      'servertool.execution',
      expect.objectContaining({
        mode: 'tool_flow',
        flowId: 'flow-postflight-summary',
        hasFollowup: true,
        toolOutputCount: 1,
        toolName: 'reasoningStop',
        toolCallId: 'call_postflight_summary',
        toolOutputContent: 'ok',
        followup: {
          mode: 'injection',
          injectionOps: ['append']
        }
      })
    );
  });

  test('postflight consumes Rust-projected flow id without interpreting flowIdSource in TS', async () => {
    setHitEngineResult({
      finalChatResponse: { id: 'chat-postflight-rust-projected-flow' },
      execution: {
        flowId: 'flow-engine-ts-must-not-read'
      },
      projectedFlowId: 'flow-rust-projected'
    });

    await expect(runEngineForTest()).resolves.toEqual({
      chat: { id: 'chat-postflight-rust-projected-flow' },
      executed: true,
      flowId: 'flow-rust-projected'
    });
  });

  test('engine-orchestration-shell owns the engine mainline body', () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts',
      'utf8'
    );

    expect(source).toContain('export async function runServerToolOrchestrationShell(');
    expect(source).not.toContain('export type EnginePreflightResult');
    expect(source).not.toContain('export interface ServerToolOrchestrationOptions');
    expect(source).not.toContain('export interface ServertoolResponseStageShellOptions');
    expect(source).not.toContain('export interface ServertoolResponseStageShellResult');
    expect(source).not.toContain('export interface ServerToolOrchestrationResult');
    expect(source).not.toContain('export function runEnginePreflight(');
    expect(source).not.toContain('export function recordServertoolEngineMatchSkipped(');
    expect(source).not.toContain('export function recordServertoolEngineMatchHit(');
    expect(source).not.toContain('export async function runServertoolEnginePostflight(');
    expect(source).not.toMatch(/export interface ServerToolOrchestrationOptions\s*\{[\s\S]{0,220}providerProtocol:\s*string;/);
    expect(source).not.toContain('readProviderProtocolFromAnyBoundMetadataCenter');
    expect(source).not.toContain('providerProtocol: args.providerProtocol');
    expect(source).toContain('createProgressObservation({');
    expect(source).toContain('runEnginePreflight({');
    expect(source).not.toContain("if (preflight.kind === 'return_original_chat' || preflight.kind === 'return_original_chat_direct_passthrough')");
    expect(source).not.toContain('const preflightKind = preflight.kind');
    expect(source).not.toContain('switch (preflightKind)');
    expect(source).toContain('resolveServertoolEngineOrchestrationPreflightDecisionWithNative({');
    expect(source).not.toContain('switch (preflightOrchestrationAction.action)');
    expect(source).not.toContain('String(preflightOrchestrationAction.action)');
    expect(source).toContain('resolveServertoolEngineSkipDecisionWithNative({');
    expect(source).not.toContain('switch (engineSkipPlan.action)');
    expect(source).not.toContain('hasServertoolCliProjectionContext:');
    expect(source).toContain('stoplessExecutionFlowId:');
    expect(source).not.toContain('const engineSkipAction = engineSkipPlan.action as');
    expect(source).not.toContain("engineSkipPlan.action === 'return_skipped_passthrough' ||");
    expect(source).not.toContain("engineSkipPlan.action === 'return_skipped_no_execution'");
    expect(source).not.toContain('Boolean(engineResult.execution)');
    expect(source).not.toContain("engineResult.execution && typeof engineResult.execution === 'object'");
    expect(source).toContain("engineResult.execution != null && typeof engineResult.execution === 'object'");
    expect(source).not.toContain("runtimeControl && typeof runtimeControl === 'object'");
    expect(source).not.toContain("runtimeControl != null && typeof runtimeControl === 'object'");
    expect(source).toContain('runtimeControl: runtimeControl ?? null');
    expect(source).toContain('hasExecution: engineResult.execution != null');
    expect(source).toContain('finalChatResponse: engineResult.finalChatResponse');
    expect(source).not.toContain("throw new Error('[servertool] native engine skip plan missing skipReason')");
    expect(source).not.toContain('engineSkipPlan.skipReason as string');
    expect(source).toContain('skipReason: engineSkipDecision.skipReason');
    expect(source).toContain('result: engineSkipDecision.triggerResult');
    expect(source).toContain('return engineSkipDecision.shellResult;');
    expect(source).not.toContain('result: `skipped_${skipReason}`');
    expect(source).toContain('planServertoolTimeoutErrorWithNative({');
    expect(source).toContain('createServertoolProviderProtocolErrorFromPlan(');
    expect(source).toContain('recordServertoolEngineMatchSkipped({');
    expect(source).toContain('recordServertoolEngineMatchHit({');
    expect(source).toContain('const stoplessExecutionPlan = planStoplessExecutionWithNative({');
    expect(source).toContain('const runtimeAction = planServertoolEngineRuntimeActionWithNative({');
    expect(source).not.toContain('function planStoplessEngineRuntime(');
    expect(source).not.toContain('const stoplessExecutionInput = {');
    expect(source).toContain('runServertoolEnginePostflight({');
    expect(source).not.toContain('effectiveServerToolTimeoutMs');
    expect(source).not.toContain('args.effectiveServerToolTimeoutMs || args.serverToolTimeoutMs');
    expect(source).not.toContain('function createServerToolEngineRunner(');
    expect(source).not.toContain('createServerToolTimeoutError(');
    expect(source).not.toContain('function isServertoolStageTimingDetailEnabled(');
    expect(source).not.toContain('function logServertoolStageTiming(');
    expect(source).not.toContain('[servertool.detail]');
    expect(source).not.toContain('ROUTECODEX_STAGE_TIMING');
    expect(source).not.toContain('RCC_STAGE_TIMING');
    expect(source).not.toContain('forceLog: forceDetailLog');
  });
});
