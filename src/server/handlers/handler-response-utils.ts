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
import { deriveFinishReason } from '../utils/finish-reason.js';
import { writeServerSnapshot } from '../../utils/snapshot-writer.js';
import { resolveEffectiveRequestId } from '../utils/request-id-manager.js';
import { getSessionExecutionStateTracker } from '../runtime/http-server/session-execution-state.js';
import { registerRequestLogContext } from '../utils/request-log-color.js';
// feature_id: server.responses_response_handler_bridge_surface
import {
  buildResponsesRequestLogContextForHttp,
  clearResponsesConversationRequestIdsForHttp,
  importResponsesHandlerCoreDist,
  normalizeChatUsagePayloadForHttp,
  prepareResponsesJsonBodyForSseBridgeForHttp,
  prepareResponsesJsonClientDispatchPlanForHttp,
  prepareResponsesJsonSseDispatchPlanForHttp,
  resolveResponsesClientPayloadFinishReasonForHttp,
  resolveResponsesConversationClearReasonForHttp,
  resolveResponsesRequestContextForHttp,
  shouldDispatchResponsesSseToClientForHttp,
  shouldClearResponsesConversationOnFailureForHttp,
} from '../../modules/llmswitch/bridge/responses-response-bridge.js';

export {
  assertClientResponseHasNoInternalCarriers,
};

function formatRequestId(value?: string): string {
  return resolveEffectiveRequestId(value);
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
  const expectsStream = shouldDispatchResponsesSseToClientForHttp({
    body,
    forceSSE,
    metadata: resultMetadata,
  }) || result.sseStream !== undefined;
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
  const effectiveResponsesRequestContext = options?.responsesRequestContext ?? resolveResponsesRequestContextForHttp({
    metadata: resultMetadata,
  });
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

  const chatUsageNormalized = normalizeChatUsagePayloadForHttp(body, {
    entryEndpoint,
    usageFallback: result.usageLogInfo?.usage
  });
  if (chatUsageNormalized.normalized) {
    logPipelineStage('response.chat_usage.normalized', requestLabel, {
      source: chatUsageNormalized.source
    });
  }
  const responseBody = chatUsageNormalized.payload;

  if (
    forceSSE
    && result.sseStream === undefined
    && (entryEndpoint === '/v1/responses' || entryEndpoint === '/v1/responses.submit_tool_outputs')
    && responseBody
    && typeof responseBody === 'object'
    && !Array.isArray(responseBody)
  ) {
    const forceSseJsonDispatchPlan = await prepareResponsesJsonClientDispatchPlanForHttp({
      body: responseBody,
      entryEndpoint,
      requestLabel,
      requestContext: effectiveResponsesRequestContext,
      metadata: resultMetadata,
      resolveBridge: importResponsesHandlerCoreDist,
    });
  }

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

  const preparedResponsesJsonSseDispatch =
    forceSSE
    && result.sseStream === undefined
    && (entryEndpoint === '/v1/responses' || entryEndpoint === '/v1/responses.submit_tool_outputs')
    && responseBody
    && typeof responseBody === 'object'
    && !Array.isArray(responseBody)
      ? await (async () => {
        const responsesPayload = await prepareResponsesJsonBodyForSseBridgeForHttp({
          body: responseBody,
          entryEndpoint,
          requestLabel,
        });
        if (!responsesPayload) {
          return undefined;
        }
        const bridgePlan = await prepareResponsesJsonSseDispatchPlanForHttp({
          responsesPayload,
          entryEndpoint,
          requestLabel,
          metadata: resultMetadata,
          requestContext: effectiveResponsesRequestContext,
        });
        return {
          responsesPayload: bridgePlan.normalizedPayload,
        };
      })()
      : undefined;

  // G6: sendSsePipelineResponse now returns boolean | Error.
  // Propagate Error upward so executor catch-chain can reroute provider.
  const sseResult = await sendSsePipelineResponse({
    res,
    result: responseForDispatch,
    requestLabel,
    status,
    body: responseBody,
    forceSSE,
    expectsStream,
    entryEndpoint,
    entryPort: options?.entryPort,
    snapshotGroupRequestId,
    snapshotEntryPort,
    sseTotalTimeoutMs: options?.sseTotalTimeoutMs,
    preparedResponsesJsonSseDispatch,
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
    if (shouldClearResponsesConversationOnFailureForHttp({
      entryEndpoint,
      status,
      phase: 'json_empty',
    })) {
      await clearResponsesConversationRequestIdsForHttp({
        requestLabel,
        timingRequestIds: result.usageLogInfo?.timingRequestIds,
        reason: resolveResponsesConversationClearReasonForHttp('json_empty'),
        onNonBlockingError: logResponseNonBlockingError,
      });
    }
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
    requestContext: effectiveResponsesRequestContext,
    metadata: resultMetadata,
    resolveBridge: importResponsesHandlerCoreDist,
  });
  const clientBody = jsonDispatchPlan.clientBody;
  assertClientResponseHasNoInternalCarriers(clientBody, requestLabel);
  const sanitized = jsonDispatchPlan.sanitizedBody;
  if (shouldClearResponsesConversationOnFailureForHttp({
    entryEndpoint,
    status,
    phase: 'json',
  })) {
    await clearResponsesConversationRequestIdsForHttp({
      requestLabel,
      timingRequestIds: result.usageLogInfo?.timingRequestIds,
      responseId: undefined,
      reason: resolveResponsesConversationClearReasonForHttp('json'),
      onNonBlockingError: logResponseNonBlockingError,
    });
  }
  const jsonFinishReason = chatUsageNormalized.normalized
    ? resolveResponsesClientPayloadFinishReasonForHttp(clientBody)
    : jsonDispatchPlan.finishReason;
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
