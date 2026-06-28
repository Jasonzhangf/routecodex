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
import { runEnginePreflight } from './engine-preflight-shell.js';
import { readNativeFunction } from '../native/router-hotpath/native-shared-conversion-semantics-core.js';
import {
  readProviderProtocolFromAnyBoundMetadataCenter,
  readRequestTruthSessionIdFromAnyBoundMetadataCenter,
  readRuntimeControlFromAnyBoundMetadataCenter
} from './metadata-center-carrier.js';

function planServertoolEngineRuntimeActionWithNativeLocal(input: {
  hasPendingInjection: boolean;
  isStopMessageFlow: boolean;
  executionContext?: Record<string, unknown>;
  stoplessAction: string;
}): { action: string } {
  const fn = readNativeFunction('planServertoolEngineRuntimeActionJson');
  if (!fn) {
    throw new Error('planServertoolEngineRuntimeActionJson native unavailable');
  }
  const executionContext = input.executionContext ?? {};
  const hasServertoolCliProjectionContext = Boolean(
    executionContext.servertoolCliProjection && typeof executionContext.servertoolCliProjection === 'object'
  );
  const raw = fn(JSON.stringify({
    hasPendingInjection: input.hasPendingInjection,
    isStopMessageFlow: input.isStopMessageFlow,
    executionContext: executionContext,
    hasServertoolCliProjectionContext,
    stoplessAction: input.stoplessAction
  }));
  if (typeof raw !== 'string') {
    throw new Error(`planServertoolEngineRuntimeActionJson native returned non-string: ${typeof raw}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`planServertoolEngineRuntimeActionJson native parse failed: ${message}`);
  }
}

function planServertoolEngineSkipWithNative(input: {
  engineMode: string;
  hasExecution: boolean;
}): { action: string; skipReason?: string } {
  const fn = readNativeFunction('planServertoolEngineSkipJson');
  if (!fn) {
    throw new Error('planServertoolEngineSkipJson native unavailable');
  }
  const raw = fn(JSON.stringify({
    engineMode: input.engineMode,
    hasExecution: input.hasExecution
  }));
  if (typeof raw !== 'string') {
    throw new Error(`planServertoolEngineSkipJson native returned non-string: ${typeof raw}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`planServertoolEngineSkipJson native parse failed: ${message}`);
  }
}

function planStoplessExecutionWithNativeLocal(input: {
  flowId?: string;
  execution: Record<string, unknown>;
  requestTruthSessionId?: string;
  runtimeControl?: Record<string, unknown> | null;
}): {
  execution: Record<string, unknown>;
  orchestrationPlan: { action: string; isStopMessageFlow: boolean; reason: string };
} {
  const fn = readNativeFunction('planStoplessExecutionJson');
  if (!fn) {
    throw new Error('planStoplessExecutionJson native unavailable');
  }
  const raw = fn(JSON.stringify({
    flowId: input.flowId ?? null,
    execution: input.execution,
    requestTruthSessionId: input.requestTruthSessionId ?? null,
    runtimeControl: input.runtimeControl ?? null
  }));
  if (typeof raw !== 'string') {
    throw new Error(`planStoplessExecutionJson native returned non-string: ${typeof raw}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid stopless execution plan object');
    }
    const execution = (parsed as Record<string, unknown>).execution;
    const orchestrationPlan = (parsed as Record<string, unknown>).orchestrationPlan;
    if (!execution || typeof execution !== 'object' || Array.isArray(execution)) {
      throw new Error('invalid stopless execution payload');
    }
    if (!orchestrationPlan || typeof orchestrationPlan !== 'object' || Array.isArray(orchestrationPlan)) {
      throw new Error('invalid stopless orchestration plan');
    }
    return {
      execution: execution as Record<string, unknown>,
      orchestrationPlan: orchestrationPlan as { action: string; isStopMessageFlow: boolean; reason: string }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`planStoplessExecutionJson native parse failed: ${message}`);
  }
}

export interface ServerToolOrchestrationOptions {
  chat: JsonObject;
  adapterContext: AdapterContext;
  requestId: string;
  entryEndpoint: string;
  providerProtocol: string;
  stageRecorder?: StageRecorder;
  reenterPipeline?: (options: {
    entryEndpoint: string;
    requestId: string;
    body?: JsonObject;
    metadata?: JsonObject;
  }) => Promise<{
    body?: JsonObject;
    sseStream?: unknown;
    format?: string;
  }>;
  clientInjectDispatch?: (options: {
    entryEndpoint: string;
    requestId: string;
    body?: JsonObject;
    metadata?: JsonObject;
  }) => Promise<{
    ok: boolean;
    reason?: string;
  }>;
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
  const providerProtocol =
    readProviderProtocolFromAnyBoundMetadataCenter(options.adapterContext as Record<string, unknown>);
  if (!providerProtocol) {
    throw new Error('Servertool engine orchestration requires metadata center runtime_control.providerProtocol');
  }
  const {
    logStopEntry,
    logProgress,
    logAutoHookTrace,
    logStopCompare,
    logNonBlocking
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
  const effectiveServerToolTimeoutMs = serverToolTimeoutMs;
  const engineOptions: ServerSideToolEngineOptions = {
    chatResponse: options.chat,
    adapterContext: options.adapterContext,
    entryEndpoint: options.entryEndpoint,
    requestId: options.requestId,
    providerProtocol,
    ...(typeof options.clientInjectDispatch === 'function'
      ? { clientInjectDispatch: options.clientInjectDispatch }
      : {}),
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
  const stoplessExecutionPlan = planStoplessExecutionWithNativeLocal({
        flowId,
        execution: engineResult.execution && typeof engineResult.execution === 'object'
          ? engineResult.execution as unknown as Record<string, unknown>
          : {},
        requestTruthSessionId,
        runtimeControl: runtimeControl && typeof runtimeControl === 'object'
          ? runtimeControl as Record<string, unknown>
          : null
      });
  const stoplessExecution = stoplessExecutionPlan.execution;
  const stoplessPlan = stoplessExecutionPlan.orchestrationPlan;
  const executionContext =
    stoplessExecution.context && typeof stoplessExecution.context === 'object' && !Array.isArray(stoplessExecution.context)
      ? stoplessExecution.context as Record<string, unknown>
      : undefined;
  const runtimeAction = planServertoolEngineRuntimeActionWithNativeLocal({
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
    engineResult: {
      ...engineResult,
      execution: stoplessExecution as unknown as typeof engineResult.execution
    },
    runtimeAction,
    flowId,
    totalSteps,
    stageRecorder: options.stageRecorder,
    logProgress,
    logNonBlocking
  });
}

export const runServerToolOrchestration = runServerToolOrchestrationShell;
