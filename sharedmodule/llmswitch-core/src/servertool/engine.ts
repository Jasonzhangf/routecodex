import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ProviderInvoker, ServerSideToolEngineOptions } from './types.js';
import { runServerSideToolEngine } from './server-side-tools.js';
import { ProviderProtocolError } from '../conversion/provider-protocol-error.js';
import { ensureRuntimeMetadata, readRuntimeMetadata } from '../conversion/runtime-metadata.js';
import { createHash } from 'node:crypto';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateAsync,
  saveRoutingInstructionStateSync
} from '../router/virtual-router/sticky-session-store.js';
import type { RoutingInstructionState } from '../router/virtual-router/routing-instructions.js';
import {
  deserializeRoutingInstructionState,
  serializeRoutingInstructionState
} from '../router/virtual-router/routing-instructions.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import { applyHubFollowupPolicyShadow } from './followup-shadow.js';
import { buildServerToolFollowupChatPayloadFromInjection, extractCapturedChatSeed } from './handlers/followup-request-builder.js';
import { findNextUndeliveredDueAtMs, listClockTasks, resolveClockConfig } from './clock/task-store.js';
import { resolveClockSessionScope } from './clock/session-scope.js';
import { savePendingServerToolInjection } from './pending-session.js';
import { appendServerToolProgressFileEvent } from './log/progress-file.js';
import { attachStopGatewayContext, inspectStopGatewaySignal } from './stop-gateway-context.js';
import { formatStopMessageCompareContext, readStopMessageCompareContext } from './stop-message-compare-context.js';

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

type ServerToolLoopState = {
  flowId?: string;
  payloadHash?: string;
  repeatCount?: number;
  startedAtMs?: number;
  stopPairHash?: string;
  stopPairRepeatCount?: number;
  stopPairWarned?: boolean;
};

const STOP_MESSAGE_STAGE_TIMEOUT_MS = 900_000;
const STOP_MESSAGE_LOOP_WARN_THRESHOLD = 5;
const STOP_MESSAGE_LOOP_FAIL_THRESHOLD = 10;

function parseTimeoutMs(raw: unknown, fallback: number): number {
  const n = typeof raw === 'string' ? Number(raw.trim()) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.floor(n);
}

function resolveServerToolTimeoutMs(): number {
  return parseTimeoutMs(
    process.env.ROUTECODEX_SERVERTOOL_TIMEOUT_MS ||
      process.env.RCC_SERVERTOOL_TIMEOUT_MS ||
      process.env.LLMSWITCH_SERVERTOOL_TIMEOUT_MS,
    500_000
  );
}

function resolveServerToolFollowupTimeoutMs(fallback: number): number {
  return parseTimeoutMs(
    process.env.ROUTECODEX_SERVERTOOL_FOLLOWUP_TIMEOUT_MS ||
      process.env.RCC_SERVERTOOL_FOLLOWUP_TIMEOUT_MS ||
      process.env.LLMSWITCH_SERVERTOOL_FOLLOWUP_TIMEOUT_MS,
    fallback
  );
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  buildError: () => Error
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  let timer: NodeJS.Timeout | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(buildError()), timeoutMs);
    promise.then(resolve, reject).finally(() => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    });
  });
}

class ServerToolClientDisconnectedError extends Error {
  code = 'SERVERTOOL_CLIENT_DISCONNECTED';
}

function createServerToolClientDisconnectedError(options: {
  requestId: string;
  flowId?: string;
}): ServerToolClientDisconnectedError {
  const error = new ServerToolClientDisconnectedError(
    `[servertool] client disconnected during followup` + (options.flowId ? ` flow=${options.flowId}` : '')
  );
  (error as unknown as { details?: Record<string, unknown> }).details = {
    requestId: options.requestId,
    flowId: options.flowId
  };
  return error;
}

function isServerToolClientDisconnectedError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      typeof (error as { code?: unknown }).code === 'string' &&
      (error as { code: string }).code === 'SERVERTOOL_CLIENT_DISCONNECTED'
  );
}

function createClientDisconnectWatcher(options: {
  adapterContext: AdapterContext;
  requestId: string;
  flowId?: string;
  pollIntervalMs?: number;
}): { promise: Promise<never>; cancel: () => void } {
  const interval =
    typeof options.pollIntervalMs === 'number' && Number.isFinite(options.pollIntervalMs) && options.pollIntervalMs > 0
      ? Math.max(20, Math.floor(options.pollIntervalMs))
      : 80;
  let timer: NodeJS.Timeout | undefined;
  let active = true;
  const cancel = () => {
    active = false;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const promise = new Promise<never>((_resolve, reject) => {
    const check = () => {
      if (!active) {
        return;
      }
      if (isAdapterClientDisconnected(options.adapterContext)) {
        cancel();
        reject(
          createServerToolClientDisconnectedError({
            requestId: options.requestId,
            flowId: options.flowId
          })
        );
        return;
      }
      timer = setTimeout(check, interval);
      timer.unref?.();
    };
    timer = setTimeout(check, interval);
    timer.unref?.();
  });
  return { promise, cancel };
}

function isServerToolTimeoutError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      typeof (error as { code?: unknown }).code === 'string' &&
      (error as { code: string }).code === 'SERVERTOOL_TIMEOUT'
  );
}

function createServerToolTimeoutError(options: {
  requestId: string;
  phase: 'engine' | 'followup';
  timeoutMs: number;
  flowId?: string;
  attempt?: number;
  maxAttempts?: number;
}): ProviderProtocolError & { status?: number } {
  const err = new ProviderProtocolError(
    `[servertool] ${options.phase} timeout after ${options.timeoutMs}ms` +
      (options.flowId ? ` flow=${options.flowId}` : ''),
    {
      code: 'SERVERTOOL_TIMEOUT',
      category: 'INTERNAL_ERROR',
      details: {
        requestId: options.requestId,
        phase: options.phase,
        flowId: options.flowId,
        timeoutMs: options.timeoutMs,
        attempt: options.attempt,
        maxAttempts: options.maxAttempts
      }
    }
  ) as ProviderProtocolError & { status?: number };
  err.status = 504;
  return err;
}

function createStopMessageFetchFailedError(options: {
  requestId: string;
  reason: 'stage_timeout' | 'loop_limit';
  elapsedMs?: number;
  repeatCount?: number;
  timeoutMs?: number;
  attempt?: number;
  maxAttempts?: number;
}): ProviderProtocolError & { status?: number } {
  const baseMessage =
    options.reason === 'loop_limit'
      ? 'fetch failed: network error (stopMessage loop detected)'
      : 'fetch failed: network error (stopMessage exceeded stage timeout)';
  const err = new ProviderProtocolError(baseMessage, {
    code: 'SERVERTOOL_TIMEOUT',
    category: 'EXTERNAL_ERROR',
    details: {
      requestId: options.requestId,
      reason: options.reason,
      ...(typeof options.elapsedMs === 'number' && Number.isFinite(options.elapsedMs)
        ? { elapsedMs: Math.max(0, Math.floor(options.elapsedMs)) }
        : {}),
      ...(typeof options.repeatCount === 'number' && Number.isFinite(options.repeatCount)
        ? { repeatCount: Math.max(0, Math.floor(options.repeatCount)) }
        : {}),
      ...(typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? { timeoutMs: Math.max(0, Math.floor(options.timeoutMs)) }
        : {}),
      ...(typeof options.attempt === 'number' && Number.isFinite(options.attempt)
        ? { attempt: Math.max(1, Math.floor(options.attempt)) }
        : {}),
      ...(typeof options.maxAttempts === 'number' && Number.isFinite(options.maxAttempts)
        ? { maxAttempts: Math.max(1, Math.floor(options.maxAttempts)) }
        : {})
    }
  }) as ProviderProtocolError & { status?: number };
  err.status = 502;
  return err;
}

function coerceFollowupPayloadStream(payload: JsonObject, stream: boolean): JsonObject {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  // ServerTool followup requests must be non-streaming to keep parsing deterministic and avoid
  // provider-side SSE wrappers leaking into internal reenter calls.
  if (stream === false) {
    (payload as Record<string, unknown>).stream = false;
  }
  return payload;
}

function hasNonEmptyText(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasNonEmptyText(entry));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (hasNonEmptyText(record.text)) return true;
    if (hasNonEmptyText(record.output_text)) return true;
    if (hasNonEmptyText(record.content)) return true;
  }
  return false;
}

