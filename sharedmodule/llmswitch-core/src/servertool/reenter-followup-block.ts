import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import { ProviderProtocolError } from '../conversion/provider-protocol-error.js';

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function extractFollowupErrorEnvelope(error: unknown): {
  upstreamStatus?: number;
  upstreamCode?: string;
  reason?: string;
} {
  const errorRecord =
    error && typeof error === 'object' && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : undefined;
  const errorDetails =
    errorRecord?.details && typeof errorRecord.details === 'object' && !Array.isArray(errorRecord.details)
      ? (errorRecord.details as Record<string, unknown>)
      : undefined;
  const upstreamCode =
    readTrimmedString(errorRecord?.upstreamCode)
    ?? readTrimmedString(errorDetails?.upstreamCode)
    ?? readTrimmedString(errorRecord?.code)
    ?? readTrimmedString(errorDetails?.code);
  const upstreamStatus =
    (typeof errorRecord?.status === 'number' && Number.isFinite(errorRecord.status)
      ? Math.floor(errorRecord.status)
      : undefined)
    ?? (typeof errorRecord?.statusCode === 'number' && Number.isFinite(errorRecord.statusCode)
      ? Math.floor(errorRecord.statusCode)
      : undefined)
    ?? (typeof errorDetails?.status === 'number' && Number.isFinite(errorDetails.status)
      ? Math.floor(errorDetails.status)
      : undefined)
    ?? (typeof errorDetails?.statusCode === 'number' && Number.isFinite(errorDetails.statusCode)
      ? Math.floor(errorDetails.statusCode)
      : undefined);
  const reason =
    readTrimmedString(errorDetails?.reason)
    ?? readTrimmedString(errorRecord?.reason)
    ?? (error instanceof Error ? readTrimmedString(error.message) : undefined);
  return { upstreamStatus, upstreamCode, reason };
}

function isTerminalFollowupError(error: unknown): boolean {
  const { upstreamStatus, upstreamCode, reason } = extractFollowupErrorEnvelope(error);
  if (typeof upstreamStatus === 'number' && upstreamStatus >= 400 && upstreamStatus < 500) {
    return true;
  }
  const code = (upstreamCode || '').toLowerCase();
  if (
    code === 'bad_request'
    || code === 'provider_not_available'
    || code === 'client_disconnected'
    || code === 'client_response_closed'
    || code === 'client_request_aborted'
    || code === 'client_timeout_hint_expired'
    || code === 'client_tool_args_invalid'
  ) {
    return true;
  }
  const text = (reason || '').toLowerCase();
  if (
    text.includes('no available providers after applying routing instructions')
    || text.includes("tool_choice") && text.includes('必须提供 tools')
    || text.includes('client disconnected')
    || text.includes('client_response_closed')
    || text.includes('client_request_aborted')
    || text.includes('client_timeout_hint_expired')
  ) {
    return true;
  }
  return false;
}

export async function runReenterFollowup(args: {
  adapterContext: AdapterContext;
  requestId: string;
  flowId: string | undefined;
  followupEntryEndpoint: string;
  followupRequestId: string;
  followupPayloadRaw: JsonObject | null;
  metadata: JsonObject;
  followupTimeoutMs: number;
  maxAttempts: number;
  retryEmptyFollowupOnce: boolean;
  isStopMessageFlow: boolean;
  shouldInjectStopLoopWarning: boolean;
  stopLoopWarnThreshold: number;
  stopMessageStageTimeoutMs: number;
  loopState: {
    startedAtMs?: number;
    stopPairRepeatCount?: number;
  } | null;
  finalChatResponse: JsonObject;
  execution: { flowId: string; context?: JsonObject } | undefined;
  reenterPipeline?: (options: {
    entryEndpoint: string;
    requestId: string;
    body: JsonObject;
    metadata?: JsonObject;
  }) => Promise<{ body?: JsonObject; __sse_responses?: unknown; format?: string }>;
  coerceFollowupPayloadStream: (payload: JsonObject, stream: boolean) => JsonObject;
  appendStopMessageLoopWarning: (payload: JsonObject, repeatCountRaw: number) => void;
  applyHubFollowupPolicyShadow: (args: {
    requestId: string;
    entryEndpoint: string;
    flowId?: string;
    payload: JsonObject;
    stageRecorder?: StageRecorder;
  }) => JsonObject;
  stageRecorder?: StageRecorder;
  createClientDisconnectWatcher: (options: {
    adapterContext: AdapterContext;
    requestId: string;
    flowId?: string;
  }) => { promise: Promise<never>; cancel: () => void };
  withTimeout: <T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error) => Promise<T>;
  createServerToolTimeoutError: (options: {
    requestId: string;
    phase: 'engine' | 'followup';
    timeoutMs: number;
    flowId?: string;
    attempt?: number;
    maxAttempts?: number;
  }) => Error;
  createStopMessageFetchFailedError: (options: {
    requestId: string;
    reason: 'stage_timeout' | 'loop_limit';
    elapsedMs?: number;
    repeatCount?: number;
    timeoutMs?: number;
    attempt?: number;
    maxAttempts?: number;
  }) => Error;
  isServerToolClientDisconnectedError: (error: unknown) => boolean;
  isAdapterClientDisconnected: (adapterContext: AdapterContext) => boolean;
  disableStopMessageAfterFailedFollowup: (
    adapterContext: AdapterContext,
    reservation: { stickyKey: string; previousState: Record<string, unknown> | null } | null
  ) => void;
  stopMessageReservation: { stickyKey: string; previousState: Record<string, unknown> | null } | null;
  compactFollowupErrorReason: (value: unknown) => string | undefined;
  isEmptyClientResponsePayload: (payload: JsonObject) => boolean;
  createEmptyFollowupError: (args: {
    flowId?: string;
    requestId: string;
    lastError?: unknown;
    originalResponseWasEmpty?: boolean;
  }) => Error;
  onLogProgress: (step: number, total: number, message: string, extra?: Record<string, unknown>) => void;
}): Promise<
  | { kind: 'completed'; result: { chat: JsonObject; executed: true; flowId?: string } }
  | { kind: 'followup_body'; followupBody?: JsonObject }
