import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ServerSideToolEngineOptions } from './types.js';
import { runServerSideToolEngine } from './server-side-tools.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import { createServertoolProgressLogger } from './progress-log-block.js';
import { recordServertoolMatchHit, recordServertoolMatchSkipped } from './match-log-block.js';
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
  runServertoolEnginePostflight,
  resolveStoplessCliProjectionContext
} from './engine-postflight-shell.js';
import {
  planServertoolEngineRuntimeActionWithNative,
  planServertoolEngineSkipWithNative,
  planStoplessOrchestrationActionWithNative as planStoplessOrchestrationActionShell,
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import { runEnginePreflight } from './engine-preflight-shell.js';

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
}

export interface ServerToolOrchestrationResult {
  chat: JsonObject;
  executed: boolean;
  flowId?: string;
}

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
  const totalSteps = 5;
  const stoplessPlan = planStoplessOrchestrationActionShell({
    flowId,
    execution: engineResult.execution,
    adapterContext: options.adapterContext as Record<string, unknown>
  });
  const runtimeAction = planServertoolEngineRuntimeActionWithNative({
    hasPendingInjection: Boolean(engineResult.pendingInjection),
    isStopMessageFlow: stoplessPlan.isStopMessageFlow,
    executionContext: engineResult.execution.context,
    stoplessAction: stoplessPlan.action
  });
  if (stopSignal.observed) {
    logStopEntry('trigger', stoplessPlan.isStopMessageFlow ? 'activated' : 'non_stop_flow', {
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
    stoplessPlan,
    stageRecorder: options.stageRecorder,
    resolveStoplessCliProjectionContext: () =>
      resolveStoplessCliProjectionContext(
        engineResult.execution,
        options.adapterContext,
        engineResult.finalChatResponse
      ),
    logProgress,
    logNonBlocking: logServerToolNonBlocking
  });
}
