import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ServerSideToolEngineOptions } from './types.js';
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
  resolveServerToolTimeoutMs
} from './orchestration-policy-block.js';
import {
  runPrimaryServerToolEngineSelection
} from './engine-selection-block.js';
import { persistPendingServerToolInjection } from './pending-injection-block.js';
import { buildServertoolCliProjectionForAutoFlow as buildServertoolCliProjectionForAutoFlowShell } from './cli-projection.js';
import {
  extractCurrentAssistantStopTextWithNative,
  planServertoolEnginePreflightWithNative,
  planServertoolEngineRuntimeActionWithNative,
  planServertoolEngineSkipWithNative,
  planStoplessCliProjectionContextWithNative,
  planStoplessOrchestrationActionWithNative as planStoplessOrchestrationActionShell,
  resolveRuntimeStopMessageStateFromAdapterContextWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import { readRuntimeControlFromBoundMetadataCenter } from './stopless-metadata-carrier.js';
import { readRuntimeMetadata } from '../conversion/runtime-metadata.js';
import { stoplessIsDisabledOnDirectRoute } from './direct-stopless-route-guard.js';

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

function resolveStoplessCliProjectionContext(
  execution: ServerToolEngineResult['execution'],
  adapterContext?: unknown,
  chatResponse?: JsonObject
): {
  reasoningText: string;
  repeatCount: number;
  maxRepeats: number;
  triggerHint?: string;
  schemaFeedback?: JsonObject;
} {
  const context = execution?.context && typeof execution.context === 'object' && !Array.isArray(execution.context)
    ? execution.context as Record<string, unknown>
    : {};
  const adapterRecord =
    adapterContext && typeof adapterContext === 'object' && !Array.isArray(adapterContext)
      ? adapterContext as Record<string, unknown>
      : undefined;
  const metadata =
    adapterRecord?.metadata &&
    typeof adapterRecord.metadata === 'object' &&
    !Array.isArray(adapterRecord.metadata)
      ? adapterRecord.metadata as Record<string, unknown>
      : undefined;
  const runtimeMetadata = adapterRecord ? readRuntimeMetadata(adapterRecord) : undefined;
  const runtimeControl = readRuntimeControlFromBoundMetadataCenter(metadata);
  const stoplessControl =
    runtimeControl?.stopless && typeof runtimeControl.stopless === 'object' && !Array.isArray(runtimeControl.stopless)
      ? runtimeControl.stopless as Record<string, unknown>
      : {};
  const runtimeSnapshot = resolveRuntimeStopMessageStateFromAdapterContextWithNative({
    adapterContext: adapterRecord ?? null,
    ...(runtimeMetadata ? { runtimeMetadata } : {})
  });
  return planStoplessCliProjectionContextWithNative({
    executionContext: context,
    stoplessControl,
    runtimeSnapshot: runtimeSnapshot
      ? {
          used: runtimeSnapshot.used,
          maxRepeats: runtimeSnapshot.maxRepeats
        }
      : undefined,
    chatStopText: extractCurrentAssistantStopTextWithNative(chatResponse ?? null),
    adapterStopText: extractCurrentAssistantStopTextWithNative(adapterRecord ?? null)
  });
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
  const preflightAction = planServertoolEnginePreflightWithNative({
    hasSyntheticControlText: containsSyntheticRouteCodexControlText(options.chat),
    stopSignalObserved: stopSignal.observed,
    stoplessDisabledOnDirectRoute: stoplessIsDisabledOnDirectRoute(options.adapterContext)
  });
  if (preflightAction.action === 'return_original_chat') {
    return {
      chat: options.chat,
      executed: false
    };
  }
  attachStopGatewayContext(options.adapterContext, stopSignal);
  if (stopSignal.observed) {
    if (preflightAction.action === 'return_original_chat_direct_passthrough') {
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
    hasServertoolCliProjectionContext: false,
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
  recordServertoolExecutionSnapshot({
    stageRecorder: options.stageRecorder,
    requestId: options.requestId,
    engineResult
  });

  // Mixed tools: persist servertool outputs for next request, but return remaining tool_calls to client.
  if (runtimeAction.action === 'persist_pending_injection_and_return' && engineResult.pendingInjection) {
    await persistPendingServerToolInjection({
      pendingInjection: engineResult.pendingInjection,
      requestId: options.requestId,
      flowId,
      adapterContext: options.adapterContext
    });
    logProgress(5, totalSteps, 'completed (mixed tools; no reenter)', { flowId });
    return {
      chat: engineResult.finalChatResponse,
      executed: true,
      flowId: engineResult.execution.flowId
    };
  }
  if (runtimeAction.action === 'return_servertool_cli_projection_final') {
    logProgress(5, totalSteps, 'completed (servertool cli projection; no reenter)', { flowId });
    return {
      chat: engineResult.finalChatResponse,
      executed: true,
      flowId: engineResult.execution.flowId
    };
  }
  if (runtimeAction.action === 'return_stop_message_terminal_final') {
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
  if (runtimeAction.action === 'build_stop_message_cli_projection') {
    const projectionContext = resolveStoplessCliProjectionContext(
      engineResult.execution,
      options.adapterContext,
      engineResult.finalChatResponse
    );
    const projection = buildServertoolCliProjectionForAutoFlowShell({
      options: { requestId: options.requestId, adapterContext: options.adapterContext },
      flowId,
      reasoningText: projectionContext.reasoningText,
      ...(stoplessPlan.sessionId ? { sessionId: stoplessPlan.sessionId } : {}),
      input: {
        flowId,
        repeatCount: projectionContext.repeatCount,
        maxRepeats: projectionContext.maxRepeats,
        ...(projectionContext.triggerHint ? { triggerHint: projectionContext.triggerHint } : {}),
        ...(projectionContext.schemaFeedback ? { schemaFeedback: projectionContext.schemaFeedback } : {})
      }
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
  throw Object.assign(new Error(`[servertool] retired followup/reenter mainline reached for flow ${flowId}`), {
    code: 'SERVERTOOL_REENTER_RETIRED',
    details: {
      requestId: options.requestId,
      flowId,
      runtimeAction: runtimeAction.action
    }
  });
}
