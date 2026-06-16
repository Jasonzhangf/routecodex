import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { readRuntimeMetadata } from '../conversion/runtime-metadata.js';
import type { ProviderInvoker, ServerSideToolEngineOptions } from './types.js';
import { runServerSideToolEngine } from './server-side-tools.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import { attachStopGatewayContext, inspectStopGatewaySignal } from './stop-gateway-context.js';
import { createServertoolProgressLogger } from './progress-log-block.js';
import { recordServertoolMatchHit, recordServertoolMatchSkipped } from './match-log-block.js';
import {
  createServerToolTimeoutError,
  withTimeout
} from './timeout-error-block.js';
import {
  containsSyntheticRouteCodexControlText,
  resolveServerToolFollowupTimeoutMs,
  resolveServerToolTimeoutMs
} from './orchestration-policy-block.js';
import {
  runPrimaryServerToolEngineSelection
} from './engine-selection-block.js';
import { persistPendingServerToolInjection } from './pending-injection-block.js';
import { runFollowupMainline } from './backend-route-mainline-block.js';
import { buildServertoolCliProjectionForAutoFlow } from './cli-projection.js';
import {
  planStoplessOrchestrationActionWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';

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
    body?: JsonObject;
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

function summarizeServertoolExecutionForSnapshot(engineResult: ServerToolEngineResult): Record<string, unknown> {
  const finalChat = engineResult.finalChatResponse as Record<string, unknown>;
  const toolOutputs = Array.isArray(finalChat.tool_outputs) ? finalChat.tool_outputs : [];
  const firstToolOutput =
    toolOutputs.length > 0 && toolOutputs[0] && typeof toolOutputs[0] === 'object' && !Array.isArray(toolOutputs[0])
      ? (toolOutputs[0] as Record<string, unknown>)
      : null;
  const summary: Record<string, unknown> = {
    mode: engineResult.mode,
    flowId: engineResult.execution?.flowId,
    hasFollowup: Boolean(engineResult.execution?.followup),
    pendingInjection: Boolean(engineResult.pendingInjection),
    toolOutputCount: toolOutputs.length
  };
  if (firstToolOutput) {
    if (typeof firstToolOutput.tool_name === 'string') {
      summary.toolName = firstToolOutput.tool_name;
    }
    if (typeof firstToolOutput.tool_call_id === 'string') {
      summary.toolCallId = firstToolOutput.tool_call_id;
    }
    if (typeof firstToolOutput.content === 'string') {
      summary.toolOutputContent = firstToolOutput.content;
    }
  }
  if (engineResult.execution?.context && typeof engineResult.execution.context === 'object') {
    summary.context = engineResult.execution.context;
  }
  const followup = engineResult.execution?.followup;
  if (followup && typeof followup === 'object' && !Array.isArray(followup)) {
    const followupEntryEndpoint =
      'entryEndpoint' in followup && typeof followup.entryEndpoint === 'string'
        ? followup.entryEndpoint
        : undefined;
    const followupSummary: Record<string, unknown> = {
      requestIdSuffix: typeof followup.requestIdSuffix === 'string' ? followup.requestIdSuffix : undefined,
      entryEndpoint: followupEntryEndpoint
    };
    if ('payload' in followup) {
      followupSummary.mode = 'payload';
      const payload = followup.payload;
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const payloadRecord = payload as Record<string, unknown>;
        if (Array.isArray(payloadRecord.messages)) {
          followupSummary.messageCount = payloadRecord.messages.length;
        }
        if (Array.isArray(payloadRecord.input)) {
          followupSummary.inputCount = payloadRecord.input.length;
        }
      }
    } else if ('injection' in followup) {
      followupSummary.mode = 'injection';
      const ops = Array.isArray(followup.injection?.ops) ? followup.injection.ops : [];
      followupSummary.injectionOps = ops
        .map((item) => (item && typeof item === 'object' && 'op' in item ? (item as { op?: unknown }).op : undefined))
        .filter((value) => typeof value === 'string');
    } else {
      followupSummary.mode = 'metadata_only';
    }
    summary.followup = followupSummary;
  }
  return summary;
}

