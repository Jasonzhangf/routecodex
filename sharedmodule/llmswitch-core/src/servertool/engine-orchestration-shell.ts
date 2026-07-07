import type {
  AdapterContext,
  JsonObject,
  ServerSideToolEngineOptions,
  StageRecorder,
  ServerToolExecution,
  ServerSideToolEngineResult
} from './types.js';
import { orchestrateServertoolEngine } from './run-server-side-tool-engine-shell.js';
import {
  createServertoolProviderProtocolErrorFromPlan,
  withTimeout
} from './timeout-error-block.js';
import {
  runPrimaryServerToolEngineSelection
} from './engine-selection-block.js';
import {
  appendServertoolMatchSkippedProgressEvent,
  createServertoolProgressLogger
} from './progress-log-block.js';
import { runEnginePreflight } from './engine-preflight-shell.js';
import {
  readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter,
  readRuntimeControlFromAnyBoundMetadataCenter,
  writeRuntimeControlToBoundMetadataCenter
} from './metadata-center-carrier.js';
import {
  projectMetadataWritePlanToRuntimeControlWritePlanWithNative
} from '../native/router-hotpath/native-hub-pipeline-orchestration-semantics-protocol.js';
import {
  type ServertoolEngineRuntimeActionPlan,
  buildServertoolPostflightObservationSummaryWithNative,
  planServertoolEngineRuntimeActionWithNative,
  planServertoolEngineTriggerObservationWithNative,
  resolveServertoolEngineMatchHitWithNative,
  resolveServertoolEnginePostflightPayloadWithNative,
  resolveServertoolEngineSkipDecisionWithNative,
  resolveServertoolEngineOrchestrationPreflightDecisionWithNative,
  resolveServertoolTimeoutMsFromEnvCandidatesWithNative,
  planServertoolTimeoutErrorWithNative,
  planStoplessExecutionWithNative
} from 'rcc-llmswitch-core/native/servertool-wrapper';

const SERVERTOOL_POSTFLIGHT_RUNTIME_CONTROL_WRITER = {
  module: 'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts',
  symbol: 'runServertoolEnginePostflight',
  stage: 'HubRespChatProcess03Governed',
} as const;

export interface ServerToolOrchestrationOptions {
  chat: JsonObject;
  adapterContext: AdapterContext;
  requestId: string;
  entryEndpoint: string;
  stageRecorder?: StageRecorder;
}

export function recordServertoolEngineMatchSkipped(args: {
  requestId: string;
  entryEndpoint: string;
  engineMode: 'passthrough' | 'tool_flow';
  skipReason: string;
  stageRecorder?: StageRecorder;
  adapterContext?: AdapterContext;
}): void {
  args.stageRecorder?.record('servertool.match', {
    matched: false,
    mode: args.engineMode,
    reason: args.skipReason
  });
  appendServertoolMatchSkippedProgressEvent({
    requestId: args.requestId,
    entryEndpoint: args.entryEndpoint,
    adapterContext: args.adapterContext,
    skipReason: args.skipReason
  });
}

export function recordServertoolEngineMatchHit(args: {
  requestId: string;
  execution: ServerToolExecution;
  stageRecorder?: StageRecorder;
}): string {
  const { flowId } = resolveServertoolEngineMatchHitWithNative({
    execution: args.execution
  });
  args.stageRecorder?.record('servertool.match', {
    matched: true,
    flowId,
    hasFollowup: false
  });
  return flowId;
}

export async function runServertoolEnginePostflight(args: {
  options: {
    requestId: string;
    adapterContext: AdapterContext;
  };
  engineResult: ServerSideToolEngineResult;
  runtimeAction: ServertoolEngineRuntimeActionPlan;
  flowId: string;
  totalSteps: number;
  stageRecorder?: StageRecorder;
  logProgress: (step: number, total: number, status: string, details?: Record<string, unknown>) => void;
}): Promise<
  | {
      chat: JsonObject;
      executed: boolean;
      flowId?: string;
    }
  | undefined
