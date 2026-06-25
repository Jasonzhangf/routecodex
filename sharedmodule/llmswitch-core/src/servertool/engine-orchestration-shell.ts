import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ServerSideToolEngineOptions } from './types.js';
import { runServerSideToolEngine } from './server-side-tools.js';
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
import {
  planServertoolEngineRuntimeActionWithNative,
  planServertoolEngineSkipWithNative,
  planStoplessOrchestrationActionWithNative,
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import { runEnginePreflight } from './engine-preflight-shell.js';
import {
  readRuntimeControlFromBoundMetadataCenter,
  readRequestTruthSessionIdFromAnyBoundMetadataCenter
} from './stopless-metadata-carrier.js';

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
  effectiveServerToolTimeoutMs: number;
  serverToolTimeoutMs: number;
  requestId: string;
}): ServerToolEngineRunner {
  return (overrides) =>
    withTimeout(
      runServerSideToolEngine({
        ...args.engineOptions,
        ...overrides
      }),
      args.effectiveServerToolTimeoutMs,
      () =>
        createServerToolTimeoutError({
          requestId: args.requestId,
          phase: 'engine',
          timeoutMs: args.effectiveServerToolTimeoutMs || args.serverToolTimeoutMs
        })
    );
}

export async function runServerToolOrchestrationShell(
  options: ServerToolOrchestrationOptions
): Promise<ServerToolOrchestrationResult> {
  const {
    logStopEntry,
    logProgress,
    logAutoHookTrace,
    logStopCompare,
    logNonBlocking
  } = createServertoolObservation({
    requestId: options.requestId,
    entryEndpoint: options.entryEndpoint,
    providerProtocol: options.providerProtocol,
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
  const effectiveServerToolTimeoutMs = serverToolTimeoutMs;
  const engineOptions: ServerSideToolEngineOptions = {
    chatResponse: options.chat,
    adapterContext: options.adapterContext,
    entryEndpoint: options.entryEndpoint,
    requestId: options.requestId,
    providerProtocol: options.providerProtocol,
    onAutoHookTrace: logAutoHookTrace
  };

  const runEngine = createServerToolEngineRunner({
    engineOptions,
    effectiveServerToolTimeoutMs,
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
      providerProtocol: options.providerProtocol,
      engineMode: engineResult.mode,
      stageRecorder: options.stageRecorder
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
  const executionContext =
    engineResult.execution?.context && typeof engineResult.execution.context === 'object' && !Array.isArray(engineResult.execution.context)
      ? engineResult.execution.context as Record<string, unknown>
      : undefined;
  const runtimeControl = readRuntimeControlFromBoundMetadataCenter(options.adapterContext as Record<string, unknown>);
  const stoplessControl =
    runtimeControl?.stopless && typeof runtimeControl.stopless === 'object' && !Array.isArray(runtimeControl.stopless)
      ? runtimeControl.stopless
      : undefined;
  const requestTruthSessionId = readRequestTruthSessionIdFromAnyBoundMetadataCenter(
    options.adapterContext as Record<string, unknown>
  );
  const stoplessExecution = {
    ...(engineResult.execution && typeof engineResult.execution === 'object' ? engineResult.execution : {}),
    ...(flowId ? { flowId } : {}),
    context: {
      ...(executionContext ?? {}),
      ...(requestTruthSessionId ? { sessionId: requestTruthSessionId } : {}),
      ...(requestTruthSessionId ? { requestTruth: { sessionId: requestTruthSessionId } } : {}),
      ...(stoplessControl
        ? {
            serverToolLoopState: {
              flowId,
              ...(typeof stoplessControl.repeatCount === 'number' ? { repeatCount: stoplessControl.repeatCount } : {}),
              ...(typeof stoplessControl.maxRepeats === 'number' ? { maxRepeats: stoplessControl.maxRepeats } : {}),
              ...(typeof stoplessControl.triggerHint === 'string' ? { triggerHint: stoplessControl.triggerHint } : {}),
              ...(stoplessControl.schemaFeedback && typeof stoplessControl.schemaFeedback === 'object'
                ? { schemaFeedback: stoplessControl.schemaFeedback }
                : {}),
            }
          }
        : {})
    }
  };
  const stoplessPlan = flowId === 'stop_message_flow'
    ? planStoplessOrchestrationActionWithNative({
        flowId,
        execution: stoplessExecution
      })
    : {
        action: 'cli_projection',
        isStopMessageFlow: false
      };
  const runtimeAction = planServertoolEngineRuntimeActionWithNative({
    hasPendingInjection: Boolean(engineResult.pendingInjection),
    isStopMessageFlow: stoplessPlan.isStopMessageFlow === true,
    executionContext,
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
    engineResult,
    runtimeAction,
    flowId,
    totalSteps,
    stageRecorder: options.stageRecorder,
    logProgress,
    logNonBlocking
  });
}

export const runServerToolOrchestration = runServerToolOrchestrationShell;