function isEmptyClientResponsePayload(payload: JsonObject): boolean {
  if (!payload || typeof payload !== 'object') {
    return true;
  }
  // If upstream returned an explicit error shape, treat as non-empty (caller should surface it).
  if (Object.prototype.hasOwnProperty.call(payload as Record<string, unknown>, 'error')) {
    return false;
  }

  // OpenAI Responses: requires_action (function_call output) is a meaningful response and must not be
  // treated as "empty". Some auto-followup servertools (for example stop_message_flow)
  // previously misclassified this as empty because there is no output_text/content yet.
  const requiredAction = (payload as any).required_action;
  if (requiredAction && typeof requiredAction === 'object') {
    return false;
  }
  const outputForResponses = Array.isArray((payload as any).output) ? (payload as any).output : [];
  if (outputForResponses.length > 0) {
    for (const item of outputForResponses) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const type = typeof (item as any).type === 'string' ? String((item as any).type).trim().toLowerCase() : '';
      if (type === 'function_call' || type === 'tool_call' || type === 'tool_use' || type.includes('tool')) {
        return false;
      }
    }
  }

  const choices = Array.isArray((payload as any).choices) ? (payload as any).choices : [];
  if (choices.length > 0) {
    const first = choices[0] && typeof choices[0] === 'object' && !Array.isArray(choices[0]) ? choices[0] : null;
    const message =
      first && typeof (first as any).message === 'object' && (first as any).message !== null && !Array.isArray((first as any).message)
        ? (first as any).message
        : null;
    if (!message) {
      return true;
    }
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length > 0) {
      return false;
    }
    // Support common chat shapes: content string/array, reasoning_content, etc.
    if (hasNonEmptyText(message.content)) return false;
    if (hasNonEmptyText((message as any).reasoning_content)) return false;
    if (hasNonEmptyText((message as any).reasoning)) return false;
    return true;
  }

  const output = Array.isArray((payload as any).output) ? (payload as any).output : [];
  if (output.length > 0) {
    for (const item of output) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const content = (item as any).content;
      if (hasNonEmptyText(content)) {
        return false;
      }
      if (hasNonEmptyText((item as any).text)) return false;
      if (hasNonEmptyText((item as any).output_text)) return false;
    }
    return true;
  }

  return true;
}

function createEmptyFollowupError(args: {
  flowId?: string;
  requestId: string;
  lastError?: unknown;
  originalResponseWasEmpty?: boolean;
}): ProviderProtocolError & { status?: number; cause?: unknown } {
  const wrapped = new ProviderProtocolError(
    `[servertool] Followup returned empty response for flow ${args.flowId ?? 'unknown'}`,
    {
      code: 'SERVERTOOL_EMPTY_FOLLOWUP',
      category: 'EXTERNAL_ERROR',
      details: {
        flowId: args.flowId,
        requestId: args.requestId,
        error: args.lastError instanceof Error ? args.lastError.message : undefined,
        ...(args.originalResponseWasEmpty ? { originalResponseWasEmpty: true } : {})
      }
    }
  ) as ProviderProtocolError & { status?: number; cause?: unknown };
  wrapped.status = 502;
  wrapped.cause = args.lastError;
  return wrapped;
}

function isStopFinishReasonWithoutToolCalls(base: unknown): boolean {
  return inspectStopGatewaySignal(base).eligible;
}

