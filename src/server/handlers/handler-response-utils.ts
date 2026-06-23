import type { Response } from 'express';
import type { PipelineExecutionResult } from './types.js';
import {
  applyHeaders,
  assertClientResponseHasNoInternalCarriers,
  logResponseNonBlockingError,
  releaseMetadataCenterForHttpResponse,
  resolveSnapshotEntryPort,
  shouldCaptureClientResponseSnapshotStage,
  toNodeReadable,
  type DispatchOptions,
} from './handler-response-common.js';
import { sendSsePipelineResponse } from './handler-response-sse.js';
import { formatRequestTimingSummary, logPipelineStage } from '../utils/stage-logger.js';
import { logUsageSummary } from '../runtime/http-server/executor/usage-logger.js';
import { stripInternalKeysDeep } from '../../utils/strip-internal-keys.js';
import { writeServerSnapshot } from '../../utils/snapshot-writer.js';
import { resolveEffectiveRequestId } from '../utils/request-id-manager.js';
import { getSessionExecutionStateTracker } from '../runtime/http-server/session-execution-state.js';
import { registerRequestLogContext } from '../utils/request-log-color.js';
// feature_id: server.responses_response_handler_bridge_surface
import {
  buildResponsesRequestLogContextForHttp,
  importResponsesHandlerCoreDist,
  normalizeChatUsagePayloadForHttp,
  prepareResponsesJsonClientDispatchPlanForHttp,
  resolveResponsesRequestContextForHttp,
  resolveResponsesClientPayloadFinishReasonForHttp,
  shouldDispatchResponsesSseToClientForHttp,
} from '../../modules/llmswitch/bridge/responses-sse-bridge.js';
import {
  attachResponsesConversationLifecycleStreamForHttp,
  clearResponsesConversationRequestIdsForHttp,
  persistResponsesConversationLifecycleForHttp,
  resolveResponsesConversationClearReasonForHttp,
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
  const requestLogContext = buildResponsesRequestLogContextForHttp({
    metadata: result.metadata,
    usageLogInfo: (result.usageLogInfo ?? null) as Record<string, unknown> | null
  });
  const effectiveResponsesRequestContext = resolveResponsesRequestContextForHttp({
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

  if (
    forceSSE
    && result.sseStream === undefined
    && (entryEndpoint === '/v1/responses' || entryEndpoint === '/v1/responses.submit_tool_outputs')
    && body
    && typeof body === 'object'
    && !Array.isArray(body)
  ) {
    const forceSseJsonDispatchPlan = await prepareResponsesJsonClientDispatchPlanForHttp({
      body,
      entryEndpoint,
      requestLabel,
      requestContext: effectiveResponsesRequestContext,
      metadata: resultMetadata,
      resolveBridge: importResponsesHandlerCoreDist,
    });
    await persistResponsesConversationLifecycleForHttp({
      entryEndpoint,
      requestLabel,
      usageLogInfo: result.usageLogInfo,
      metadata: resultMetadata,
      requestContext: effectiveResponsesRequestContext,
      body: forceSseJsonDispatchPlan.sanitizedBody,
      onTrace: (stage, details) => {
        if ((process.env.ROUTECODEX_RESPONSES_DEBUG || '').trim() !== '1') {
          return;
        }
        try {
          const suffix = details && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : '';
          console.warn(`[responses-continuation] json.force_sse.persist.${stage} request=${requestLabel}${suffix}`);
        } catch {
          console.warn(`[responses-continuation] json.force_sse.persist.${stage} request=${requestLabel}`);
        }
      },
      onNonBlockingError: logResponseNonBlockingError,
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
          sseStream: attachResponsesConversationLifecycleStreamForHttp({
            stream,
            entryEndpoint,
            requestLabel,
            usageLogInfo: result.usageLogInfo,
            metadata: resultMetadata,
            requestContext: effectiveResponsesRequestContext,
            onTrace: (stage, details) => {
              if ((process.env.ROUTECODEX_RESPONSES_DEBUG || '').trim() !== '1') {
                return;
              }
              try {
                const suffix = details && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : '';
                console.warn(`[responses-continuation] outbound_stream.${stage} request=${requestLabel}${suffix}`);
              } catch {
                console.warn(`[responses-continuation] outbound_stream.${stage} request=${requestLabel}`);
              }
            },
            onNonBlockingError: logResponseNonBlockingError,
          }),
        };
      })()
      : result;

  // G6: sendSsePipelineResponse now returns boolean | Error.
  // Propagate Error upward so executor catch-chain can reroute provider.
  const sseResult = await sendSsePipelineResponse({
    res,
    result: responseForDispatch,
    requestLabel,
    status,
    body,
    forceSSE,
    expectsStream,
    entryEndpoint,
    entryPort: options?.entryPort,
    sseTotalTimeoutMs: options?.sseTotalTimeoutMs,
    requestLogContext,
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
    body,
    entryEndpoint,
    requestLabel,
    requestContext: effectiveResponsesRequestContext,
    metadata: resultMetadata,
    resolveBridge: importResponsesHandlerCoreDist,
  });
  const usageNormalized = normalizeChatUsagePayloadForHttp(jsonDispatchPlan.clientBody, {
    entryEndpoint,
    usageFallback: result.usageLogInfo?.usage
  });
  if (usageNormalized.normalized) {
    logPipelineStage('response.chat_usage.normalized', requestLabel, {
      source: usageNormalized.source
    });
  }
  const clientBody = usageNormalized.payload;
  assertClientResponseHasNoInternalCarriers(clientBody, requestLabel);
  const sanitized = usageNormalized.normalized
    ? stripInternalKeysDeep(clientBody)
    : jsonDispatchPlan.sanitizedBody;
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
  const jsonFinishReason = usageNormalized.normalized
    ? resolveResponsesClientPayloadFinishReasonForHttp(clientBody)
    : jsonDispatchPlan.finishReason;
  await persistResponsesConversationLifecycleForHttp({
    entryEndpoint,
    requestLabel,
    usageLogInfo: result.usageLogInfo,
    metadata: resultMetadata,
    requestContext: effectiveResponsesRequestContext,
    body: sanitized,
    onTrace: (stage, details) => {
      if ((process.env.ROUTECODEX_RESPONSES_DEBUG || '').trim() !== '1') {
        return;
      }
      try {
        const suffix = details && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : '';
        console.warn(`[responses-continuation] json.persist.${stage} request=${requestLabel}${suffix}`);
      } catch {
        console.warn(`[responses-continuation] json.persist.${stage} request=${requestLabel}`);
      }
    },
    onNonBlockingError: logResponseNonBlockingError,
  });
  getSessionExecutionStateTracker().recordJsonResponseComplete(requestLabel, jsonFinishReason);
  if (shouldCaptureClientResponseSnapshotStage('client-response')) {
    void writeServerSnapshot({
      phase: 'client-response',
      requestId: requestLabel,
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