> {
  const { engineResult, runtimeAction, options, flowId, totalSteps } = args;
  if (engineResult.metadataWritePlan != null && typeof engineResult.metadataWritePlan === 'object') {
    const writePlan = projectMetadataWritePlanToRuntimeControlWritePlanWithNative({
      plan: engineResult.metadataWritePlan
    });
    if (writePlan.runtimeControl) {
      for (const [key, value] of Object.entries(writePlan.runtimeControl)) {
        if (value === undefined) {
          continue;
        }
        writeRuntimeControlToBoundMetadataCenter({
          metadata: options.adapterContext,
          key,
          value,
          writer: SERVERTOOL_POSTFLIGHT_RUNTIME_CONTROL_WRITER,
          reason: 'rust servertool postflight runtime control',
          required: true
        });
      }
    }
  }

  if (args.stageRecorder) {
    const summary = buildServertoolPostflightObservationSummaryWithNative({
      engineResult
    });
    args.stageRecorder.record('servertool.execution', summary);
  }
  const runtimeMetadataSnapshot = readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter(options.adapterContext);
  const metadataCenterSnapshot = runtimeMetadataSnapshot?.metadataCenterSnapshot;
  const chat = resolveServertoolEnginePostflightPayloadWithNative({
    runtimeAction,
    engineResult,
    metadataCenterSnapshot: metadataCenterSnapshot ?? null,
    requestId: options.requestId ?? null
  });
  args.logProgress(5, totalSteps, runtimeAction.progressStatus, { flowId });
  return {
    chat,
    executed: runtimeAction.executed,
    flowId: runtimeAction.projectedFlowId
  };
}

export interface ServerToolOrchestrationResult {
  chat: JsonObject;
  executed: boolean;
  flowId?: string;
}

type ServerToolEngineResult = Awaited<ReturnType<typeof orchestrateServertoolEngine>>;
type ServertoolProgressLogger = ReturnType<typeof createServertoolProgressLogger>;

function createProgressObservation(args: {
  requestId: string;
  entryEndpoint: string;
  adapterContext: AdapterContext;
  stageRecorder?: StageRecorder;
}): {
  logStopEntry: ServertoolProgressLogger['logStopEntry'];
  logProgress: ServertoolProgressLogger['logProgress'];
  logAutoHookTrace: ServertoolProgressLogger['logAutoHookTrace'];
  logStopCompare: ServertoolProgressLogger['logStopCompare'];
} {
  return createServertoolProgressLogger({
    requestId: args.requestId,
    entryEndpoint: args.entryEndpoint,
    adapterContext: args.adapterContext,
    stageRecorder: args.stageRecorder,
    blue: '\x1b[38;5;39m',
    yellow: '\x1b[38;5;214m',
    gold: '\x1b[38;5;220m',
    reset: '\x1b[0m'
  });
}

function runTriggerObservationPlan(args: {
  stopSignal: NonNullable<Extract<ReturnType<typeof runEnginePreflight>, { kind: 'continue' }>['stopSignal']>;
  result: string;
  flowId?: string;
  logStopEntry: ServertoolProgressLogger['logStopEntry'];
  logStopCompare: ServertoolProgressLogger['logStopCompare'];
}): void {
  const triggerObservationPlan = planServertoolEngineTriggerObservationWithNative({
    stopSignalObserved: args.stopSignal.observed,
    result: args.result,
    ...(args.flowId !== undefined ? { flowId: args.flowId } : {})
  });
  const entry = triggerObservationPlan.logStopEntry;
  if (entry) {
    args.logStopEntry(entry.stage, entry.result, {
      ...(args.flowId !== undefined ? { flowId: args.flowId } : {}),
      reason: args.stopSignal.reason,
      source: args.stopSignal.source,
      eligible: args.stopSignal.eligible
    });
  }
  const compare = triggerObservationPlan.logStopCompare;
  if (compare) {
    args.logStopCompare(compare.stage, compare.flowId);
  }
}

function resolveServerToolTimeoutMs(): number {
  return resolveServertoolTimeoutMsFromEnvCandidatesWithNative({
    candidates: [
      {
        key: 'ROUTECODEX_SERVERTOOL_TIMEOUT_MS',
        value: process.env.ROUTECODEX_SERVERTOOL_TIMEOUT_MS
      },
      {
        key: 'RCC_SERVERTOOL_TIMEOUT_MS',
        value: process.env.RCC_SERVERTOOL_TIMEOUT_MS
      },
      {
        key: 'LLMSWITCH_SERVERTOOL_TIMEOUT_MS',
        value: process.env.LLMSWITCH_SERVERTOOL_TIMEOUT_MS
      }
    ]
  });
}