async function shouldDisableServerToolTimeoutForClockHold(args: {
  chat: JsonObject;
  adapterContext: AdapterContext;
  serverToolTimeoutMs: number;
}): Promise<boolean> {
  // Only relevant for stop/length responses: clock_auto may hold indefinitely.
  if (!isStopFinishReasonWithoutToolCalls(args.chat)) {
    return false;
  }
  const record = args.adapterContext as unknown as Record<string, unknown>;
  const rt = readRuntimeMetadata(record);
  const sessionId = resolveClockSessionScope(record, rt as unknown as Record<string, unknown>);
  if (!sessionId) {
    return false;
  }
  const clockConfig = resolveClockConfig((rt as any)?.clock);
  if (!clockConfig) {
    return false;
  }
  // If already within due window, clock_auto won't need long hold.
  try {
    const tasks = await listClockTasks(sessionId, clockConfig);
    const at = Date.now();
    const nextDueAtMs = findNextUndeliveredDueAtMs(tasks, at);
    if (!nextDueAtMs) {
      return false;
    }
    const thresholdMs = nextDueAtMs - clockConfig.dueWindowMs;
    if (thresholdMs <= at) {
      return false;
    }
    // Only disable when the wait exceeds current timeout.
    if (args.serverToolTimeoutMs > 0 && thresholdMs - at <= args.serverToolTimeoutMs) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function runServerToolOrchestration(
  options: ServerToolOrchestrationOptions
): Promise<ServerToolOrchestrationResult> {
  const BLUE = '\x1b[38;5;39m';
  const YELLOW = '\x1b[38;5;214m';
  const GOLD = '\x1b[38;5;220m';
  const RESET = '\x1b[0m';

  const resolveToolName = (flowId: string): string => {
    const normalized = flowId.trim();
    if (!normalized) return 'unknown';
    const mapping: Record<string, string> = {
      continue_execution_flow: 'continue_execution',
      review_flow: 'review',
      stop_message_flow: 'stop_message_auto',
      apply_patch_guard: 'apply_patch_guard',
      exec_command_guard: 'exec_command_guard',
      iflow_model_error_retry: 'iflow_model_error_retry',
      antigravity_thought_signature_bootstrap: 'antigravity_thought_signature_bootstrap',
      web_search_flow: 'web_search',
      vision_flow: 'vision_auto',
      clock_flow: 'clock',
      clock_hold_flow: 'clock_auto',
      recursive_detection_guard: 'recursive_detection_guard'
    };
    return mapping[normalized] ?? normalized;
  };

  const resolveStage = (step: number, message: string): string => {
    const normalized = message.trim().toLowerCase();
    if (normalized === 'matched' || step <= 1) return 'match';
    if (normalized.startsWith('completed') || step >= 5) return 'final';
    return 'followup';
  };

  const normalizeResult = (message: string): string => {
    const normalized = message.trim().toLowerCase();
    if (!normalized) return 'unknown';
    const group = /^completed\s*\(([^)]+)\)/.exec(normalized);
    if (group && group[1]) {
      return 'completed_' + group[1].trim().replace(/[^a-z0-9]+/g, '_');
    }
    return normalized.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
  };

  const logStopEntry = (stage: 'entry' | 'trigger', result: string, extra?: Record<string, unknown>): void => {
    const color = BLUE;
    const viewStage = stage === 'trigger' ? 'match' : 'entry';
    const source = typeof extra?.source === 'string' ? extra.source : 'unknown';
    const reason = typeof extra?.reason === 'string' ? extra.reason : 'unknown';
    const eligible = typeof extra?.eligible === 'boolean' ? String(extra.eligible) : 'unknown';
    const flowId = typeof extra?.flowId === 'string' ? extra.flowId : '';
    const brief =
      stage === 'entry'
        ? `source=${source} reason=${reason} eligible=${eligible}`
        : `result=${result} flow=${flowId || 'none'}`;
    try {
      // eslint-disable-next-line no-console
      console.log(
        `${color}[servertool][stop_watch] requestId=${options.requestId} stage=${viewStage} ${brief}${RESET}`
      );
    } catch {
      /* best-effort logging */
    }
    appendServerToolProgressFileEvent({
      requestId: options.requestId,
      flowId: 'stop_message_flow',
      tool: 'stop_message_auto',
      stage,
      result,
      message: result,
      step: stage === 'entry' ? 0 : 2,
      entryEndpoint: options.entryEndpoint,
      providerProtocol: options.providerProtocol
    });
  };

  const logProgress = (step: number, _total: number, message: string, extra?: Record<string, unknown>): void => {
    const flowId = typeof extra?.flowId === 'string' ? extra.flowId.trim() : '';
    const tool = resolveToolName(flowId);
    const stage = resolveStage(step, message);
    const result = normalizeResult(message);
    const color = flowId === 'continue_execution_flow' ? GOLD : YELLOW;
    try {
      // eslint-disable-next-line no-console
      console.log(`${color}[servertool] requestId=${options.requestId} tool=${tool} stage=${stage} result=${result}${RESET}`);
    } catch {
      /* best-effort logging */
    }
    appendServerToolProgressFileEvent({
      requestId: options.requestId,
      flowId: flowId || 'none',
      tool,
      stage,
      result,
      message,
      step,
      entryEndpoint: options.entryEndpoint,
      providerProtocol: options.providerProtocol
    });
  };

  const logAutoHookTrace = (event: {
    hookId: string;
    phase: string;
    priority: number;
    queue: 'A_optional' | 'B_mandatory';
    queueIndex: number;
    queueTotal: number;
    result: 'miss' | 'match' | 'error';
    reason: string;
    flowId?: string;
  }): void => {
    const reasonToken =
      typeof event.reason === 'string' && event.reason.trim()
        ? event.reason.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
        : 'unknown';
    appendServerToolProgressFileEvent({
      requestId: options.requestId,
      flowId: event.flowId || `hook:${event.hookId}`,
      tool: event.hookId,
      stage: 'hook',
      result: `${event.result}_${reasonToken || 'unknown'}`,
      message: `${event.result} (${event.reason}) queue=${event.queue}[${event.queueIndex}/${event.queueTotal}] phase=${event.phase} priority=${event.priority}`,
      step: 2,
      entryEndpoint: options.entryEndpoint,
      providerProtocol: options.providerProtocol
    });
    try {
      options.stageRecorder?.record('servertool.hook', {
        hookId: event.hookId,
        phase: event.phase,
        priority: event.priority,
        result: event.result,
        reason: event.reason,
        queue: event.queue,
        queueIndex: event.queueIndex,
        queueTotal: event.queueTotal,
        ...(event.flowId ? { flowId: event.flowId } : {})
      });
    } catch {
      // best-effort only
    }

    if (event.hookId === 'stop_message_auto' && event.result === 'miss') {
      const compareContext = readStopMessageCompareContext(options.adapterContext);
      const summary = formatStopMessageCompareContext(compareContext);
      try {
        // eslint-disable-next-line no-console
        console.log(
          `${BLUE}[servertool][stop_compare] requestId=${options.requestId} stage=miss flow=none ${summary}${RESET}`
        );
      } catch {
        // best-effort logging
      }
      const compareResult = compareContext
        ? `${compareContext.decision}_${compareContext.reason.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'unknown'}`
        : 'unknown_no_context';
      appendServerToolProgressFileEvent({
        requestId: options.requestId,
        flowId: 'none',
        tool: 'stop_message_auto',
        stage: 'compare',
        result: compareResult,
        message: summary,
        step: 2,
        entryEndpoint: options.entryEndpoint,
        providerProtocol: options.providerProtocol
      });
    }
  };

  const logStopCompare = (stage: 'entry' | 'trigger', flowId?: string): void => {
    const compareContext = readStopMessageCompareContext(options.adapterContext);
    const summary = formatStopMessageCompareContext(compareContext);
    const viewStage = stage === 'trigger' ? 'match' : 'entry';
    const flowToken = flowId && flowId.trim() ? flowId.trim() : 'none';
    try {
      // eslint-disable-next-line no-console
      console.log(
        `${BLUE}[servertool][stop_compare] requestId=${options.requestId} stage=${viewStage} flow=${flowToken} ${summary}${RESET}`
      );
    } catch {
      // best-effort logging
    }
    const compareResult = compareContext
      ? `${compareContext.decision}_${compareContext.reason.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'unknown'}`
      : 'unknown_no_context';
    appendServerToolProgressFileEvent({
      requestId: options.requestId,
      flowId: flowToken,
      tool: 'stop_message_auto',
      stage: 'compare',
      result: compareResult,
      message: summary,
      step: stage === 'entry' ? 1 : 3,
      entryEndpoint: options.entryEndpoint,
      providerProtocol: options.providerProtocol
    });
    try {
      options.stageRecorder?.record('servertool.stop_compare', {
        stage: viewStage,
        flowId: flowToken,
        summary,
        ...(compareContext ? { compare: compareContext } : {})
      });
    } catch {
      // best-effort only
    }
  };

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
    serverToolTimeoutMs
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

  const runEngine = async (
    overrides: Partial<ServerSideToolEngineOptions>
  ): Promise<Awaited<ReturnType<typeof runServerSideToolEngine>>> =>
    withTimeout(
      runServerSideToolEngine({
        ...engineOptions,
        ...overrides
      }),
      effectiveServerToolTimeoutMs,
      () =>
        createServerToolTimeoutError({
          requestId: options.requestId,
          phase: 'engine',
          timeoutMs: effectiveServerToolTimeoutMs || serverToolTimeoutMs
        })
    );

  // StopMessage owns a dedicated orchestration skeleton:
  // same trigger/processing semantics as before, but isolated from the generic servertool queue.
  let engineResult = await runEngine({
    disableToolCallHandlers: true,
    includeAutoHookIds: ['stop_message_auto']
  });
  if (engineResult.mode === 'passthrough' || !engineResult.execution) {
    engineResult = await runEngine({
      excludeAutoHookIds: ['stop_message_auto']
    });
  }
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
    try {
      options.stageRecorder?.record('servertool.match', {
        matched: false,
        mode: engineResult.mode,
        reason: skipReason
      });
    } catch {
      // best-effort only
    }
    appendServerToolProgressFileEvent({
      requestId: options.requestId,
      flowId: 'none',
      tool: 'none',
      stage: 'match',
      result: 'skipped_' + skipReason,
      message: 'skipped (' + skipReason + ')',
      step: 0,
      entryEndpoint: options.entryEndpoint,
      providerProtocol: options.providerProtocol
    });
    return {
      chat: engineResult.finalChatResponse,
      executed: false
    };
  }

  const flowId = engineResult.execution.flowId ?? 'unknown';
  if (stopSignal.observed) {
    logStopEntry('trigger', flowId === 'stop_message_flow' ? 'activated' : 'non_stop_flow', {
      flowId,
      reason: stopSignal.reason,
      source: stopSignal.source,
      eligible: stopSignal.eligible
    });
    logStopCompare('trigger', flowId);
  }
  try {
    options.stageRecorder?.record('servertool.match', {
      matched: true,
      flowId,
      hasFollowup: Boolean(engineResult.execution.followup)
    });
  } catch {
    // best-effort only
  }
  const totalSteps = 5;
  logProgress(1, totalSteps, 'matched', { flowId });

  // Mixed tools: persist servertool outputs for next request, but return remaining tool_calls to client.
  if (engineResult.pendingInjection) {
    const sessionId = engineResult.pendingInjection.sessionId;
    if (sessionId && sessionId.trim()) {
      try {
        await savePendingServerToolInjection(sessionId.trim(), {
          createdAtMs: Date.now(),
          afterToolCallIds: engineResult.pendingInjection.afterToolCallIds,
          messages: engineResult.pendingInjection.messages,
          sourceRequestId: options.requestId
        });
      } catch {
        // best-effort: do not fail the response conversion just because persistence failed
      }
    }
    logProgress(5, totalSteps, 'completed (mixed tools; no reenter)', { flowId });
    return {
      chat: engineResult.finalChatResponse,
      executed: true,
      flowId: engineResult.execution.flowId
    };
  }

  if (!engineResult.execution.followup) {
    logProgress(5, totalSteps, 'completed (no followup)', { flowId });
    return {
      chat: engineResult.finalChatResponse,
      executed: true,
      flowId: engineResult.execution.flowId
    };
  }

  const isStopMessageFlow = engineResult.execution.flowId === 'stop_message_flow';
  const isClockHoldFlow = engineResult.execution.flowId === 'clock_hold_flow';
  const isContinueExecutionFlow = engineResult.execution.flowId === 'continue_execution_flow';
  const isReviewFlow = engineResult.execution.flowId === 'review_flow';
  const isApplyPatchGuard = engineResult.execution.flowId === 'apply_patch_guard';
  const isExecCommandGuard = engineResult.execution.flowId === 'exec_command_guard';
  const isErrorAutoFlow = engineResult.execution.flowId === 'iflow_model_error_retry';
  const applyAutoLimit = isErrorAutoFlow || isApplyPatchGuard || isExecCommandGuard;
  // ServerTool followups must not inherit or inject any routeHint; always route fresh.
  const preserveRouteHint = false;
  const followupPlan = engineResult.execution.followup;
  const followupEntryEndpoint =
    ('entryEndpoint' in (engineResult.execution.followup as object)
      ? (engineResult.execution.followup as { entryEndpoint?: string }).entryEndpoint
      : undefined) ||
    options.entryEndpoint ||
    '/v1/chat/completions';

  const followupPayloadRaw: JsonObject | null = (() => {
    if (
      followupPlan &&
      typeof followupPlan === 'object' &&
      !Array.isArray(followupPlan) &&
      Object.prototype.hasOwnProperty.call(followupPlan, 'payload')
    ) {
      const candidate = (followupPlan as unknown as { payload?: unknown }).payload;
      return candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? (candidate as JsonObject) : null;
    }
    if (
      followupPlan &&
      typeof followupPlan === 'object' &&
      !Array.isArray(followupPlan) &&
      Object.prototype.hasOwnProperty.call(followupPlan, 'injection')
    ) {
      const injection = (followupPlan as unknown as { injection?: unknown }).injection;
      if (!injection || typeof injection !== 'object' || Array.isArray(injection)) {
        return null;
      }
      return buildServerToolFollowupChatPayloadFromInjection({
        adapterContext: options.adapterContext,
        chatResponse: engineResult.finalChatResponse,
        injection: injection as any
      });
    }
    return null;
  })();

  const metadataOnlyFollowup =
    !followupPayloadRaw &&
    Boolean(
      followupPlan &&
        typeof followupPlan === 'object' &&
        !Array.isArray(followupPlan) &&
        Object.prototype.hasOwnProperty.call(followupPlan, 'metadata')
    );

  if (!followupPayloadRaw && !metadataOnlyFollowup) {
    logProgress(5, totalSteps, 'completed (missing followup payload)', { flowId });
    return {
      chat: engineResult.finalChatResponse,
      executed: true,
      flowId: engineResult.execution.flowId
    };
  }
  const loopPayload =
    followupPayloadRaw ||
    (engineResult.execution.flowId === 'stop_message_flow'
      ? buildStopMessageLoopPayload(options.adapterContext)
      : null);
  const loopState = loopPayload
    ? buildServerToolLoopState(
        options.adapterContext,
        engineResult.execution.flowId,
        loopPayload as JsonObject,
        engineResult.finalChatResponse
      )
    : null;
  const stopMessageReservation: StopMessageUsageReservation | null = null;
  if (applyAutoLimit && loopState && typeof loopState.repeatCount === 'number' && loopState.repeatCount >= 3) {
    logProgress(5, totalSteps, 'completed (auto limit hit)', { flowId });
    return {
      chat: engineResult.finalChatResponse,
      executed: true,
      flowId: engineResult.execution.flowId
    };
  }

  let shouldInjectStopLoopWarning = false;
  if (isStopMessageFlow && loopState) {
    const elapsedMs =
      typeof loopState.startedAtMs === 'number' && Number.isFinite(loopState.startedAtMs)
        ? Math.max(0, Date.now() - loopState.startedAtMs)
        : 0;
    if (elapsedMs >= STOP_MESSAGE_STAGE_TIMEOUT_MS) {
      throw createStopMessageFetchFailedError({
        requestId: options.requestId,
        reason: 'stage_timeout',
        elapsedMs,
        timeoutMs: STOP_MESSAGE_STAGE_TIMEOUT_MS
      });
    }

    const pairRepeatCount =
      typeof loopState.stopPairRepeatCount === 'number' && Number.isFinite(loopState.stopPairRepeatCount)
        ? Math.max(0, Math.floor(loopState.stopPairRepeatCount))
        : 0;
    if (pairRepeatCount >= STOP_MESSAGE_LOOP_FAIL_THRESHOLD) {
      throw createStopMessageFetchFailedError({
        requestId: options.requestId,
        reason: 'loop_limit',
        elapsedMs,
        repeatCount: pairRepeatCount
      });
    }
    if (pairRepeatCount >= STOP_MESSAGE_LOOP_WARN_THRESHOLD && !loopState.stopPairWarned) {
      loopState.stopPairWarned = true;
      shouldInjectStopLoopWarning = true;
      logProgress(2, totalSteps, 'loop warning armed', { flowId });
    }
  }

  if (isAdapterClientDisconnected(options.adapterContext)) {
    logProgress(5, totalSteps, 'completed (client disconnected)', { flowId });
    return {
      chat: engineResult.finalChatResponse,
      executed: true,
      flowId: engineResult.execution.flowId
    };
  }

  const metadata: JsonObject = {
    stream: false,
    ...(engineResult.execution.followup.metadata ?? {})
  };
  const rt = ensureRuntimeMetadata(metadata as unknown as Record<string, unknown>);
  (rt as Record<string, unknown>).serverToolFollowup = true;
  if (loopState) {
    (rt as Record<string, unknown>).serverToolLoopState = loopState;
  }
  // Followup re-enters HubPipeline at chat-process entry with a canonical "chat-like" body.
  // This avoids re-running per-protocol inbound parse/semantic-map for each client protocol.
  (metadata as any).__hubEntry = 'chat_process';
  // Enforce unified followup contract:
  // - clear any inherited routeHint
  // - do not inherit sticky target
  // - record original entry endpoint for downstream formatting/debug
  (rt as Record<string, unknown>).preserveRouteHint = preserveRouteHint as any;
  (rt as Record<string, unknown>).disableStickyRoutes = true as any;
  (rt as Record<string, unknown>).serverToolOriginalEntryEndpoint =
    (typeof options.entryEndpoint === 'string' && options.entryEndpoint.trim().length
      ? options.entryEndpoint
      : followupEntryEndpoint) as any;
  // For stateful auto-followups (e.g. stop_message_flow / clock_hold_flow / continue_execution_flow),
  // keep the same providerKey/alias.
  // Otherwise the followup requestId suffix would cause round-robin alias switching and compatibility drift.
  if (isStopMessageFlow || isClockHoldFlow || isContinueExecutionFlow || isReviewFlow) {
    const providerKeyRaw = (options.adapterContext as unknown as { providerKey?: unknown }).providerKey;
    const providerKey =
      typeof providerKeyRaw === 'string' && providerKeyRaw.trim().length ? providerKeyRaw.trim() : '';
    if (providerKey) {
      (metadata as any).__shadowCompareForcedProviderKey = providerKey;
    }
  }

  const retryEmptyFollowupOnce = isStopMessageFlow;
  const maxAttempts = retryEmptyFollowupOnce ? 2 : 1;
  const followupRequestId = buildFollowupRequestId(
    options.requestId,
    engineResult.execution.followup.requestIdSuffix
  );
  const clientInjectOnlyRaw = (metadata as Record<string, unknown>).clientInjectOnly;
  const clientInjectOnly =
    clientInjectOnlyRaw === true ||
    (typeof clientInjectOnlyRaw === 'string' && clientInjectOnlyRaw.trim().toLowerCase() === 'true');
  if (clientInjectOnly) {
    if (!options.clientInjectDispatch) {
      const wrapped = new ProviderProtocolError('[servertool] client inject dispatcher unavailable', {
        code: 'SERVERTOOL_FOLLOWUP_FAILED',
        category: 'INTERNAL_ERROR',
        details: {
          flowId: engineResult.execution.flowId,
          requestId: options.requestId,
          upstreamCode: 'client_inject_failed',
          reason: 'client_inject_dispatcher_unavailable'
        }
      }) as ProviderProtocolError & { status?: number };
      wrapped.status = 502;
      throw wrapped;
    }
    const disconnectWatcher = createClientDisconnectWatcher({
      adapterContext: options.adapterContext,
      requestId: options.requestId,
      flowId: engineResult.execution.flowId
    });
    try {
      const injectFollowupBody: JsonObject =
        isStopMessageFlow
          ? {}
          : (followupPayloadRaw && typeof followupPayloadRaw === 'object' && !Array.isArray(followupPayloadRaw)
            ? coerceFollowupPayloadStream(
                followupPayloadRaw as JsonObject,
                metadata.stream === true
              )
            : ({} as JsonObject));
      if (isStopMessageFlow && shouldInjectStopLoopWarning && loopState) {
        (injectFollowupBody as Record<string, unknown>).messages = [];
        appendStopMessageLoopWarning(
          injectFollowupBody,
          loopState.stopPairRepeatCount ?? STOP_MESSAGE_LOOP_WARN_THRESHOLD
        );
      }
      const dispatchResult = await withTimeout(
        Promise.race([
          options.clientInjectDispatch({
            entryEndpoint: followupEntryEndpoint,
            requestId: followupRequestId,
            body: injectFollowupBody,
            metadata
          }),
          disconnectWatcher.promise
        ]),
        followupTimeoutMs,
        () =>
          createServerToolTimeoutError({
            requestId: options.requestId,
            phase: 'followup',
            timeoutMs: followupTimeoutMs,
            flowId: engineResult.execution.flowId
          })
      );
      if (!dispatchResult || dispatchResult.ok !== true) {
        const wrapped = new ProviderProtocolError('[servertool.inject] client injection failed', {
          code: 'SERVERTOOL_FOLLOWUP_FAILED',
          details: {
            flowId: engineResult.execution.flowId,
            requestId: options.requestId,
            upstreamCode: 'client_inject_failed',
            reason:
              dispatchResult && typeof dispatchResult.reason === 'string' && dispatchResult.reason.trim()
                ? dispatchResult.reason.trim()
                : 'client_inject_not_handled'
          }
        }) as ProviderProtocolError & { status?: number };
        wrapped.status = 502;
        throw wrapped;
      }
      disconnectWatcher.cancel();
      const decorated = decorateFinalChatWithServerToolContext(engineResult.finalChatResponse, engineResult.execution);
      logProgress(5, totalSteps, 'completed (client inject only)', { flowId });
      return {
        chat: decorated,
        executed: true,
        flowId: engineResult.execution.flowId
      };
    } catch (error) {
      disconnectWatcher.cancel();
      if (isServerToolClientDisconnectedError(error) || isAdapterClientDisconnected(options.adapterContext)) {
        logProgress(5, totalSteps, 'completed (client disconnected)', { flowId });
        return {
          chat: engineResult.finalChatResponse,
          executed: true,
          flowId: engineResult.execution.flowId
        };
      }
      if (isStopMessageFlow) {
        disableStopMessageAfterFailedFollowup(options.adapterContext, stopMessageReservation);
        logProgress(5, totalSteps, 'failed (stopMessage client inject failed; state cleared)', { flowId });
        throw error;
      }
      throw error;
    }
  }

  if (!options.reenterPipeline) {
    const wrapped = new ProviderProtocolError('[servertool] followup requires reenter pipeline', {
      code: 'SERVERTOOL_FOLLOWUP_FAILED',
      category: 'INTERNAL_ERROR',
      details: {
        flowId: engineResult.execution.flowId,
        requestId: options.requestId,
        reason: 'reenter_pipeline_unavailable'
      }
    }) as ProviderProtocolError & { status?: number };
    wrapped.status = 502;
    throw wrapped;
  }

  if (!followupPayloadRaw) {
    const decorated = decorateFinalChatWithServerToolContext(engineResult.finalChatResponse, engineResult.execution);
    logProgress(5, totalSteps, 'completed (metadata-only followup without payload)', { flowId });
    return {
      chat: decorated,
      executed: true,
      flowId: engineResult.execution.flowId
    };
  }

  // Build followup payload for non-client-inject flows
  let followupPayload = coerceFollowupPayloadStream(
    followupPayloadRaw,
    metadata.stream === true
  );
  if (shouldInjectStopLoopWarning && loopState) {
    appendStopMessageLoopWarning(followupPayload, loopState.stopPairRepeatCount ?? STOP_MESSAGE_LOOP_WARN_THRESHOLD);
  }
  followupPayload = applyHubFollowupPolicyShadow({
    requestId: followupRequestId,
    entryEndpoint: followupEntryEndpoint,
    flowId: engineResult.execution.flowId,
    payload: followupPayload,
    stageRecorder: options.stageRecorder
  });

  let followup:
    | { body?: JsonObject; __sse_responses?: unknown; format?: string }
    | undefined;
  let lastError: unknown;
  // stopMessage 是一种“状态型” servertool：一旦触发，我们需要尽量避免因 followup 失败而把状态留在可继续触发的位置，
  // 否则会出现下一轮仍然自动触发 → 再次失败 → 客户端永远 502 的死循环。
  //
  // stop_message_flow 的计数器递增由 handler 在决定触发时处理，engine 不再提前递增。
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const elapsedBeforeAttempt =
      isStopMessageFlow && loopState && typeof loopState.startedAtMs === 'number' && Number.isFinite(loopState.startedAtMs)
        ? Math.max(0, Date.now() - loopState.startedAtMs)
        : 0;
    if (isStopMessageFlow && elapsedBeforeAttempt >= STOP_MESSAGE_STAGE_TIMEOUT_MS) {
      throw createStopMessageFetchFailedError({
        requestId: options.requestId,
        reason: 'stage_timeout',
        elapsedMs: elapsedBeforeAttempt,
        timeoutMs: STOP_MESSAGE_STAGE_TIMEOUT_MS,
        attempt,
        maxAttempts
      });
    }

    const attemptTimeoutMs =
      isStopMessageFlow && STOP_MESSAGE_STAGE_TIMEOUT_MS > elapsedBeforeAttempt
        ? Math.max(1, Math.min(followupTimeoutMs, STOP_MESSAGE_STAGE_TIMEOUT_MS - elapsedBeforeAttempt))
        : followupTimeoutMs;

    const disconnectWatcher = createClientDisconnectWatcher({
      adapterContext: options.adapterContext,
      requestId: options.requestId,
      flowId: engineResult.execution.flowId
    });
    try {
      const followupPromise = options.reenterPipeline({
        entryEndpoint: followupEntryEndpoint,
        requestId: followupRequestId,
        body: followupPayload,
        metadata
      });
      followup = await withTimeout(
        Promise.race([followupPromise, disconnectWatcher.promise]),
        attemptTimeoutMs,
        () =>
          isStopMessageFlow
            ? createStopMessageFetchFailedError({
                requestId: options.requestId,
                reason: 'stage_timeout',
                elapsedMs: elapsedBeforeAttempt,
                timeoutMs: STOP_MESSAGE_STAGE_TIMEOUT_MS,
                attempt,
                maxAttempts
              })
            : createServerToolTimeoutError({
                requestId: options.requestId,
                phase: 'followup',
                timeoutMs: attemptTimeoutMs,
                flowId: engineResult.execution.flowId,
                attempt,
                maxAttempts
              })
      );
      disconnectWatcher.cancel();
      // Treat empty followup as failure for auto followup flows:
      // - retry once (maxAttempts=2)
      // - if still empty, surface as HTTP error so client can retry.
      if (retryEmptyFollowupOnce) {
        const body =
          followup && followup.body && typeof followup.body === 'object'
            ? (followup.body as JsonObject)
            : undefined;
        if (body && isEmptyClientResponsePayload(body)) {
          followup = undefined;
          lastError = new Error('SERVERTOOL_EMPTY_FOLLOWUP');
          if (attempt < maxAttempts) {
            continue;
          }
        }
      }
      lastError = undefined;
      break;
    } catch (error) {
      disconnectWatcher.cancel();
      if (isServerToolClientDisconnectedError(error) || isAdapterClientDisconnected(options.adapterContext)) {
        logProgress(5, totalSteps, 'completed (client disconnected)', { flowId, attempt });
        return {
          chat: engineResult.finalChatResponse,
          executed: true,
          flowId: engineResult.execution.flowId
        };
      }
      if (isServerToolTimeoutError(error)) {
        throw error;
      }
      lastError = error;
      if (attempt >= maxAttempts) {
        if (isStopMessageFlow) {
          disableStopMessageAfterFailedFollowup(options.adapterContext, stopMessageReservation);
          logProgress(5, totalSteps, 'failed (stopMessage followup failed; state cleared)', { flowId, attempt });
          throw error;
        }
        const wrapped = new ProviderProtocolError(
          `[servertool] Followup failed for flow ${engineResult.execution.flowId ?? 'unknown'} ` +
            `(attempt ${attempt}/${maxAttempts})`,
          {
            code: 'SERVERTOOL_FOLLOWUP_FAILED',
            details: {
              flowId: engineResult.execution.flowId,
              requestId: options.requestId,
              attempt,
              maxAttempts,
              error: error instanceof Error ? error.message : String(error ?? 'unknown')
            }
          }
        );
        (wrapped as { cause?: unknown }).cause = error;
        throw wrapped;
      }
    }
  }


  const followupBody =
    followup && followup.body && typeof followup.body === 'object'
      ? (followup.body as JsonObject)
      : undefined;
  if (retryEmptyFollowupOnce && (!followupBody || isEmptyClientResponsePayload(followupBody))) {
    if (isStopMessageFlow) {
      disableStopMessageAfterFailedFollowup(options.adapterContext, stopMessageReservation);
      logProgress(5, totalSteps, 'failed (stopMessage followup empty; state cleared)', { flowId });
      throw createEmptyFollowupError({
        flowId: engineResult.execution.flowId,
        requestId: options.requestId,
        lastError,
        originalResponseWasEmpty: true
      });
    }
    throw createEmptyFollowupError({
      flowId: engineResult.execution.flowId,
      requestId: options.requestId,
      lastError
    });
  }

  // Special case: Antigravity thoughtSignature bootstrap flow.
  // - First followup performs a minimal preflight (forces clock.get) to obtain a fresh signature.
  // - If preflight succeeds, immediately replay the original captured request as a second internal hop,
  //   so the client sees a single recovered response (transparent).
  if (engineResult.execution.flowId === 'antigravity_thought_signature_bootstrap' && options.reenterPipeline) {
    const preflight = followupBody;
    const preflightError = preflight && typeof (preflight as any).error === 'object' ? (preflight as any).error : null;
    const preflightStatus = (() => {
      if (!preflightError || typeof preflightError !== 'object' || Array.isArray(preflightError)) return undefined;
      const statusRaw = (preflightError as any).status ?? (preflightError as any).statusCode;
      if (typeof statusRaw === 'number' && Number.isFinite(statusRaw)) return Math.floor(statusRaw);
      const codeRaw = (preflightError as any).code;
      const code = typeof codeRaw === 'string' ? codeRaw.trim() : typeof codeRaw === 'number' ? String(codeRaw) : '';
      if (code && /^HTTP_\d{3}$/i.test(code)) return Number(code.split('_')[1]);
      if (code && /^\d{3}$/.test(code)) return Number(code);
      return undefined;
    })();

    // One-shot guard: if preflight still looks rate-limited / invalid, stop and return the original error.
    if (preflightError && (preflightStatus === 429 || preflightStatus === 400)) {
      const decorated = decorateFinalChatWithServerToolContext(engineResult.finalChatResponse, engineResult.execution);
      logProgress(5, totalSteps, 'completed (bootstrap preflight failed)', { flowId });
      return { chat: decorated, executed: true, flowId: engineResult.execution.flowId };
    }

    const replaySeed = extractCapturedChatSeed((options.adapterContext as any)?.capturedChatRequest);
    if (replaySeed) {
      const replayPayload: JsonObject = {
        ...(replaySeed.model ? { model: replaySeed.model } : {}),
        messages: Array.isArray(replaySeed.messages) ? (replaySeed.messages as JsonObject[]) : [],
        ...(Array.isArray(replaySeed.tools) ? { tools: replaySeed.tools as JsonObject[] } : {}),
        ...(replaySeed.parameters && typeof replaySeed.parameters === 'object' && !Array.isArray(replaySeed.parameters)
          ? { parameters: replaySeed.parameters as any }
          : {})
      };

      const replayLoopState = buildServerToolLoopState(
        options.adapterContext,
        engineResult.execution.flowId,
        replayPayload
      );
      const replayMetadata: JsonObject = { stream: false };
      const replayRt = ensureRuntimeMetadata(replayMetadata as unknown as Record<string, unknown>);
      (replayRt as any).serverToolFollowup = true;
      if (replayLoopState) {
        (replayRt as any).serverToolLoopState = replayLoopState;
      }
      (replayMetadata as any).__hubEntry = 'chat_process';
      (replayRt as any).preserveRouteHint = false;
      (replayRt as any).disableStickyRoutes = true;
      (replayRt as any).serverToolOriginalEntryEndpoint =
        (typeof options.entryEndpoint === 'string' && options.entryEndpoint.trim().length
          ? options.entryEndpoint
          : followupEntryEndpoint) as any;

      const forcedProviderKeyRaw = (options.adapterContext as any)?.providerKey;
      const forcedProviderKey =
        typeof forcedProviderKeyRaw === 'string' && forcedProviderKeyRaw.trim().length ? forcedProviderKeyRaw.trim() : '';
      if (forcedProviderKey) {
        (replayMetadata as any).__shadowCompareForcedProviderKey = forcedProviderKey;
      }

      const replayRequestId = buildFollowupRequestId(options.requestId, ':antigravity_ts_replay');
      const replayPayloadFinal = applyHubFollowupPolicyShadow({
        requestId: replayRequestId,
        entryEndpoint: followupEntryEndpoint,
        flowId: engineResult.execution.flowId,
        payload: coerceFollowupPayloadStream(replayPayload, false),
        stageRecorder: options.stageRecorder
      });

      const replayResult = await withTimeout(
        options.reenterPipeline({
          entryEndpoint: followupEntryEndpoint,
          requestId: replayRequestId,
          body: replayPayloadFinal,
          metadata: replayMetadata
        }),
        followupTimeoutMs,
        () =>
          createServerToolTimeoutError({
            requestId: options.requestId,
            phase: 'followup',
            timeoutMs: followupTimeoutMs,
            flowId: engineResult.execution.flowId
          })
      );

      const replayBody =
        replayResult && replayResult.body && typeof replayResult.body === 'object'
          ? (replayResult.body as JsonObject)
          : undefined;
      const decorated = decorateFinalChatWithServerToolContext(
        replayBody ?? preflight ?? engineResult.finalChatResponse,
        engineResult.execution
      );
      logProgress(5, totalSteps, 'completed (bootstrap replay)', { flowId });
      return { chat: decorated, executed: true, flowId: engineResult.execution.flowId };
    }
  }

  const decorated = decorateFinalChatWithServerToolContext(
    followupBody ?? engineResult.finalChatResponse,
    engineResult.execution
  );

  logProgress(5, totalSteps, 'completed', { flowId });
  return {
    chat: decorated,
    executed: true,
    flowId: engineResult.execution.flowId
  };
}

