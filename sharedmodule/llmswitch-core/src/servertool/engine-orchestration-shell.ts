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
  readProviderProtocolFromAnyBoundMetadataCenter,
  readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter,
  readRuntimeControlFromAnyBoundMetadataCenter
} from './metadata-center-carrier.js';
import {
  planServertoolEngineRuntimeActionWithNative,
  planServertoolEngineSkipWithNative,
  parseServertoolTimeoutMsWithNative,
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
  providerProtocol: string;
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
    providerProtocol: args.providerProtocol,
    adapterContext: args.adapterContext,
    stageRecorder: args.stageRecorder,
    blue: '\x1b[38;5;39m',
    yellow: '\x1b[38;5;214m',
    gold: '\x1b[38;5;220m',
    reset: '\x1b[0m'
  });
}

function resolveServerToolTimeoutMs(): number {
  const raw = [
    'ROUTECODEX_SERVERTOOL_TIMEOUT_MS',
    'RCC_SERVERTOOL_TIMEOUT_MS',
    'LLMSWITCH_SERVERTOOL_TIMEOUT_MS'
  ].map((key) => process.env[key]).find((value) => Boolean(value));
  return parseServertoolTimeoutMsWithNative({ raw: raw || undefined });
}

export async function runServerToolOrchestrationShell(
  options: ServerToolOrchestrationOptions
): Promise<ServerToolOrchestrationResult> {
  const providerProtocol =
    readProviderProtocolFromAnyBoundMetadataCenter(options.adapterContext as Record<string, unknown>);
  if (!providerProtocol) {
    throw new Error('Servertool engine orchestration requires metadata center runtime_control.providerProtocol');
  }
  const {
    logStopEntry,
    logProgress,
    logAutoHookTrace,
    logStopCompare
  } = createProgressObservation({
    requestId: options.requestId,
    entryEndpoint: options.entryEndpoint,
    providerProtocol,
    adapterContext: options.adapterContext,
    stageRecorder: options.stageRecorder
  });

  const preflight = runEnginePreflight({
    chat: options.chat,
    adapterContext: options.adapterContext,
    logStopEntry,
    logStopCompare
  });
  if (preflight.kind === 'return_original_chat' || preflight.kind === 'return_original_chat_direct_passthrough') {
    return {
      chat: preflight.chat,
      executed: false
    };
  }
  const stopSignal = preflight.stopSignal;

  const serverToolTimeoutMs = resolveServerToolTimeoutMs();
  const engineOptions: ServerSideToolEngineOptions = {
    chatResponse: options.chat,
    adapterContext: options.adapterContext,
    entryEndpoint: options.entryEndpoint,
    requestId: options.requestId,
    providerProtocol,
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
    hasExecution: Boolean(engineResult.execution)
  });
  if (
    engineSkipPlan.action === 'return_skipped_passthrough' ||
    engineSkipPlan.action === 'return_skipped_no_execution'
  ) {
    const skipReason = typeof engineSkipPlan.skipReason === 'string' && engineSkipPlan.skipReason.trim()
      ? engineSkipPlan.skipReason.trim()
      : undefined;
    if (!skipReason) {
      throw new Error('[servertool] native engine skip plan missing skipReason');
    }
    if (stopSignal.observed) {
      logStopEntry('trigger', `skipped_${skipReason}`, {
        reason: stopSignal.reason,
        source: stopSignal.source,
        eligible: stopSignal.eligible
      });
      logStopCompare('trigger');
    }
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
  const requestTruth = metadataCenterSnapshot?.requestTruth as Record<string, unknown> | undefined;
  const rawSessionId = requestTruth?.sessionId;
  const requestTruthSessionId =
    typeof rawSessionId === 'string' && rawSessionId.trim()
      ? rawSessionId.trim()
      : undefined;
  const stoplessExecutionPlan = planStoplessExecutionWithNative({
    flowId,
    execution:
      engineResult.execution && typeof engineResult.execution === 'object'
        ? (engineResult.execution as unknown as Record<string, unknown>)
        : {},
    requestTruthSessionId,
    runtimeControl:
      runtimeControl && typeof runtimeControl === 'object'
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
  if (stopSignal.observed) {
    logStopEntry('trigger', 'non_stop_flow', {
      flowId,
      reason: stopSignal.reason,
      source: stopSignal.source,
      eligible: stopSignal.eligible
    });
    logStopCompare('trigger', flowId);
  }
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