export async function runServerToolOrchestrationShell(
  options: ServerToolOrchestrationOptions
): Promise<ServerToolOrchestrationResult> {
  const {
    logStopEntry,
    logProgress,
    logAutoHookTrace,
    logStopCompare
  } = createProgressObservation({
    requestId: options.requestId,
    entryEndpoint: options.entryEndpoint,
    adapterContext: options.adapterContext,
    stageRecorder: options.stageRecorder
  });

  const preflight = runEnginePreflight({
    chat: options.chat,
    adapterContext: options.adapterContext,
    logStopEntry,
    logStopCompare
  });
  let stopSignal: NonNullable<Extract<typeof preflight, { kind: 'continue' }>['stopSignal']>;
  const preflightDecision = resolveServertoolEngineOrchestrationPreflightDecisionWithNative({
    preflight
  });
  if (preflightDecision.returnPreflightChat) {
    return {
      chat: preflightDecision.chat as JsonObject,
      executed: false
    };
  }
  stopSignal = preflightDecision.stopSignal as NonNullable<Extract<typeof preflight, { kind: 'continue' }>['stopSignal']>;

  const serverToolTimeoutMs = resolveServerToolTimeoutMs();
  const engineOptions: ServerSideToolEngineOptions = {
    chatResponse: options.chat,
    adapterContext: options.adapterContext,
    entryEndpoint: options.entryEndpoint,
    requestId: options.requestId,
    onAutoHookTrace: logAutoHookTrace
  };

  const engineResult = await runPrimaryServerToolEngineSelection({
    runEngine: (overrides: Partial<ServerSideToolEngineOptions>): Promise<ServerToolEngineResult> =>
      withTimeout(
        orchestrateServertoolEngine({
          ...engineOptions,
          ...overrides
        }),
        serverToolTimeoutMs,
        () =>
          createServertoolProviderProtocolErrorFromPlan(
            planServertoolTimeoutErrorWithNative({
              requestId: options.requestId,
              phase: 'engine',
              timeoutMs: serverToolTimeoutMs
            })
          )
      )
  });
  const engineSkipDecision = resolveServertoolEngineSkipDecisionWithNative({
    engineMode: engineResult.mode,
    hasExecution: engineResult.execution != null,
    finalChatResponse: engineResult.finalChatResponse
  });
  if (engineSkipDecision.returnSkipped) {
    runTriggerObservationPlan({
      stopSignal,
      result: engineSkipDecision.triggerResult,
      logStopEntry,
      logStopCompare
    });
    recordServertoolEngineMatchSkipped({
      requestId: options.requestId,
      entryEndpoint: options.entryEndpoint,
      engineMode: engineResult.mode,
      skipReason: engineSkipDecision.skipReason,
      stageRecorder: options.stageRecorder,
      adapterContext: options.adapterContext
    });
    return engineSkipDecision.shellResult;
  }

  const flowId = recordServertoolEngineMatchHit({
    requestId: options.requestId,
    stageRecorder: options.stageRecorder,
    execution: engineResult.execution
  });
  const totalSteps = 5;
  const runtimeControl = readRuntimeControlFromAnyBoundMetadataCenter(options.adapterContext);
  const runtimeMetadataSnapshot = readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter(options.adapterContext);
  const metadataCenterSnapshot = runtimeMetadataSnapshot?.metadataCenterSnapshot;
  const stoplessExecutionPlan = planStoplessExecutionWithNative({
    flowId,
    execution:
      engineResult.execution != null && typeof engineResult.execution === 'object'
        ? engineResult.execution
        : {},
    metadataCenterSnapshot: metadataCenterSnapshot ?? null,
    runtimeControl: runtimeControl ?? null
  });
  const stoplessExecution = stoplessExecutionPlan.execution;
  const stoplessPlan = stoplessExecutionPlan.orchestrationPlan;
  const runtimeAction = planServertoolEngineRuntimeActionWithNative({
    isStopMessageFlow: stoplessPlan.isStopMessageFlow === true,
    stoplessExecutionFlowId: typeof stoplessExecution.flowId === 'string' ? stoplessExecution.flowId : undefined,
    stoplessAction: stoplessPlan.action,
    engineExecutionFlowId: typeof stoplessExecution.flowId === 'string' ? stoplessExecution.flowId : undefined,
    currentFlowId: flowId
  });
  runTriggerObservationPlan({
    stopSignal,
    result: 'non_stop_flow',
    flowId,
    logStopEntry,
    logStopCompare
  });
  logProgress(1, totalSteps, 'matched', { flowId });
  return runServertoolEnginePostflight({
    options: {
      requestId: options.requestId,
      adapterContext: options.adapterContext
    },
    engineResult: {
      ...engineResult,
      execution: stoplessExecution as unknown as typeof engineResult.execution
    },
    runtimeAction,
    flowId,
    totalSteps,
    stageRecorder: options.stageRecorder,
    logProgress
  });
}
