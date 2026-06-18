import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { StageRecorder } from '../conversion/hub/format-adapters/index.js';
import { ProviderProtocolError } from '../conversion/provider-protocol-error.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeServertoolFollowupPayloadShapeWithNative } from '../native/router-hotpath/native-hub-pipeline-semantic-mappers.js';
import { planFollowupErrorEnvelopeWithNative } from '../native/router-hotpath/native-servertool-core-semantics.js';

function createClientDisconnectedFollowupError(args: { requestId: string; flowId?: string }): Error {
  return Object.assign(
    new Error(`[servertool] client disconnected during followup${args.flowId ? ` flow=${args.flowId}` : ''}`),
    {
      code: 'SERVERTOOL_CLIENT_DISCONNECTED',
      details: {
        requestId: args.requestId,
        flowId: args.flowId
      }
    }
  );
}

function sanitizeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 220) || 'unknown';
}

async function persistFollowupFailureSample(args: {
  requestId: string;
  followupRequestId: string;
  flowId?: string;
  attempt: number;
  errorMessage: string;
  payload: JsonObject;
}): Promise<void> {
  try {
    const root = path.resolve(process.cwd(), 'tmp/servertool-followup-failures');
    await fs.mkdir(root, { recursive: true });
    const name = sanitizeFileSegment(args.followupRequestId || args.requestId);
    const file = path.join(root, `${name}.json`);
    await fs.writeFile(
      file,
      `${JSON.stringify(
        {
          requestId: args.requestId,
          followupRequestId: args.followupRequestId,
          flowId: args.flowId,
          attempt: args.attempt,
          errorMessage: args.errorMessage,
          payload: args.payload
        },
        null,
        2
      )}\n`,
      'utf8'
    );
    console.error('[servertool.followup.failure.sample]', JSON.stringify({ file, requestId: args.requestId }));
  } catch {
    // non-blocking diagnostics only
  }
}

