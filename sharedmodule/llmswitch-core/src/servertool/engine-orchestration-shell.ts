import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ServerSideToolEngineOptions } from './types.js';
import { runServerSideToolEngine } from './server-side-tools-impl.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import {
  createServerToolTimeoutError,
  withTimeout
} from './timeout-error-block.js';
import {
  resolveServerToolTimeoutMs
} from './orchestration-policy-block.js';
import {
  runPrimaryServerToolEngineSelection
} from './engine-selection-block.js';
import {
  runServertoolEnginePostflight
} from './engine-postflight-shell.js';
import {
  createServertoolObservation,
  recordServertoolEngineMatchHit,
  recordServertoolEngineMatchSkipped
} from './engine-observation-shell.js';
import { runEnginePreflight } from './engine-preflight-shell.js';
import {
  readProviderProtocolFromAnyBoundMetadataCenter,
  readRequestTruthSessionIdFromAnyBoundMetadataCenter,
  readRuntimeControlFromAnyBoundMetadataCenter
} from './metadata-center-carrier.js';
import {
  planServertoolEngineRuntimeActionWithNative,
  planServertoolEngineSkipWithNative,
  planStoplessExecutionWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';

export interface ServerToolOrchestrationOptions {
  chat: JsonObject;
  adapterContext: AdapterContext;
  requestId: string;
  entryEndpoint: string;
  providerProtocol: string;
  stageRecorder?: StageRecorder;
}

export interface ServerToolOrchestrationResult {
  chat: JsonObject;
  executed: boolean;
  flowId?: string;
}

type ServerToolEngineResult = Awaited<ReturnType<typeof runServerSideToolEngine>>;
type ServerToolEngineRunner = (
  overrides: Partial<ServerSideToolEngineOptions>
) => Promise<ServerToolEngineResult>;

function createServerToolEngineRunner(args: {
  engineOptions: ServerSideToolEngineOptions;
  serverToolTimeoutMs: number;
  requestId: string;
}): ServerToolEngineRunner {
  return (overrides) =>
    withTimeout(
      runServerSideToolEngine({
        ...args.engineOptions,
        ...overrides
      }),
      args.serverToolTimeoutMs,
      () =>
        createServerToolTimeoutError({
          requestId: args.requestId,
          phase: 'engine',
          timeoutMs: args.serverToolTimeoutMs
        })
    );
}

function planStoplessEngineRuntime(args: {
  flowId: string;
  engineResult: ServerToolEngineResult;
  requestTruthSessionId: string | undefined;
  runtimeControl: unknown;
}) {
  const stoplessExecutionPlan = planStoplessExecutionWithNative({
    flowId: args.flowId,
    execution:
      args.engineResult.execution && typeof args.engineResult.execution === 'object'
        ? (args.engineResult.execution as unknown as Record<string, unknown>)
        : {},
    requestTruthSessionId: args.requestTruthSessionId,
    runtimeControl:
      args.runtimeControl && typeof args.runtimeControl === 'object'
        ? (args.runtimeControl as Record<string, unknown>)
        : null
  });
  const stoplessExecution = stoplessExecutionPlan.execution;
  const stoplessPlan = stoplessExecutionPlan.orchestrationPlan;
  return {
    stoplessExecution,
    runtimeAction: planServertoolEngineRuntimeActionWithNative({
      isStopMessageFlow: stoplessPlan.isStopMessageFlow === true,
      hasServertoolCliProjectionContext: stoplessExecution.flowId === 'servertool_cli_projection',
      stoplessAction: stoplessPlan.action
    })
  };
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
  } = createServertoolObservation({
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

  const runEngine = createServerToolEngineRunner({
    engineOptions,
    serverToolTimeoutMs,
    requestId: options.requestId
  });
  const engineResult = await runPrimaryServerToolEngineSelection({
    runEngine
  });
  const engineSkipPlan = planServertoolEngineSkipWithNative({
    engineMode: engineResult.mode,
    hasExecution: Boolean(engineResult.execution)
  });
  if (
    engineSkipPlan.action === 'return_skipped_passthrough' ||
    engineSkipPlan.action === 'return_skipped_no_execution'
  ) {
    const skipReason = engineSkipPlan.skipReason ?? 'no_execution';
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
      providerProtocol,
      engineMode: engineResult.mode,
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
  const requestTruthSessionId = readRequestTruthSessionIdFromAnyBoundMetadataCenter(
    options.adapterContext as Record<string, unknown>
  );
  const { stoplessExecution, runtimeAction } = planStoplessEngineRuntime({
    flowId,
    engineResult,
    requestTruthSessionId,
    runtimeControl
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

export const runServerToolOrchestration = runServerToolOrchestrationShell;
