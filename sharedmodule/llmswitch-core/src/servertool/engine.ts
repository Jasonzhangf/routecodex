import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ProviderInvoker, ServerSideToolEngineOptions } from './types.js';
import { runServerSideToolEngine } from './server-side-tools.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import { attachStopGatewayContext, inspectStopGatewaySignal } from './stop-gateway-context.js';
import {
  detectEmptyAssistantPayloadContractSignalWithNative,
} from '../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';
import { createServertoolProgressLogger } from './progress-log-block.js';
import { recordServertoolMatchHit, recordServertoolMatchSkipped } from './match-log-block.js';
import {
  createServerToolTimeoutError,
  withTimeout
} from './timeout-error-block.js';
import {
  containsSyntheticRouteCodexControlText,
  resolveServerToolFollowupTimeoutMs,
  resolveServerToolTimeoutMs,
  shouldDisableServerToolTimeoutForClockHold
} from './orchestration-policy-block.js';
import {
  runPrimaryServerToolEngineSelection,
  runReasoningStopGuardPrepass
} from './engine-selection-block.js';
import { persistPendingServerToolInjection } from './pending-injection-block.js';
import { runFollowupMainline } from './followup-mainline-block.js';

// native-router-hotpath contract:
// servertool followup metadata/injection shape is consumed by Rust hub pipeline
// (router_hotpath_napi). Keep this TS orchestrator as a thin compatibility shell.

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
    body: JsonObject;
    metadata?: JsonObject;
  }) => Promise<{
    body?: JsonObject;
    __sse_responses?: unknown;
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
  providerInvoker?: ProviderInvoker;
}

export interface ServerToolOrchestrationResult {
  chat: JsonObject;
  executed: boolean;
  flowId?: string;
}

const STOP_MESSAGE_STAGE_TIMEOUT_MS = 900_000;
const STOP_MESSAGE_LOOP_WARN_THRESHOLD = 5;
const STOP_MESSAGE_LOOP_FAIL_THRESHOLD = 10;