type StopMessageUsageReservation = {
  stickyKey: string;
  previousState: RoutingInstructionState | null;
};

function disableStopMessageAfterFailedFollowup(
  adapterContext: AdapterContext,
  reservation: StopMessageUsageReservation | null
): void {
  try {
    const key =
      reservation && typeof reservation.stickyKey === 'string' && reservation.stickyKey.trim()
        ? reservation.stickyKey.trim()
        : resolveStickyKeyFromAdapterContext(adapterContext);
    if (!key) {
      return;
    }
    const state = loadRoutingInstructionStateSync(key);
    if (!state) {
      return;
    }
    const now = Date.now();
    state.stopMessageText = undefined;
    state.stopMessageMaxRepeats = undefined;
    state.stopMessageUsed = undefined;
    state.stopMessageSource = undefined;
    state.stopMessageUpdatedAt = now;
    state.stopMessageLastUsedAt = now;
    (state as RoutingInstructionState).stopMessageAiSeedPrompt = undefined;
    (state as RoutingInstructionState).stopMessageAiHistory = undefined;
    saveRoutingInstructionStateSync(key, state);
  } catch {
    // best-effort: do not crash the request due to state cleanup failures
  }
}

function resolveStickyKeyFromAdapterContext(adapterContext: AdapterContext): string | undefined {
  if (!adapterContext || typeof adapterContext !== 'object') {
    return undefined;
  }
  const record = adapterContext as Record<string, unknown>;
  const runtime = readRuntimeMetadata(record) as Record<string, unknown> | undefined;
  const explicitScope =
    readTextFromAny((runtime as Record<string, unknown> | undefined)?.stopMessageClientInjectSessionScope) ||
    readTextFromAny((runtime as Record<string, unknown> | undefined)?.stopMessageClientInjectScope) ||
    readTextFromAny(record.stopMessageClientInjectSessionScope) ||
    readTextFromAny(record.stopMessageClientInjectScope);
  if (
    explicitScope &&
    (explicitScope.startsWith('tmux:') || explicitScope.startsWith('session:') || explicitScope.startsWith('conversation:'))
  ) {
    return explicitScope;
  }
  const metadata = asRecord(record.metadata);
  const tmuxSessionId =
    readTextFromAny(record.clientTmuxSessionId) ||
    readTextFromAny(record.client_tmux_session_id) ||
    readTextFromAny(record.tmuxSessionId) ||
    readTextFromAny(record.tmux_session_id) ||
    readTextFromAny(runtime?.clientTmuxSessionId) ||
    readTextFromAny(runtime?.client_tmux_session_id) ||
    readTextFromAny(runtime?.tmuxSessionId) ||
    readTextFromAny(runtime?.tmux_session_id) ||
    readTextFromAny(metadata?.clientTmuxSessionId) ||
    readTextFromAny(metadata?.client_tmux_session_id) ||
    readTextFromAny(metadata?.tmuxSessionId) ||
    readTextFromAny(metadata?.tmux_session_id);
  if (!tmuxSessionId) {
    const sessionId =
      readTextFromAny(record.sessionId) ||
      readTextFromAny(record.session_id) ||
      readTextFromAny(runtime?.sessionId) ||
      readTextFromAny(runtime?.session_id) ||
      readTextFromAny(metadata?.sessionId) ||
      readTextFromAny(metadata?.session_id);
    if (sessionId) {
      return `session:${sessionId}`;
    }
    const conversationId =
      readTextFromAny(record.conversationId) ||
      readTextFromAny(record.conversation_id) ||
      readTextFromAny(runtime?.conversationId) ||
      readTextFromAny(runtime?.conversation_id) ||
      readTextFromAny(metadata?.conversationId) ||
      readTextFromAny(metadata?.conversation_id);
    if (conversationId) {
      return `conversation:${conversationId}`;
    }
    return undefined;
  }
  return `tmux:${tmuxSessionId}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readTextFromAny(value: unknown): string {
  return typeof value === 'string' && value.trim().length ? value.trim() : '';
}

function cloneRoutingInstructionState(state: RoutingInstructionState | null): RoutingInstructionState | null {
  if (!state) {
    return null;
  }
  try {
    const serialized = serializeRoutingInstructionState(state);
    return deserializeRoutingInstructionState(serialized);
  } catch {
    return null;
  }
}

function resolveStopMessageSnapshot(raw: unknown): {
  text: string;
  maxRepeats: number;
  used: number;
  source?: string;
  updatedAt?: number;
  lastUsedAt?: number;
} | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const text = typeof record.stopMessageText === 'string' ? record.stopMessageText.trim() : '';
  const maxRepeats =
    typeof record.stopMessageMaxRepeats === 'number' && Number.isFinite(record.stopMessageMaxRepeats)
      ? Math.max(1, Math.floor(record.stopMessageMaxRepeats))
      : 0;
  if (!text || maxRepeats <= 0) {
    return null;
  }
  const used =
    typeof record.stopMessageUsed === 'number' && Number.isFinite(record.stopMessageUsed)
      ? Math.max(0, Math.floor(record.stopMessageUsed))
      : 0;
  const updatedAt =
    typeof record.stopMessageUpdatedAt === 'number' && Number.isFinite(record.stopMessageUpdatedAt)
      ? record.stopMessageUpdatedAt
      : undefined;
  const lastUsedAt =
    typeof record.stopMessageLastUsedAt === 'number' && Number.isFinite(record.stopMessageLastUsedAt)
      ? record.stopMessageLastUsedAt
      : undefined;
  const source =
    typeof (record as { stopMessageSource?: unknown }).stopMessageSource === 'string' &&
    (record as { stopMessageSource: string }).stopMessageSource.trim()
      ? (record as { stopMessageSource: string }).stopMessageSource.trim()
      : undefined;
  return {
    text,
    maxRepeats,
    used,
    ...(source ? { source } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(lastUsedAt ? { lastUsedAt } : {})
  };
}

function createStopMessageState(snapshot: {
  text: string;
  maxRepeats: number;
  used: number;
  source?: string;
  updatedAt?: number;
  lastUsedAt?: number;
}): {
  forcedTarget?: unknown;
  stickyTarget?: unknown;
  allowedProviders: Set<string>;
  disabledProviders: Set<string>;
  disabledKeys: Map<string, Set<string | number>>;
  disabledModels: Map<string, Set<string>>;
  stopMessageSource?: string;
  stopMessageText?: string;
  stopMessageMaxRepeats?: number;
  stopMessageUsed?: number;
  stopMessageUpdatedAt?: number;
  stopMessageLastUsedAt?: number;
} {
  return {
    forcedTarget: undefined,
    stickyTarget: undefined,
    allowedProviders: new Set<string>(),
    disabledProviders: new Set<string>(),
    disabledKeys: new Map<string, Set<string | number>>(),
    disabledModels: new Map<string, Set<string>>(),
    stopMessageSource: snapshot.source && snapshot.source.trim() ? snapshot.source.trim() : 'explicit',
    stopMessageText: snapshot.text,
    stopMessageMaxRepeats: snapshot.maxRepeats,
    stopMessageUsed: snapshot.used,
    stopMessageUpdatedAt: snapshot.updatedAt,
    stopMessageLastUsedAt: snapshot.lastUsedAt
  };
}

function decorateFinalChatWithServerToolContext(
  chat: JsonObject,
  execution: { flowId: string; context?: JsonObject } | undefined
): JsonObject {
  if (!execution || !execution.context) {
    return chat;
  }

  // Handle continue_execution_flow: append visible summary to client response
  if (execution.flowId === 'continue_execution_flow') {
    const ctx = execution.context as { continue_execution?: { visibleSummary?: unknown } };
    const ce = ctx.continue_execution;
    const visibleSummary =
      ce && typeof ce.visibleSummary === 'string' && ce.visibleSummary.trim().length
        ? ce.visibleSummary.trim()
        : '';
    if (!visibleSummary) {
      return chat;
    }

    const cloned = JSON.parse(JSON.stringify(chat)) as JsonObject;
    const choices = Array.isArray((cloned as any).choices) ? (cloned as any).choices : [];
    if (!choices.length) {
      return cloned;
    }
    const first = choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>) : null;
    if (!first || !first.message || typeof first.message !== 'object') {
      return cloned;
    }
    const message = first.message as { [key: string]: unknown };
    const baseContent = typeof message.content === 'string' ? message.content : '';

    // Prepend visible summary to the content
    message.content =
      baseContent && baseContent.trim().length
        ? `${visibleSummary}\n\n${baseContent}`
        : visibleSummary;

    // Force finish_reason to 'stop' for continue_execution flow
    first.finish_reason = 'stop';

    return cloned;
  }

  // Handle web_search_flow: append original text summary
  if (execution.flowId !== 'web_search_flow') {
    return chat;
  }

  const ctx = execution.context as { web_search?: { engineId?: unknown; providerKey?: unknown; summary?: unknown } };
  const web = ctx.web_search;
  const summary =
    web && typeof web.summary === 'string' && web.summary.trim().length
      ? web.summary.trim()
      : '';
  if (!summary) {
    return chat;
  }
  const engineId =
    web && typeof web.engineId === 'string' && web.engineId.trim().length
      ? web.engineId.trim()
      : undefined;

  const label = engineId
    ? `【web_search 原文 | engine: ${engineId}】`
    : '【web_search 原文】';

  const cloned = JSON.parse(JSON.stringify(chat)) as JsonObject;
  const choices = Array.isArray((cloned as any).choices) ? (cloned as any).choices : [];
  if (!choices.length) {
    return cloned;
  }
  const first = choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>) : null;
  if (!first || !first.message || typeof first.message !== 'object') {
    return cloned;
  }
  const message = first.message as { [key: string]: unknown };
  const baseContent = typeof message.content === 'string' ? message.content : '';
  const suffix = `${label}\n${summary}`;

  message.content =
    baseContent && baseContent.trim().length
      ? `${baseContent}\n\n${suffix}`
      : suffix;

  return cloned;
}

function resolveRouteHint(adapterContext: AdapterContext, flowId?: string): string | undefined {
  const rawRoute = (adapterContext as unknown as { routeId?: unknown }).routeId;
  const routeId = typeof rawRoute === 'string' && rawRoute.trim() ? rawRoute.trim() : '';
  if (!routeId) {
    return undefined;
  }
  if (routeId.toLowerCase() === 'default') {
    return undefined;
  }
  if (flowId && routeId.toLowerCase() === flowId.toLowerCase()) {
    return undefined;
  }
  return routeId;
}

function buildServerToolLoopState(
  adapterContext: AdapterContext,
  flowId: string | undefined,
  payload: JsonObject,
  response?: JsonObject
): ServerToolLoopState | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const trackPayload =
    typeof flowId === 'string' && flowId.trim() && flowId !== 'stop_message_flow';
  const payloadHash = trackPayload ? hashPayload(payload) : '__servertool_auto__';
  if (!payloadHash) {
    return null;
  }
  const previous = readServerToolLoopState(adapterContext);
  const sameFlow = previous && previous.flowId === flowId;
  const samePayload = !trackPayload || (previous && previous.payloadHash === payloadHash);
  const prevCount =
    previous && typeof previous.repeatCount === 'number' && Number.isFinite(previous.repeatCount)
      ? Math.max(0, Math.floor(previous.repeatCount))
      : 0;
  const repeatCount = sameFlow && samePayload ? prevCount + 1 : 1;

  const previousStartedAtMs =
    sameFlow && previous && typeof previous.startedAtMs === 'number' && Number.isFinite(previous.startedAtMs)
      ? Math.max(0, Math.floor(previous.startedAtMs))
      : undefined;
  const startedAtMs = previousStartedAtMs ?? Date.now();

  const base: ServerToolLoopState = {
    ...(flowId ? { flowId } : {}),
    payloadHash,
    repeatCount,
    startedAtMs
  };

  if (flowId === 'stop_message_flow') {
    const pairHash = hashStopMessageRequestResponsePair(payload, response);
    if (pairHash) {
      const previousPairHash =
        sameFlow && previous && typeof previous.stopPairHash === 'string' ? previous.stopPairHash : undefined;
      const previousPairCount =
        sameFlow && previous && typeof previous.stopPairRepeatCount === 'number' && Number.isFinite(previous.stopPairRepeatCount)
          ? Math.max(0, Math.floor(previous.stopPairRepeatCount))
          : 0;
      const stopPairRepeatCount = previousPairHash === pairHash ? previousPairCount + 1 : 1;
      const stopPairWarned =
        previousPairHash === pairHash && previous && typeof previous.stopPairWarned === 'boolean'
          ? previous.stopPairWarned
          : false;
      base.stopPairHash = pairHash;
      base.stopPairRepeatCount = stopPairRepeatCount;
      base.stopPairWarned = stopPairWarned;
    }
  }

  return base;
}

function resolveCapturedChatRequest(adapterContext: AdapterContext): JsonObject | null {
  if (!adapterContext || typeof adapterContext !== 'object') {
    return null;
  }
  const record = adapterContext as Record<string, unknown>;
  const direct = record.capturedChatRequest;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as JsonObject;
  }
  return null;
}

function buildStopMessageLoopPayload(adapterContext: AdapterContext): JsonObject | null {
  const captured = resolveCapturedChatRequest(adapterContext);
  const seed = extractCapturedChatSeed(captured);
  if (!seed || !Array.isArray(seed.messages) || seed.messages.length === 0) {
    return null;
  }
  const payload: JsonObject = {
    messages: seed.messages
  };
  if (seed.model) {
    payload.model = seed.model;
  }
  if (Array.isArray(seed.tools) && seed.tools.length > 0) {
    payload.tools = seed.tools;
  }
  if (seed.parameters && typeof seed.parameters === 'object' && !Array.isArray(seed.parameters)) {
    payload.parameters = seed.parameters as JsonObject;
  }
  return payload;
}

function readServerToolLoopState(adapterContext: AdapterContext): ServerToolLoopState | null {
  if (!adapterContext || typeof adapterContext !== 'object') {
    return null;
  }
  const rt = readRuntimeMetadata(adapterContext as unknown as Record<string, unknown>);
  const raw = (rt as any)?.serverToolLoopState;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const flowId = typeof record.flowId === 'string' ? record.flowId.trim() : undefined;
  const payloadHash = typeof record.payloadHash === 'string' ? record.payloadHash.trim() : undefined;
  const repeatCount =
    typeof record.repeatCount === 'number' && Number.isFinite(record.repeatCount)
      ? Math.max(0, Math.floor(record.repeatCount))
      : undefined;
  const startedAtMs =
    typeof record.startedAtMs === 'number' && Number.isFinite(record.startedAtMs)
      ? Math.max(0, Math.floor(record.startedAtMs))
      : undefined;
  const stopPairHash =
    typeof record.stopPairHash === 'string' && record.stopPairHash.trim().length
      ? record.stopPairHash.trim()
      : undefined;
  const stopPairRepeatCount =
    typeof record.stopPairRepeatCount === 'number' && Number.isFinite(record.stopPairRepeatCount)
      ? Math.max(0, Math.floor(record.stopPairRepeatCount))
      : undefined;
  const stopPairWarned = typeof record.stopPairWarned === 'boolean' ? record.stopPairWarned : undefined;
  if (!payloadHash) {
    return null;
  }
  return {
    ...(flowId ? { flowId } : {}),
    payloadHash,
    ...(repeatCount !== undefined ? { repeatCount } : {}),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    ...(stopPairHash ? { stopPairHash } : {}),
    ...(stopPairRepeatCount !== undefined ? { stopPairRepeatCount } : {}),
    ...(stopPairWarned !== undefined ? { stopPairWarned } : {})
  };
}

function hashPayload(payload: JsonObject): string | null {
  try {
    const stable = stableStringify(payload);
    return createHash('sha1').update(stable).digest('hex');
  } catch {
    return null;
  }
}

function hashStopMessageRequestResponsePair(payload: JsonObject, response?: JsonObject): string | null {
  try {
    const normalizedPayload = sanitizeLoopHashValue(payload);
    const normalizedResponse = sanitizeLoopHashValue(response ?? {});
    const stable = stableStringify({ request: normalizedPayload, response: normalizedResponse });
    return createHash('sha1').update(stable).digest('hex');
  } catch {
    return null;
  }
}

function sanitizeLoopHashValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeLoopHashValue(entry));
  }
  if (typeof value !== 'object') {
    return value;
  }
  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  const volatileKeys = new Set([
    'id',
    'created',
    'created_at',
    'timestamp',
    'request_id',
    'requestId',
    'trace_id',
    'response_id',
    'system_fingerprint'
  ]);
  for (const key of Object.keys(record)) {
    if (volatileKeys.has(key)) {
      continue;
    }
    normalized[key] = sanitizeLoopHashValue(record[key]);
  }
  return normalized;
}

function appendStopMessageLoopWarning(payload: JsonObject, repeatCountRaw: number): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return;
  }
  const messages = Array.isArray((payload as { messages?: unknown }).messages)
    ? ((payload as { messages: unknown[] }).messages as unknown[])
    : null;
  if (!messages) {
    return;
  }
  const repeatCount = Number.isFinite(repeatCountRaw)
    ? Math.max(STOP_MESSAGE_LOOP_WARN_THRESHOLD, Math.floor(repeatCountRaw))
    : STOP_MESSAGE_LOOP_WARN_THRESHOLD;
  const warningText = [
    `检测到 stopMessage 请求/响应参数已连续 ${repeatCount} 轮一致。`,
    '请立即尝试跳出循环（换路径、换验证方法、或直接给结论）。',
    `若继续达到 ${STOP_MESSAGE_LOOP_FAIL_THRESHOLD} 轮一致，将返回 fetch failed 网络错误并停止自动续跑。`
  ].join('\n');
  messages.push({
    role: 'system',
    content: warningText
  });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(',')}}`;
}