async function persistEmptyFollowupSample(args: {
  requestId: string;
  followupRequestId: string;
  flowId?: string;
  attempt: number;
  body?: JsonObject;
  payload: JsonObject;
}): Promise<void> {
  try {
    const root = path.resolve(process.cwd(), 'tmp/servertool-followup-empty');
    await fs.mkdir(root, { recursive: true });
    const name = sanitizeFileSegment(args.followupRequestId || args.requestId);
    const file = path.join(root, `${name}.attempt-${args.attempt}.json`);
    await fs.writeFile(
      file,
      `${JSON.stringify(
        {
          requestId: args.requestId,
          followupRequestId: args.followupRequestId,
          flowId: args.flowId,
          attempt: args.attempt,
          body: args.body ?? null,
          payload: args.payload
        },
        null,
        2
      )}\n`,
      'utf8'
    );
    console.error('[servertool.followup.empty.sample]', JSON.stringify({ file, requestId: args.requestId }));
  } catch {
    // non-blocking diagnostics only
  }
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
  isStopMessageFlow: boolean;
  clearStateOnFollowupFailure: boolean;
  shouldInjectStopLoopWarning: boolean;
  stopLoopWarnThreshold: number;
  loopState: {
    startedAtMs?: number;
    stopPairRepeatCount?: number;
  } | null;
  finalChatResponse: JsonObject;
  execution: { flowId: string; context?: JsonObject } | undefined;
  reenterPipeline?: (options: {
    entryEndpoint: string;
    requestId: string;
    body?: JsonObject;
    metadata?: JsonObject;
  }) => Promise<{ body?: JsonObject; sseStream?: unknown; format?: string }>;
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
    reason: 'loop_limit';
    elapsedMs?: number;
    repeatCount?: number;
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
  const resolveFollowupBodyCandidate = (
    followup: { body?: JsonObject; sseStream?: unknown; format?: string } | undefined
  ): JsonObject | undefined => {
    if (!followup || typeof followup !== 'object') {
      return undefined;
    }
    if (followup.body && typeof followup.body === 'object') {
      return followup.body as JsonObject;
    }
    return undefined;
  };
  const RED = '\u001b[31m';
  const RESET = '\u001b[0m';
  const shouldLogFollowupLifecycleStage = (stage: string): boolean => {
    if (!stage) return false;
    return (
      stage.includes('failed')
      || stage.includes('error')
      || stage.includes('retry')
      || stage.includes('empty')
      || stage === 'attempt_error'
      || stage === 'payload_normalize_failed'
    );
  };
  const lifecycle = (stage: string, extra?: Record<string, unknown>): void => {
    if (!shouldLogFollowupLifecycleStage(stage)) {
      return;
    }
    try {
      const payload = JSON.stringify({
        requestId: args.requestId,
        followupRequestId: args.followupRequestId,
        flowId: args.flowId,
        stage,
        entryEndpoint: args.followupEntryEndpoint,
        ...extra
      });
      console.error(`${RED}[servertool.followup.lifecycle]${RESET} ${payload}`);
    } catch {
      // non-blocking
    }
  };

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
  lifecycle('payload_received', {
    hasRawPayload: true,
    rawHasInput: Array.isArray((args.followupPayloadRaw as Record<string, unknown>).input),
    rawHasMessages: Array.isArray((args.followupPayloadRaw as Record<string, unknown>).messages)
  });

  let normalizedShapePayload: JsonObject;
  try {
    normalizedShapePayload = normalizeServertoolFollowupPayloadShapeWithNative(
      args.followupEntryEndpoint,
      args.followupPayloadRaw as Record<string, unknown>
    ) as JsonObject;
  } catch (error) {
    lifecycle('payload_normalize_failed', {
      reason: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
  lifecycle('payload_normalized', {
    hasNormalizedPayload: Boolean(normalizedShapePayload),
    normalizedHasInput: Array.isArray((normalizedShapePayload as Record<string, unknown> | null | undefined)?.input),
    normalizedHasMessages: Array.isArray((normalizedShapePayload as Record<string, unknown> | null | undefined)?.messages)
  });

  let followupPayload = args.coerceFollowupPayloadStream(
    normalizedShapePayload,
    args.metadata.stream === true
  );
  if (followupPayload && args.shouldInjectStopLoopWarning && args.loopState) {
    args.appendStopMessageLoopWarning(
      followupPayload,
      args.loopState.stopPairRepeatCount ?? args.stopLoopWarnThreshold
    );
  }
  if (followupPayload) {
    followupPayload = args.applyHubFollowupPolicyShadow({
      requestId: args.followupRequestId,
      entryEndpoint: args.followupEntryEndpoint,
      flowId: args.flowId,
      payload: followupPayload,
      stageRecorder: args.stageRecorder
    });
  }

  let followup:
    | { body?: JsonObject; sseStream?: unknown; format?: string }
    | undefined;
  let lastError: unknown;
  const attempt = 1;
  lifecycle('attempt_start', { attempt, maxAttempts: 1 });
  const disconnectWatcher = args.createClientDisconnectWatcher({
    adapterContext: args.adapterContext,
    requestId: args.requestId,
    flowId: args.flowId
  });
  try {
    if (args.isAdapterClientDisconnected(args.adapterContext)) {
      throw createClientDisconnectedFollowupError({ requestId: args.requestId, flowId: args.flowId });
    }
    const followupPromise = args.reenterPipeline({
      entryEndpoint: args.followupEntryEndpoint,
      requestId: args.followupRequestId,
      ...(followupPayload ? { body: followupPayload } : {}),
      metadata: args.metadata
    });
    followup = await args.withTimeout(
      Promise.race([followupPromise, disconnectWatcher.promise]),
      args.followupTimeoutMs,
      () =>
        args.createServerToolTimeoutError({
          requestId: args.requestId,
          phase: 'followup',
          timeoutMs: args.followupTimeoutMs,
          flowId: args.flowId,
          attempt,
          maxAttempts: 1
        })
    );
    disconnectWatcher.cancel();
    if (args.isAdapterClientDisconnected(args.adapterContext)) {
      throw createClientDisconnectedFollowupError({ requestId: args.requestId, flowId: args.flowId });
    }
    const attemptBodyCandidate = resolveFollowupBodyCandidate(followup);
    lifecycle('attempt_result', {
      attempt,
      hasBody: Boolean(attemptBodyCandidate),
      hasSse: Boolean(followup && (followup as Record<string, unknown>).sseStream)
    });
    if (attemptBodyCandidate && args.isEmptyClientResponsePayload(attemptBodyCandidate)) {
      void persistEmptyFollowupSample({
        requestId: args.requestId,
        followupRequestId: args.followupRequestId,
        flowId: args.flowId,
        attempt,
        body: attemptBodyCandidate,
        payload: followupPayload
      });
      followup = undefined;
      lastError = new Error('SERVERTOOL_EMPTY_FOLLOWUP');
    }
  } catch (error) {
    disconnectWatcher.cancel();
    if (
      error &&
      typeof error === 'object' &&
      !Array.isArray(error) &&
      (error as { message?: unknown }).message &&
      followupPayload
    ) {
      const msg = String((error as { message?: unknown }).message || '');
      if (msg.includes('orphan_tool_result')) {
        void persistFollowupFailureSample({
          requestId: args.requestId,
          followupRequestId: args.followupRequestId,
          flowId: args.flowId,
          attempt,
          errorMessage: msg,
          payload: followupPayload
        });
        try {
          console.error(
            '[servertool.followup.orphan.debug]',
            JSON.stringify({
              requestId: args.requestId,
              followupRequestId: args.followupRequestId,
              flowId: args.flowId,
              attempt,
              payloadModel: (followupPayload as Record<string, unknown>).model,
              hasInput: Array.isArray((followupPayload as Record<string, unknown>).input),
              hasMessages: Array.isArray((followupPayload as Record<string, unknown>).messages),
              inputSize: Array.isArray((followupPayload as Record<string, unknown>).input)
                ? ((followupPayload as Record<string, unknown>).input as unknown[]).length
                : 0,
              preview: JSON.stringify(followupPayload).slice(0, 4000)
            })
          );
        } catch {
          // best effort diagnostic only
        }
      }
    }
    lifecycle('attempt_error', {
      attempt,
      message: error instanceof Error ? error.message : String(error ?? 'unknown')
    });
    if (args.isServerToolClientDisconnectedError(error) || args.isAdapterClientDisconnected(args.adapterContext)) {
      throw error;
    }
    const followupErrorPlan = planFollowupErrorEnvelopeWithNative(error);
    if (followupErrorPlan.terminal || (
      error &&
      typeof error === 'object' &&
      !Array.isArray(error) &&
      (error as { code?: unknown }).code === 'SERVERTOOL_TIMEOUT'
    )) {
      throw error;
    }
    lastError = error;
    if (args.clearStateOnFollowupFailure) {
      args.disableStopMessageAfterFailedFollowup(args.adapterContext, args.stopMessageReservation);
      args.onLogProgress(5, 5, 'failed (stopMessage followup failed; state cleared)', {
        flowId: args.flowId,
        attempt
      });
      throw error;
    }
    const compactReason = args.compactFollowupErrorReason(followupErrorPlan.reason);
    const compactErrorMessage = args.compactFollowupErrorReason(
      error instanceof Error ? error.message : String(error ?? 'unknown')
    );
    const wrapped = new ProviderProtocolError(
      `[servertool] Followup failed for flow ${args.flowId ?? 'unknown'} (attempt ${attempt}/1)`,
      {
        code: 'SERVERTOOL_FOLLOWUP_FAILED',
        details: {
          flowId: args.flowId,
          requestId: args.requestId,
          attempt,
          maxAttempts: 1,
          error: compactErrorMessage ?? 'unknown',
          ...(compactReason ? { reason: compactReason } : {}),
          ...(followupErrorPlan.upstreamCode ? { upstreamCode: followupErrorPlan.upstreamCode } : {})
        }
      }
    );
    if (compactReason) {
      (wrapped as ProviderProtocolError & { reason?: string }).reason = compactReason;
    }
    if (followupErrorPlan.upstreamCode) {
      (wrapped as ProviderProtocolError & { upstreamCode?: string }).upstreamCode = followupErrorPlan.upstreamCode;
    }
    if (typeof followupErrorPlan.upstreamStatus === 'number' && followupErrorPlan.upstreamStatus > 0) {
      (wrapped as ProviderProtocolError & { status?: number }).status = followupErrorPlan.upstreamStatus;
    }
    (wrapped as { cause?: unknown }).cause = error;
    throw wrapped;
  }

  const followupBody = resolveFollowupBodyCandidate(followup);
  const terminalLastError = lastError && planFollowupErrorEnvelopeWithNative(lastError).terminal ? lastError : undefined;
  if (terminalLastError && !followupBody) {
    if (args.clearStateOnFollowupFailure) {
      args.disableStopMessageAfterFailedFollowup(args.adapterContext, args.stopMessageReservation);
      args.onLogProgress(5, 5, 'failed (stopMessage followup terminal error; state cleared)', {
        flowId: args.flowId
      });
    }
    throw terminalLastError;
  }
  if (!followupBody || args.isEmptyClientResponsePayload(followupBody)) {
    if (args.flowId === 'vision_flow') {
      args.onLogProgress(5, 5, 'completed (vision followup request accepted)', { flowId: args.flowId });
      return {
        kind: 'completed',
        result: {
          chat: args.finalChatResponse,
          executed: true,
          flowId: args.execution?.flowId
        }
      };
    }
    if (args.clearStateOnFollowupFailure) {
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
  lifecycle('followup_completed', {
    hasBody: Boolean(followupBody),
    isEmpty: Boolean(followupBody && args.isEmptyClientResponsePayload(followupBody))
  });
  return { kind: 'followup_body', followupBody };
}