function logServerToolNonBlocking(stage: string, error: unknown, details?: Record<string, unknown>): void {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown');
  const detailEntries =
    details && typeof details === 'object'
      ? Object.entries(details)
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(' ')
      : '';
  // eslint-disable-next-line no-console
  console.warn(`[servertool][non-blocking] stage=${stage} error=${message}${detailEntries ? ` ${detailEntries}` : ''}`);
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

export async function runServerToolOrchestration(
  options: ServerToolOrchestrationOptions
): Promise<ServerToolOrchestrationResult> {
  const BLUE = '\x1b[38;5;39m';
  const YELLOW = '\x1b[38;5;214m';
  const GOLD = '\x1b[38;5;220m';
  const RESET = '\x1b[0m';

  if (
    detectEmptyAssistantPayloadContractSignalWithNative(options.chat)
    || containsSyntheticRouteCodexControlText(options.chat)
  ) {
    return {
      chat: options.chat,
      executed: false
    };
  }

  const {
    logStopEntry,
    logProgress,
    logAutoHookTrace,
    logStopCompare
  } = createServertoolProgressLogger({
    requestId: options.requestId,
    entryEndpoint: options.entryEndpoint,
    providerProtocol: options.providerProtocol,
    adapterContext: options.adapterContext,
    stageRecorder: options.stageRecorder,
    blue: BLUE,
    yellow: YELLOW,
    gold: GOLD,
    reset: RESET,
    logNonBlocking: logServerToolNonBlocking
  });

  const stopSignal = inspectStopGatewaySignal(options.chat);
  attachStopGatewayContext(options.adapterContext, stopSignal);
  if (stopSignal.observed) {
    logStopEntry('entry', 'observed', {
      reason: stopSignal.reason,
      source: stopSignal.source,
      eligible: stopSignal.eligible,
      ...(typeof stopSignal.choiceIndex === 'number' ? { choiceIndex: stopSignal.choiceIndex } : {}),
      ...(typeof stopSignal.hasToolCalls === 'boolean' ? { hasToolCalls: stopSignal.hasToolCalls } : {})
    });
  }

  const serverToolTimeoutMs = resolveServerToolTimeoutMs();
  const shouldDisableTimeout = await shouldDisableServerToolTimeoutForClockHold({
    chat: options.chat,
    adapterContext: options.adapterContext,
    serverToolTimeoutMs,
    requestId: options.requestId
  });
  const effectiveServerToolTimeoutMs = shouldDisableTimeout ? 0 : serverToolTimeoutMs;
  const followupTimeoutMs = resolveServerToolFollowupTimeoutMs(serverToolTimeoutMs);
  const engineOptions: ServerSideToolEngineOptions = {
    chatResponse: options.chat,
    adapterContext: options.adapterContext,
    entryEndpoint: options.entryEndpoint,
    requestId: options.requestId,
    providerProtocol: options.providerProtocol,
    providerInvoker: options.providerInvoker,
    reenterPipeline: options.reenterPipeline,
    clientInjectDispatch: options.clientInjectDispatch,
    onAutoHookTrace: logAutoHookTrace
  };

  const runEngine = createServerToolEngineRunner({
    engineOptions,
    effectiveServerToolTimeoutMs,
    serverToolTimeoutMs,
    requestId: options.requestId
  });
  const guardPrepassResult = await runReasoningStopGuardPrepass({
    chat: options.chat,
    adapterContext: options.adapterContext,
    stopSignal,
    runEngine,
    logProgress,
    logStopEntry
  });
  if (guardPrepassResult) {
    return guardPrepassResult;
  }

  const engineResult = await runPrimaryServerToolEngineSelection({ runEngine });
  if (engineResult.mode === 'passthrough' || !engineResult.execution) {
    const skipReason = engineResult.mode === 'passthrough' ? 'passthrough' : 'no_execution';
    if (stopSignal.observed) {
      logStopEntry('trigger', `skipped_${skipReason}`, {
        reason: stopSignal.reason,
        source: stopSignal.source,
        eligible: stopSignal.eligible
      });
      logStopCompare('trigger');
    }
    recordServertoolMatchSkipped({
      requestId: options.requestId,
      entryEndpoint: options.entryEndpoint,
      providerProtocol: options.providerProtocol,
      engineMode: engineResult.mode,
      stageRecorder: options.stageRecorder,
      logNonBlocking: logServerToolNonBlocking
    });
    return {
      chat: engineResult.finalChatResponse,
      executed: false
    };
  }

  const flowId = recordServertoolMatchHit({
    requestId: options.requestId,
    execution: engineResult.execution,
    stageRecorder: options.stageRecorder,
    logNonBlocking: logServerToolNonBlocking
  });
  if (stopSignal.observed) {
    logStopEntry('trigger', flowId === 'stop_message_flow' ? 'activated' : 'non_stop_flow', {
      flowId,
      reason: stopSignal.reason,
      source: stopSignal.source,
      eligible: stopSignal.eligible
    });
    logStopCompare('trigger', flowId);
  }
  const totalSteps = 5;
  logProgress(1, totalSteps, 'matched', { flowId });

  // Mixed tools: persist servertool outputs for next request, but return remaining tool_calls to client.
  if (engineResult.pendingInjection) {
    await persistPendingServerToolInjection({
      pendingInjection: engineResult.pendingInjection,
      requestId: options.requestId,
      flowId
    });
    logProgress(5, totalSteps, 'completed (mixed tools; no reenter)', { flowId });
    return {
      chat: engineResult.finalChatResponse,
      executed: true,
      flowId: engineResult.execution.flowId
    };
  }
  return runFollowupMainline({
    adapterContext: options.adapterContext,
    requestId: options.requestId,
    entryEndpoint: options.entryEndpoint,
    followupTimeoutMs,
    execution: engineResult.execution,
    finalChatResponse: engineResult.finalChatResponse,
    flowId,
    totalSteps,
    stopMessageStageTimeoutMs: STOP_MESSAGE_STAGE_TIMEOUT_MS,
    stopMessageLoopWarnThreshold: STOP_MESSAGE_LOOP_WARN_THRESHOLD,
    stopMessageLoopFailThreshold: STOP_MESSAGE_LOOP_FAIL_THRESHOLD,
    stageRecorder: options.stageRecorder,
    reenterPipeline: options.reenterPipeline,
    clientInjectDispatch: options.clientInjectDispatch,
    onLogProgress: (step, total, message, extra) => logProgress(step, total, message, extra),
    logNonBlocking: logServerToolNonBlocking
  });
}