function buildFollowupRequestId(baseRequestId: string, suffix?: string): string {
  const requestId = typeof baseRequestId === 'string' ? baseRequestId : '';
  const suffixText = typeof suffix === 'string' ? suffix : '';
  if (!suffixText) {
    return requestId;
  }
  if (!requestId) {
    return suffixText;
  }
  const normalized = normalizeFollowupRequestId(requestId, suffixText);
  if (!normalized) {
    return suffixText;
  }
  return normalized.endsWith(suffixText) ? normalized : `${normalized}${suffixText}`;
}

function isAdapterClientDisconnected(adapterContext: AdapterContext): boolean {
  if (!adapterContext || typeof adapterContext !== 'object') {
    return false;
  }
  const state = (adapterContext as { clientConnectionState?: unknown }).clientConnectionState;
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    const disconnected = (state as { disconnected?: unknown }).disconnected;
    if (disconnected === true) {
      return true;
    }
    if (typeof disconnected === 'string' && disconnected.trim().toLowerCase() === 'true') {
      return true;
    }
  }
  const raw = (adapterContext as { clientDisconnected?: unknown }).clientDisconnected;
  if (raw === true) {
    return true;
  }
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'true') {
    return true;
  }
  return false;
}

function normalizeFollowupRequestId(requestId: string, suffixText: string): string {
  if (!requestId) {
    return '';
  }
  const token = suffixText.startsWith(':') ? suffixText.slice(1) : suffixText;
  if (!token) {
    return requestId;
  }
  const delimiterIndex = requestId.indexOf(':');
  if (delimiterIndex === -1) {
    return requestId;
  }
  const base = requestId.slice(0, delimiterIndex);
  const rawSuffix = requestId.slice(delimiterIndex + 1);
  if (!rawSuffix) {
    return requestId;
  }
  const tokens = rawSuffix.split(':').filter((entry) => entry.length > 0 && entry !== token);
  const rebuilt = tokens.length > 0 ? `${base}:${tokens.join(':')}` : base;
  return rebuilt;
}
