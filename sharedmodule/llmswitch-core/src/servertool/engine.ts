import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
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

function readStopMessageFollowupText(execution: NonNullable<ServerToolEngineResult['execution']>): string {
  const context = execution.context && typeof execution.context === 'object' && !Array.isArray(execution.context)
    ? execution.context as Record<string, unknown>
    : undefined;
  const decision = context?.decision && typeof context.decision === 'object' && !Array.isArray(context.decision)
    ? context.decision as Record<string, unknown>
    : undefined;
  const decisionText = typeof decision?.followupText === 'string'
    ? decision.followupText.trim()
    : typeof decision?.followup_text === 'string'
      ? decision.followup_text.trim()
      : '';
  if (decisionText) {
    return decisionText;
  }
  const followup = execution.followup && typeof execution.followup === 'object' && !Array.isArray(execution.followup)
    ? execution.followup as Record<string, unknown>
    : undefined;
  const injection = followup?.injection && typeof followup.injection === 'object' && !Array.isArray(followup.injection)
    ? followup.injection as Record<string, unknown>
    : undefined;
  const ops = Array.isArray(injection?.ops) ? injection.ops : [];
  for (let index = ops.length - 1; index >= 0; index -= 1) {
    const op = ops[index];
    if (!op || typeof op !== 'object' || Array.isArray(op)) continue;
    const record = op as Record<string, unknown>;
    if (record.op !== 'append_user_text') continue;
    const text = typeof record.text === 'string' ? record.text.trim() : '';
    if (text) return text;
  }
  return '继续完成当前用户目标。若仍需操作、检查或验证，必须调用可用工具继续执行；不要只总结、道歉、复述状态或输出计划。只有目标已经完成时，才输出最终简短结果，并说明完成证据。';
}

function readStopMessageAssistantStopText(execution: NonNullable<ServerToolEngineResult['execution']>): string {
  const context = execution.context && typeof execution.context === 'object' && !Array.isArray(execution.context)
    ? execution.context as Record<string, unknown>
    : undefined;
  const text = typeof context?.assistantStopText === 'string' ? context.assistantStopText.trim() : '';
  return text;
}

function collectTextFromContentParts(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    const text = value.trim();
    if (text) out.push(text);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const part of value) {
    if (typeof part === 'string') {
      const text = part.trim();
      if (text) out.push(text);
      continue;
    }
    const record = part && typeof part === 'object' && !Array.isArray(part)
      ? part as Record<string, unknown>
      : undefined;
    const text = typeof record?.text === 'string'
      ? record.text
      : typeof record?.output_text === 'string'
        ? record.output_text
        : typeof record?.content === 'string'
          ? record.content
          : '';
    const trimmed = text.trim();
    if (trimmed) out.push(trimmed);
  }
}

function readAssistantStopTextFromChat(chat: unknown): string {
  const row = chat && typeof chat === 'object' && !Array.isArray(chat)
    ? chat as Record<string, unknown>
    : undefined;
  if (!row) return '';
  const texts: string[] = [];
  const choices = Array.isArray(row.choices) ? row.choices : [];
  for (const choice of choices) {
    const choiceRow = choice && typeof choice === 'object' && !Array.isArray(choice)
      ? choice as Record<string, unknown>
      : undefined;
    const message = choiceRow?.message && typeof choiceRow.message === 'object' && !Array.isArray(choiceRow.message)
      ? choiceRow.message as Record<string, unknown>
      : undefined;
    collectTextFromContentParts(message?.content, texts);
  }
  const output = Array.isArray(row.output) ? row.output : [];
  for (const item of output) {
    const itemRow = item && typeof item === 'object' && !Array.isArray(item)
      ? item as Record<string, unknown>
      : undefined;
    collectTextFromContentParts(itemRow?.content, texts);
  }
  return texts.join('\n').trim();
}

function readStopMessageRuntimeMetadata(execution: NonNullable<ServerToolEngineResult['execution']>): Record<string, unknown> | undefined {
  const context = execution.context && typeof execution.context === 'object' && !Array.isArray(execution.context)
    ? execution.context as Record<string, unknown>
    : undefined;
  if (context?.serverToolLoopState && typeof context.serverToolLoopState === 'object' && !Array.isArray(context.serverToolLoopState)) {
    return context;
  }
  const followup = execution.followup && typeof execution.followup === 'object' && !Array.isArray(execution.followup)
    ? execution.followup as Record<string, unknown>
    : undefined;
  const metadata = followup?.metadata && typeof followup.metadata === 'object' && !Array.isArray(followup.metadata)
    ? followup.metadata as Record<string, unknown>
    : undefined;
  const rt = metadata?.__rt && typeof metadata.__rt === 'object' && !Array.isArray(metadata.__rt)
    ? metadata.__rt as Record<string, unknown>
    : undefined;
  return rt ?? context;
}

function readStopMessageLoopNumber(execution: NonNullable<ServerToolEngineResult['execution']>, key: 'repeatCount' | 'maxRepeats'): number | undefined {
  const runtime = readStopMessageRuntimeMetadata(execution);
  const loopState = runtime?.serverToolLoopState && typeof runtime.serverToolLoopState === 'object' && !Array.isArray(runtime.serverToolLoopState)
    ? runtime.serverToolLoopState as Record<string, unknown>
    : undefined;
  const value = loopState?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

function buildStopMessageCliProjectionResult(args: {
  options: ServerToolOrchestrationOptions;
  execution: NonNullable<ServerToolEngineResult['execution']>;
  finalChatResponse: JsonObject;
  flowId: string;
  totalSteps: number;
  logProgress: (step: number, total: number, message: string, extra?: Record<string, unknown>) => void;
}): ServerToolOrchestrationResult {
  const continuationPrompt = readStopMessageFollowupText(args.execution);
  const assistantStopText =
    readStopMessageAssistantStopText(args.execution) ||
    readAssistantStopTextFromChat(args.finalChatResponse) ||
    '模型以 finish_reason=stop 结束，RouteCodex 正在请求继续执行。';
  const projection = buildServertoolCliProjectionForAutoFlow({
    options: args.options,
    flowId: args.flowId,
    reasoningText: assistantStopText,
    stdoutPreview: continuationPrompt,
    input: {
      continuationPrompt,
      repeatCount: readStopMessageLoopNumber(args.execution, 'repeatCount') ?? 0,
      maxRepeats: readStopMessageLoopNumber(args.execution, 'maxRepeats') ?? 1
    }
  });
  args.logProgress(5, args.totalSteps, 'completed (stop_message_auto cli projection; no reenter)', {
    flowId: args.flowId
  });
  return {
    chat: projection.chatResponse,
    executed: true,
    flowId: args.flowId
  };
}

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
  if (flowId === 'stop_message_flow') {
    return buildStopMessageCliProjectionResult({
      options,
      execution: engineResult.execution,
      finalChatResponse: engineResult.finalChatResponse,
      flowId,
      totalSteps,
      logProgress
    });
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
