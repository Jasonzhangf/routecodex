import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ServerSideToolEngineOptions } from './types.js';
import { orchestrateServertoolEngine } from './run-server-side-tool-engine-shell.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import {
  createServertoolProviderProtocolErrorFromPlan,
  withTimeout
} from './timeout-error-block.js';
import {
  runPrimaryServerToolEngineSelection
} from './engine-selection-block.js';
import {
  runServertoolEnginePostflight
} from './engine-postflight-shell.js';
import {
  recordServertoolEngineMatchHit,
  recordServertoolEngineMatchSkipped
} from './engine-observation-shell.js';
import { createServertoolProgressLogger } from './progress-log-block.js';
import { runEnginePreflight } from './engine-preflight-shell.js';
import {
  readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter,
  readRuntimeControlFromAnyBoundMetadataCenter
} from './metadata-center-carrier.js';
import {
  planServertoolEngineRuntimeActionWithNative,
  planServertoolEngineTriggerObservationWithNative,
  planServertoolEngineSkipWithNative,
  planServertoolEngineOrchestrationPreflightActionWithNative,
  resolveServertoolTimeoutMsFromEnvCandidatesWithNative,
  planServertoolTimeoutErrorWithNative,
  planStoplessExecutionWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';

export interface ServerToolOrchestrationOptions {
  chat: JsonObject;
  adapterContext: AdapterContext;
  requestId: string;
  entryEndpoint: string;
  stageRecorder?: StageRecorder;
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
  const preflightChat = (preflight as { chat?: JsonObject }).chat;
  const preflightStopSignal = (preflight as { stopSignal?: typeof stopSignal }).stopSignal;
  const preflightOrchestrationAction = planServertoolEngineOrchestrationPreflightActionWithNative({
    preflightKind: preflight.kind
  });
  switch (preflightOrchestrationAction.action) {
    case 'return_preflight_chat':
      return {
        chat: preflightChat as JsonObject,
        executed: false
      };
    case 'continue_engine':
      stopSignal = preflightStopSignal as typeof stopSignal;
      break;
    default:
      throw new Error(
        `[servertool] invalid engine preflight orchestration action: ${String(preflightOrchestrationAction.action)}`
      );
  }

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
  const engineSkipPlan = planServertoolEngineSkipWithNative({
    engineMode: engineResult.mode,
    hasExecution: engineResult.execution != null
  });
  switch (engineSkipPlan.action) {
    case 'return_skipped_passthrough':
    case 'return_skipped_no_execution': {
      const skipReason = engineSkipPlan.skipReason as string;
      runTriggerObservationPlan({
        stopSignal,
        result: `skipped_${skipReason}`,
        logStopEntry,
        logStopCompare
      });
      recordServertoolEngineMatchSkipped({
        requestId: options.requestId,
        entryEndpoint: options.entryEndpoint,
        engineMode: engineResult.mode,
        skipReason,
        stageRecorder: options.stageRecorder,
        adapterContext: options.adapterContext
      });
      return {
        chat: engineResult.finalChatResponse,
        executed: false
      };
    }
    case 'continue_matched_flow':
      break;
    default:
      throw new Error(`[servertool] invalid engine skip action: ${String(engineSkipPlan.action)}`);
  }

  const flowId = recordServertoolEngineMatchHit({
    requestId: options.requestId,
    stageRecorder: options.stageRecorder,
    execution: engineResult.execution
  });
  const totalSteps = 5;
  const runtimeControl = readRuntimeControlFromAnyBoundMetadataCenter(
    options.adapterContext as Record<string, unknown>
  );
  const runtimeMetadataSnapshot = readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter(
    options.adapterContext as Record<string, unknown>
  );
  const metadataCenterSnapshot = runtimeMetadataSnapshot?.metadataCenterSnapshot as Record<string, unknown> | undefined;
  const stoplessExecutionPlan = planStoplessExecutionWithNative({
    flowId,
    execution:
      engineResult.execution != null && typeof engineResult.execution === 'object'
        ? (engineResult.execution as unknown as Record<string, unknown>)
        : {},
    metadataCenterSnapshot: metadataCenterSnapshot ?? null,
    runtimeControl:
      runtimeControl != null && typeof runtimeControl === 'object'
        ? (runtimeControl as Record<string, unknown>)
        : null
  });
  const stoplessExecution = stoplessExecutionPlan.execution;
  const stoplessPlan = stoplessExecutionPlan.orchestrationPlan;
  const runtimeAction = planServertoolEngineRuntimeActionWithNative({
    isStopMessageFlow: stoplessPlan.isStopMessageFlow === true,
    hasServertoolCliProjectionContext: stoplessExecution.flowId === 'servertool_cli_projection',
    stoplessAction: stoplessPlan.action
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
