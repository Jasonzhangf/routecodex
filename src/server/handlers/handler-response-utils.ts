import type { Response } from 'express';
import type { PipelineExecutionResult } from './types.js';
import {
  applyHeaders,
  assertClientResponseHasNoInternalCarriers,
  logResponseNonBlockingError,
  releaseMetadataCenterForHttpResponse,
  resolveSnapshotEntryPort,
  resolveSnapshotGroupRequestId,
  shouldCaptureClientResponseSnapshotStage,
  toNodeReadable,
  type DispatchOptions,
} from './handler-response-common.js';
import { sendSsePipelineResponse } from './handler-response-sse.js';
import { formatRequestTimingSummary, logPipelineStage } from '../utils/stage-logger.js';
import { logUsageSummary } from '../runtime/http-server/executor/usage-logger.js';
import { writeServerSnapshot } from '../../utils/snapshot-writer.js';
import { resolveEffectiveRequestId } from '../utils/request-id-manager.js';
import { getSessionExecutionStateTracker } from '../runtime/http-server/session-execution-state.js';
import { registerRequestLogContext } from '../utils/request-log-color.js';
// feature_id: server.responses_response_handler_bridge_surface
import {
  buildResponsesPayloadFromChatNative,
  planResponsesJsonClientDispatchNative,
  projectResponsesClientPayloadForClientNative,
} from '../../modules/llmswitch/bridge/responses-client-projection-host.js';
import { readRuntimeRequestTruthIdentifiers } from '../runtime/http-server/metadata-center/request-truth-readers.js';
import { stripInternalKeysDeep } from '../../utils/strip-internal-keys.js';

export {
  assertClientResponseHasNoInternalCarriers,
};

function formatRequestId(value?: string): string {
  return resolveEffectiveRequestId(value);
}

type AnyRecord = Record<string, unknown>;

type ResponsesRequestContextForHttp = {
  payload: AnyRecord;
  context: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  matchedPort?: number;
  routingPolicyGroup?: string;
};