> {
  if (!args.reenterPipeline) {
    const wrapped = new ProviderProtocolError('[servertool] followup requires reenter pipeline', {
      code: 'SERVERTOOL_FOLLOWUP_FAILED',
      category: 'INTERNAL_ERROR',
      details: {
        flowId: args.flowId,
        requestId: args.requestId,
        reason: 'reenter_pipeline_unavailable'
      }
    }) as ProviderProtocolError & { status?: number };
    wrapped.status = 502;
    throw wrapped;
  }

  if (!args.followupPayloadRaw) {
    const wrapped = new ProviderProtocolError('[servertool] followup payload missing unexpectedly', {
      code: 'SERVERTOOL_FOLLOWUP_FAILED',
      category: 'INTERNAL_ERROR',
      details: {
        flowId: args.flowId,
        requestId: args.requestId,
        reason: 'followup_payload_missing_after_validation'
      }
    }) as ProviderProtocolError & { status?: number };
    wrapped.status = 502;
    throw wrapped;
  }

  let followupPayload = args.coerceFollowupPayloadStream(args.followupPayloadRaw, args.metadata.stream === true);
  if (args.shouldInjectStopLoopWarning && args.loopState) {
    args.appendStopMessageLoopWarning(
      followupPayload,
      args.loopState.stopPairRepeatCount ?? args.stopLoopWarnThreshold
    );
  }
  followupPayload = args.applyHubFollowupPolicyShadow({
    requestId: args.followupRequestId,
    entryEndpoint: args.followupEntryEndpoint,
    flowId: args.flowId,
    payload: followupPayload,
    stageRecorder: args.stageRecorder
  });

  let followup:
    | { body?: JsonObject; __sse_responses?: unknown; format?: string }
    | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= args.maxAttempts; attempt += 1) {
    const elapsedBeforeAttempt =
      args.isStopMessageFlow && args.loopState && typeof args.loopState.startedAtMs === 'number' && Number.isFinite(args.loopState.startedAtMs)
        ? Math.max(0, Date.now() - args.loopState.startedAtMs)
        : 0;
    if (args.isStopMessageFlow && elapsedBeforeAttempt >= args.stopMessageStageTimeoutMs) {
      throw args.createStopMessageFetchFailedError({
        requestId: args.requestId,
        reason: 'stage_timeout',
        elapsedMs: elapsedBeforeAttempt,
        timeoutMs: args.stopMessageStageTimeoutMs,
        attempt,
        maxAttempts: args.maxAttempts
      });
    }

    const attemptTimeoutMs =
      args.isStopMessageFlow && args.stopMessageStageTimeoutMs > elapsedBeforeAttempt
        ? Math.max(1, Math.min(args.followupTimeoutMs, args.stopMessageStageTimeoutMs - elapsedBeforeAttempt))
        : args.followupTimeoutMs;

    const disconnectWatcher = args.createClientDisconnectWatcher({
      adapterContext: args.adapterContext,
      requestId: args.requestId,
      flowId: args.flowId
    });
    try {
      const followupPromise = args.reenterPipeline({
        entryEndpoint: args.followupEntryEndpoint,
        requestId: args.followupRequestId,
        body: followupPayload,
        metadata: args.metadata
      });
      followup = await args.withTimeout(
        Promise.race([followupPromise, disconnectWatcher.promise]),
        attemptTimeoutMs,
        () =>
          args.isStopMessageFlow
            ? args.createStopMessageFetchFailedError({
                requestId: args.requestId,
                reason: 'stage_timeout',
                elapsedMs: elapsedBeforeAttempt,
                timeoutMs: args.stopMessageStageTimeoutMs,
                attempt,
                maxAttempts: args.maxAttempts
              })
            : args.createServerToolTimeoutError({
                requestId: args.requestId,
                phase: 'followup',
                timeoutMs: attemptTimeoutMs,
                flowId: args.flowId,
                attempt,
                maxAttempts: args.maxAttempts
              })
      );
      disconnectWatcher.cancel();
      if (args.retryEmptyFollowupOnce) {
        const body =
          followup && followup.body && typeof followup.body === 'object'
            ? (followup.body as JsonObject)
            : undefined;
        if (body && args.isEmptyClientResponsePayload(body)) {
          followup = undefined;
          lastError = new Error('SERVERTOOL_EMPTY_FOLLOWUP');
          if (attempt < args.maxAttempts) {
            continue;
          }
        }
      }
      lastError = undefined;
      break;
    } catch (error) {
      disconnectWatcher.cancel();
      if (args.isServerToolClientDisconnectedError(error) || args.isAdapterClientDisconnected(args.adapterContext)) {
        args.onLogProgress(5, 5, 'completed (client disconnected)', { flowId: args.flowId, attempt });
        return {
          kind: 'completed',
          result: {
            chat: args.finalChatResponse,
            executed: true,
            flowId: args.flowId
          }
        };
      }
      if (isTerminalFollowupError(error)) {
        lastError = error;
        break;
      }
      if (
        error &&
        typeof error === 'object' &&
        !Array.isArray(error) &&
        (error as { code?: unknown }).code === 'SERVERTOOL_TIMEOUT'
      ) {
        throw error;
      }
      lastError = error;
      if (attempt >= args.maxAttempts) {
        if (args.isStopMessageFlow) {
          args.disableStopMessageAfterFailedFollowup(args.adapterContext, args.stopMessageReservation);
          args.onLogProgress(5, 5, 'failed (stopMessage followup failed; state cleared)', {
            flowId: args.flowId,
            attempt
          });
          throw error;
        }
        const { upstreamCode, upstreamStatus, reason } = extractFollowupErrorEnvelope(error);
        const compactReason = args.compactFollowupErrorReason(reason);
        const compactErrorMessage = args.compactFollowupErrorReason(
          error instanceof Error ? error.message : String(error ?? 'unknown')
        );
        const wrapped = new ProviderProtocolError(
          `[servertool] Followup failed for flow ${args.flowId ?? 'unknown'} (attempt ${attempt}/${args.maxAttempts})`,
          {
            code: 'SERVERTOOL_FOLLOWUP_FAILED',
            details: {
              flowId: args.flowId,
              requestId: args.requestId,
              attempt,
              maxAttempts: args.maxAttempts,
              error: compactErrorMessage ?? 'unknown',
              ...(compactReason ? { reason: compactReason } : {}),
              ...(upstreamCode ? { upstreamCode } : {})
            }
          }
        );
        if (compactReason) {
          (wrapped as ProviderProtocolError & { reason?: string }).reason = compactReason;
        }
        if (upstreamCode) {
          (wrapped as ProviderProtocolError & { upstreamCode?: string }).upstreamCode = upstreamCode;
        }
        if (typeof upstreamStatus === 'number' && upstreamStatus > 0) {
          (wrapped as ProviderProtocolError & { status?: number }).status = upstreamStatus;
        }
        (wrapped as { cause?: unknown }).cause = error;
        throw wrapped;
      }
    }
  }

  const followupBody =
    followup && followup.body && typeof followup.body === 'object'
      ? (followup.body as JsonObject)
      : undefined;
  if (args.retryEmptyFollowupOnce && (!followupBody || args.isEmptyClientResponsePayload(followupBody))) {
    if (args.isStopMessageFlow) {
      args.disableStopMessageAfterFailedFollowup(args.adapterContext, args.stopMessageReservation);
      args.onLogProgress(5, 5, 'failed (stopMessage followup empty; state cleared)', { flowId: args.flowId });
      throw args.createEmptyFollowupError({
        flowId: args.flowId,
        requestId: args.requestId,
        lastError,
        originalResponseWasEmpty: true
      });
    }
    throw args.createEmptyFollowupError({
      flowId: args.flowId,
      requestId: args.requestId,
      lastError
    });
  }

  return { kind: 'followup_body', followupBody };
}