function extractStoplessReasoningText(finalChatResponse: JsonObject): string {
  const choice = Array.isArray((finalChatResponse as any).choices) ? (finalChatResponse as any).choices[0] : null;
  const message = choice && typeof choice === 'object' ? choice.message : null;
  const candidates: unknown[] = [
    message?.reasoning_text,
    message?.reasoning_content,
    message?.content,
    (finalChatResponse as any).output_text
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return 'RouteCodex projected stopless continuation to client CLI.';
}

function extractStoplessLoopState(execution: ServerToolEngineResult['execution']): {
  repeatCount: number;
  maxRepeats: number;
} {
  const state = execution?.context && typeof execution.context === 'object' && !Array.isArray(execution.context)
    ? (execution.context as Record<string, unknown>).serverToolLoopState
    : null;
  const row = state && typeof state === 'object' && !Array.isArray(state)
    ? state as Record<string, unknown>
    : {};
  const repeatCount = typeof row.repeatCount === 'number' ? row.repeatCount : 1;
  const maxRepeats = typeof row.maxRepeats === 'number' ? row.maxRepeats : Math.max(repeatCount, 1);
  return { repeatCount, maxRepeats };
}

function readStoplessSessionId(adapterContext: unknown): string | undefined {
  if (!adapterContext || typeof adapterContext !== 'object') {
    return undefined;
  }
  const record = adapterContext as Record<string, unknown>;
  const direct = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
  if (direct) {
    return direct;
  }
  const runtime = record.__rt && typeof record.__rt === 'object' && !Array.isArray(record.__rt)
    ? record.__rt as Record<string, unknown>
    : null;
  const rt = runtime && typeof runtime.sessionId === 'string' ? runtime.sessionId.trim() : '';
  return rt || undefined;
}

function readStoplessRouteName(adapterContext: unknown): string | undefined {
  if (!adapterContext || typeof adapterContext !== 'object') {
    return undefined;
  }
  const record = adapterContext as Record<string, unknown>;
  const runtimeMetadata = readRuntimeMetadata(record) as Record<string, unknown> | undefined;
  const directRuntime =
    record.__rt && typeof record.__rt === 'object' && !Array.isArray(record.__rt)
      ? record.__rt as Record<string, unknown>
      : null;
  const candidates = [
    runtimeMetadata?.routeName,
    directRuntime?.routeName,
    record.routeName
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function isDirectStoplessDisabled(adapterContext: unknown): boolean {
  const routeName = readStoplessRouteName(adapterContext)?.toLowerCase();
  if (!routeName) {
    return false;
  }
  return routeName.startsWith('router-direct') || routeName.startsWith('provider-direct');
}

function recordServertoolExecutionSnapshot(args: {
  stageRecorder?: StageRecorder;
  requestId: string;
  engineResult: ServerToolEngineResult;
}): void {
  if (!args.stageRecorder) {
    return;
  }
  try {
    args.stageRecorder.record('servertool.execution', summarizeServertoolExecutionForSnapshot(args.engineResult));
  } catch (error) {
    logServerToolNonBlocking('record_servertool_execution_snapshot', error, {
      requestId: args.requestId,
      flowId: args.engineResult.execution?.flowId
    });
  }
}

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
    containsSyntheticRouteCodexControlText(options.chat)
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
    if (isDirectStoplessDisabled(options.adapterContext)) {
      logStopEntry('trigger', 'skipped_direct_passthrough', {
        reason: stopSignal.reason,
        source: stopSignal.source,
        eligible: stopSignal.eligible
      });
      logStopCompare('trigger');
      return {
        chat: options.chat,
        executed: false
      };
    }
    logStopEntry('entry', 'observed', {
      reason: stopSignal.reason,
      source: stopSignal.source,
      eligible: stopSignal.eligible,
      ...(typeof stopSignal.choiceIndex === 'number' ? { choiceIndex: stopSignal.choiceIndex } : {}),
      ...(typeof stopSignal.hasToolCalls === 'boolean' ? { hasToolCalls: stopSignal.hasToolCalls } : {})
    });
  }

  const serverToolTimeoutMs = resolveServerToolTimeoutMs();
  const effectiveServerToolTimeoutMs = serverToolTimeoutMs;
  const followupTimeoutMs = resolveServerToolFollowupTimeoutMs();
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
  const engineResult = await runPrimaryServerToolEngineSelection({
    runEngine
  });
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
  const stoplessPlan = planStoplessOrchestrationActionWithNative({
    flowId,
    execution: engineResult.execution,
    sessionId: readStoplessSessionId(options.adapterContext)
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
  const totalSteps = 5;
  logProgress(1, totalSteps, 'matched', { flowId });
  recordServertoolExecutionSnapshot({
    stageRecorder: options.stageRecorder,
    requestId: options.requestId,
    engineResult
  });

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
  if (
    engineResult.execution.context &&
    typeof engineResult.execution.context === 'object' &&
    !Array.isArray(engineResult.execution.context) &&
    (engineResult.execution.context as Record<string, unknown>).servertoolCliProjection
  ) {
    logProgress(5, totalSteps, 'completed (servertool cli projection; no reenter)', { flowId });
    return {
      chat: engineResult.finalChatResponse,
      executed: true,
      flowId: engineResult.execution.flowId
    };
  }
  if (stoplessPlan.action === 'terminal_final') {
    logProgress(5, totalSteps, 'completed (stop_message_auto final terminal result)', {
      flowId,
      reason: stoplessPlan.reason
    });
    return {
      chat: engineResult.finalChatResponse,
      executed: true,
      flowId: engineResult.execution.flowId
    };
  }
  if (stoplessPlan.action === 'cli_projection' && stoplessPlan.isStopMessageFlow) {
    const loopState = extractStoplessLoopState(engineResult.execution);
    const sessionId = readStoplessSessionId(options.adapterContext);
    const projection = buildServertoolCliProjectionForAutoFlow({
      options: { requestId: options.requestId, adapterContext: options.adapterContext },
      flowId,
      reasoningText: extractStoplessReasoningText(engineResult.finalChatResponse),
      input: {
        flowId,
        repeatCount: loopState.repeatCount,
        maxRepeats: loopState.maxRepeats
      },
      ...(sessionId ? { sessionId, requestId: options.requestId } : {})
    });
    logProgress(5, totalSteps, 'completed (stop_message_auto cli projection)', {
      flowId,
      reason: stoplessPlan.reason
    });
    return {
      chat: projection.chatResponse,
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
    stopMessageLoopWarnThreshold: STOP_MESSAGE_LOOP_WARN_THRESHOLD,
    stopMessageLoopFailThreshold: STOP_MESSAGE_LOOP_FAIL_THRESHOLD,
    stageRecorder: options.stageRecorder,
    reenterPipeline: options.reenterPipeline,
    clientInjectDispatch: options.clientInjectDispatch,
    onLogProgress: (step, total, message, extra) => logProgress(step, total, message, extra),
    logNonBlocking: logServerToolNonBlocking
  });
}