function asRecordForHttp(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readTrimmedStringForHttp(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function buildResponsesRequestLogContextForHttp(args: {
  metadata?: unknown;
  usageLogInfo?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const metadata = asRecordForHttp(args.metadata);
  const usageLogInfo = asRecordForHttp(args.usageLogInfo);
  const requestTruth = readRuntimeRequestTruthIdentifiers(metadata);
  const sessionId =
    readTrimmedStringForHttp(usageLogInfo.sessionId)
    ?? readTrimmedStringForHttp(usageLogInfo.session_id)
    ?? readTrimmedStringForHttp(metadata.sessionId)
    ?? readTrimmedStringForHttp(metadata.session_id)
    ?? requestTruth.sessionId;
  const conversationId =
    readTrimmedStringForHttp(usageLogInfo.conversationId)
    ?? readTrimmedStringForHttp(usageLogInfo.conversation_id)
    ?? readTrimmedStringForHttp(metadata.conversationId)
    ?? readTrimmedStringForHttp(metadata.conversation_id)
    ?? requestTruth.conversationId;
  return {
    logSessionColorKey: usageLogInfo.logSessionColorKey ?? metadata.logSessionColorKey,
    clientTmuxSessionId: usageLogInfo.clientTmuxSessionId ?? metadata.clientTmuxSessionId,
    client_tmux_session_id: usageLogInfo.client_tmux_session_id ?? metadata.client_tmux_session_id,
    tmuxSessionId: usageLogInfo.tmuxSessionId ?? metadata.tmuxSessionId,
    tmux_session_id: usageLogInfo.tmux_session_id ?? metadata.tmux_session_id,
    rccSessionClientTmuxSessionId:
      usageLogInfo.rccSessionClientTmuxSessionId ?? metadata.rccSessionClientTmuxSessionId,
    rcc_session_client_tmux_session_id:
      usageLogInfo.rcc_session_client_tmux_session_id ?? metadata.rcc_session_client_tmux_session_id,
    sessionId,
    session_id: sessionId,
    conversationId,
    conversation_id: conversationId,
  };
}

async function normalizeResponsesJsonBodyForHttp(args: {
  body: unknown;
  entryEndpoint?: string;
  requestLabel?: string;
}): Promise<unknown> {
  if (args.entryEndpoint !== '/v1/responses') {
    return args.body;
  }
  if (!args.body || typeof args.body !== 'object' || Array.isArray(args.body)) {
    return args.body;
  }
  const body = args.body as Record<string, unknown>;
  if (body.object !== 'chat.completion') {
    return args.body;
  }
  return buildResponsesPayloadFromChatNative(body, {
    requestId: args.requestLabel,
  });
}

async function normalizeResponsesClientPayloadForHttp(args: {
  payload: unknown;
  entryEndpoint?: string;
  requestContext?: ResponsesRequestContextForHttp;
  metadata?: Record<string, unknown>;
}): Promise<unknown> {
  if (
    args.entryEndpoint !== '/v1/responses'
    && args.entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) {
    return args.payload;
  }
  if (!args.payload || typeof args.payload !== 'object' || Array.isArray(args.payload)) {
    return args.payload;
  }
  const toolsRaw = args.requestContext?.context?.toolsRaw;
  if (!Array.isArray(toolsRaw)) {
    throw new Error('Responses client projection requires requestContext.context.toolsRaw');
  }
  return projectResponsesClientPayloadForClientNative({
    payload: args.payload,
    toolsRaw,
    metadata: args.metadata,
    context: args.requestContext
      ? {
          originalRequest: args.requestContext.payload,
          requestContext: args.requestContext.context,
        }
      : undefined,
  });
}

async function prepareResponsesJsonClientDispatchPlanForHttp(args: {
  body: unknown;
  entryEndpoint?: string;
  requestLabel?: string;
  continuationOwner?: string;
  requestContext?: ResponsesRequestContextForHttp;
  metadata?: Record<string, unknown>;
}): Promise<{
  clientBody: unknown;
  sanitizedBody: unknown;
}> {
  const dispatchPlan = planResponsesJsonClientDispatchNative({
    entryEndpoint: args.entryEndpoint,
    continuationOwner: args.continuationOwner,
    hasRequestContextToolsRaw: Array.isArray(args.requestContext?.context?.toolsRaw),
  });
  if (dispatchPlan.action === 'direct_passthrough') {
    return {
      clientBody: args.body,
      sanitizedBody: args.body,
    };
  }
  if (dispatchPlan.action !== 'project_client_payload') {
    throw new Error(
      `[responses] unsupported JSON client dispatch action: ${String(dispatchPlan.action ?? 'unknown')}`
    );
  }
  const normalizedJsonBody = await normalizeResponsesJsonBodyForHttp({
    body: args.body,
    entryEndpoint: args.entryEndpoint,
    requestLabel: args.requestLabel,
  });
  const clientBody = await normalizeResponsesClientPayloadForHttp({
    payload: normalizedJsonBody,
    entryEndpoint: args.entryEndpoint,
    requestContext: args.requestContext,
    metadata: args.metadata,
  });
  return {
    clientBody,
    sanitizedBody: stripInternalKeysDeep(clientBody),
  };
}

export async function sendPipelineResponse(
  res: Response,
  result: PipelineExecutionResult,
  requestId?: string,
  options?: DispatchOptions
): Promise<void> {
  const status = typeof result.status === 'number' ? result.status : 200;
  const body = result.body;
  const requestLabel = formatRequestId(requestId);
  const forceSSE = options?.forceSSE === true;
  const resultMetadata =
    result.metadata && typeof result.metadata === 'object' && !Array.isArray(result.metadata)
      ? (result.metadata as Record<string, unknown>)
      : undefined;
  const expectsStream = forceSSE || result.sseStream !== undefined;
  const entryEndpoint = typeof options?.entryEndpoint === 'string' && options.entryEndpoint.trim()
    ? options.entryEndpoint.trim()
    : undefined;
  const snapshotEntryPort = resolveSnapshotEntryPort({
    explicitEntryPort: options?.entryPort,
    metadata: resultMetadata,
    usageEntryPort: result.usageLogInfo?.entryPort
  });
  const snapshotGroupRequestId = resolveSnapshotGroupRequestId({
    metadata: resultMetadata
  });
  const requestLogContext = buildResponsesRequestLogContextForHttp({
    metadata: result.metadata,
    usageLogInfo: (result.usageLogInfo ?? null) as Record<string, unknown> | null
  });
  const effectiveResponsesRequestContext = options?.responsesRequestContext;
  registerRequestLogContext(requestLabel, requestLogContext);
  const responseStartedAtMs = Date.now();
  let responseCompletedLogged = false;

  const logResponseCompleted = (details?: Record<string, unknown>) => {
    if (responseCompletedLogged) {
      return;
    }
    responseCompletedLogged = true;
    const elapsedMs = Date.now() - responseStartedAtMs;
    logPipelineStage('response.completed', requestLabel, {
      elapsedMs,
      ...(details ?? {})
    });
    const usageLogInfo = result.usageLogInfo;
    if (usageLogInfo) {
      const finishReasonFromDetails =
        typeof details?.finishReason === 'string' && details.finishReason.trim()
          ? details.finishReason.trim()
          : undefined;
      const resolvedFinishReason = finishReasonFromDetails || usageLogInfo.finishReason;
      const externalLatencyStartedAtMs = usageLogInfo.externalLatencyStartedAtMs;
      const shouldUseExternalLatencyStartedAt =
        details?.mode === 'sse'
        && typeof externalLatencyStartedAtMs === 'number'
        && Number.isFinite(externalLatencyStartedAtMs)
        && externalLatencyStartedAtMs > 0;
      const externalLatencyMs =
        shouldUseExternalLatencyStartedAt
          ? Math.max(0, Date.now() - externalLatencyStartedAtMs)
          : usageLogInfo.externalLatencyMs;
      logPipelineStage('request.usage_log.start', requestLabel, {
        providerKey: usageLogInfo.providerKey
      });
      logUsageSummary(requestLabel, {
        providerKey: usageLogInfo.providerKey,
        model: usageLogInfo.model,
        requestModel: usageLogInfo.requestModel,
        providerProtocol: usageLogInfo.providerProtocol,
        routeName: usageLogInfo.routeName,
        poolId: usageLogInfo.poolId,
        entryPort: usageLogInfo.entryPort,
        finishReason: resolvedFinishReason,
        usage: usageLogInfo.usage as any,
        externalLatencyMs,
        trafficWaitMs: usageLogInfo.trafficWaitMs,
        clientInjectWaitMs: usageLogInfo.clientInjectWaitMs,
        sseDecodeMs: usageLogInfo.sseDecodeMs,
        codecDecodeMs: usageLogInfo.codecDecodeMs,
        providerDecodeTag: usageLogInfo.providerDecodeTag,
        providerAttemptCount: usageLogInfo.providerAttemptCount,
        retryCount: usageLogInfo.retryCount,
        hubStageTop: usageLogInfo.hubStageTop as any,
        latencyMs: Date.now() - usageLogInfo.requestStartedAtMs,
        timingRequestIds: usageLogInfo.timingRequestIds,
        logSessionColorKey: requestLogContext.logSessionColorKey,
        clientTmuxSessionId: requestLogContext.clientTmuxSessionId,
        client_tmux_session_id: requestLogContext.client_tmux_session_id,
        tmuxSessionId: requestLogContext.tmuxSessionId,
        tmux_session_id: requestLogContext.tmux_session_id,
        rccSessionClientTmuxSessionId: requestLogContext.rccSessionClientTmuxSessionId,
        rcc_session_client_tmux_session_id: requestLogContext.rcc_session_client_tmux_session_id,
        sessionId: requestLogContext.sessionId,
        session_id: requestLogContext.session_id,
        conversationId: requestLogContext.conversationId,
        conversation_id: requestLogContext.conversation_id,
        projectPath: usageLogInfo.projectPath,
        firstContentAtMs: usageLogInfo.firstContentAtMs,
        lastContentAtMs: usageLogInfo.lastContentAtMs,
        requestStartedAtMs: usageLogInfo.requestStartedAtMs,
        providerRequestId: usageLogInfo.providerRequestId,
        inputRequestId: usageLogInfo.inputRequestId
      });
      logPipelineStage('request.usage_log.completed', requestLabel, {
        providerKey: usageLogInfo.providerKey
      });
      formatRequestTimingSummary(requestLabel, { terminal: true });
      return;
    }
    formatRequestTimingSummary(requestLabel, { terminal: true });
  };

  logPipelineStage('response.dispatch.start', requestLabel, {
    status,
    stream: expectsStream,
    forced: forceSSE,
    entryEndpoint,
    hasResultSseStream: result.sseStream !== undefined,
    continuationOwner: result.continuationOwner,
  });

  const responseBody = body;

  const responseForDispatch =
    result.sseStream !== undefined
    && result.continuationOwner !== 'direct'
    && (entryEndpoint === '/v1/responses' || entryEndpoint === '/v1/responses.submit_tool_outputs')
      ? (() => {
        const stream = toNodeReadable(result.sseStream);
        if (!stream) {
          return result;
        }
        return {
          ...result,
          body: responseBody,
          sseStream: stream,
        };
      })()
      : {
        ...result,
        body: responseBody,
      };

  // G6: sendSsePipelineResponse now returns boolean | Error.
  // Propagate Error upward so executor catch-chain can reroute provider.
  const sseResult = await sendSsePipelineResponse({
    res,
    result: responseForDispatch,
    requestLabel,
    status,
    forceSSE,
    expectsStream,
    entryEndpoint,
    entryPort: options?.entryPort,
    snapshotGroupRequestId,
    snapshotEntryPort,
    sseTotalTimeoutMs: options?.sseTotalTimeoutMs,
    responsesRequestContext: effectiveResponsesRequestContext,
    logResponseCompleted,
  });
  if (sseResult instanceof Error) {
    throw sseResult;
  }
  if (sseResult) {
    return;
  }

  applyHeaders(res, result.headers, false);
  if (body === undefined || body === null) {
    logPipelineStage('response.json.empty', requestLabel, { status });
    if (shouldCaptureClientResponseSnapshotStage('client-response')) {
      void writeServerSnapshot({
        phase: 'client-response',
        requestId: requestLabel,
        groupRequestId: snapshotGroupRequestId,
        entryEndpoint,
        entryPort: snapshotEntryPort,
        data: { status, headers: result.headers, body: null }
      }).catch((error) => {
        logResponseNonBlockingError(`writeServerSnapshot:json_empty:${requestLabel}`, error);
      });
    }
    res.status(status).end();
    releaseMetadataCenterForHttpResponse(resultMetadata, 'json_empty_closeout');
    logPipelineStage('response.json.completed', requestLabel, { status });
    logResponseCompleted({ status, mode: 'json', empty: true });
    return;
  }

  logPipelineStage('response.json.write', requestLabel, { status });
  const jsonDispatchPlan = await prepareResponsesJsonClientDispatchPlanForHttp({
    body: responseBody,
    entryEndpoint,
    requestLabel,
    continuationOwner: result.continuationOwner,
    requestContext: effectiveResponsesRequestContext,
    metadata: resultMetadata,
  });
  const clientBody = jsonDispatchPlan.clientBody;
  assertClientResponseHasNoInternalCarriers(clientBody, requestLabel);
  const sanitized = jsonDispatchPlan.sanitizedBody;
  const jsonFinishReason = result.usageLogInfo?.finishReason;
  getSessionExecutionStateTracker().recordJsonResponseComplete(requestLabel, jsonFinishReason);
  if (shouldCaptureClientResponseSnapshotStage('client-response')) {
    void writeServerSnapshot({
      phase: 'client-response',
      requestId: requestLabel,
      groupRequestId: snapshotGroupRequestId,
      entryEndpoint,
      entryPort: snapshotEntryPort,
      data: { status, headers: result.headers, body: sanitized }
    }).catch((error) => {
      logResponseNonBlockingError(`writeServerSnapshot:json_payload:${requestLabel}`, error);
    });
  }
  assertClientResponseHasNoInternalCarriers(sanitized, requestLabel);
  res.status(status).json(sanitized);
  releaseMetadataCenterForHttpResponse(resultMetadata, 'json_closeout');
  logPipelineStage('response.json.completed', requestLabel, { status });
  logResponseCompleted({
    status,
    mode: 'json',
    ...(jsonFinishReason ? { finishReason: jsonFinishReason } : {})
  });
}
