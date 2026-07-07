// feature_id: server.responses_handler_family
// feature_id: server.responses_request_handler_bridge_surface
// feature_id: hub.chat_process_responses_continuation
// canonical_builders: buildResponsesConversationPortScopeForHttp, buildResponsesPipelineMetadataForHttp, prepareResponsesRequestBodyForHttp
import type { Request, Response } from 'express';
import type { HandlerContext } from './types.js';
import {
  nextRequestIdentifiers,
  respondWithPipelineError,
  writeStartedSsePipelineError,
  sendPipelineResponse,
  logRequestStart,
  logRequestComplete,
  logRequestError,
  captureClientHeaders,
  buildHandlerLogMetadata,
  buildHandlerPipelineMetadata,
} from './handler-utils.js';
import {
  buildResponsesConversationPortScopeForHttp,
  buildResponsesPipelineMetadataForHttp,
  captureResponsesInboundToolHistoryErrorsampleForHttp,
  clearResponsesConversationOnHandlerFailureForHttp,
  finalizeResponsesPipelineResultForHttp,
  planResponsesHandlerStreamForHttp,
  prepareResponsesRequestBodyForHttp,
  prepareResponsesHandlerRuntimeForHttp,
} from '../../modules/llmswitch/bridge/responses-request-bridge.js';
import { MetadataCenter } from '../runtime/http-server/metadata-center/metadata-center.js';
import { writeMetadataCenterSlot } from '../runtime/http-server/metadata-center/dualwrite-api.js';
import { detectWarmupRequest } from '../utils/warmup-detector.js';
import { recordWarmupSkipEvent } from '../utils/warmup-storm-tracker.js';
import { markClientConnectionDisconnected, trackClientConnectionState } from '../utils/client-connection-state.js';
import { DEFAULT_TIMEOUTS } from '../../constants/index.js';
import { payloadContainsVideoInput, VIDEO_REQUEST_TIMEOUT_MS } from '../utils/video-request-detection.js';
import { formatUnknownError, isRecord } from '../../utils/common-utils.js';
import { writeDebugErrorDiagArtifact } from '../../debug/diag/index.js';

interface ResponsesHandlerOptions {
  entryEndpoint?: string;
  forceStream?: boolean;
  responseIdFromPath?: string;
}

type ResponsesPayload = {
  stream?: boolean;
  response_id?: string;
  type?: string;
  [key: string]: unknown;
};

function countResponsesInputItems(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const input = (payload as Record<string, unknown>).input;
  return Array.isArray(input) ? input.length : undefined;
}

function accumulateResponsesTextChars(value: unknown): number {
  if (typeof value === 'string') {
    return value.length;
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + accumulateResponsesTextChars(item), 0);
  }
  if (!value || typeof value !== 'object') {
    return 0;
  }
  let total = 0;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      key === 'text'
      || key === 'input_text'
      || key === 'output_text'
      || key === 'content'
      || key === 'arguments'
      || key === 'output'
      || key === 'summary'
    ) {
      total += accumulateResponsesTextChars(child);
    }
  }
  return total;
}

function summarizeResponsesInputShape(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const input = record.input;
  const shape: Record<string, unknown> = {
    inputKind: Array.isArray(input) ? 'array' : typeof input,
    hasPreviousResponseId: typeof record.previous_response_id === 'string' && record.previous_response_id.trim().length > 0,
  };
  if (!Array.isArray(input)) {
    return shape;
  }
  const typeCounts: Record<string, number> = {};
  const roleCounts: Record<string, number> = {};
  let estimatedTextChars = 0;
  for (const item of input) {
    const itemRecord = item && typeof item === 'object' && !Array.isArray(item)
      ? item as Record<string, unknown>
      : undefined;
    const itemType = itemRecord && typeof itemRecord.type === 'string'
      ? itemRecord.type
      : typeof item;
    typeCounts[itemType] = (typeCounts[itemType] || 0) + 1;
    const role = itemRecord?.role;
    if (typeof role === 'string' && role.trim()) {
      roleCounts[role.trim()] = (roleCounts[role.trim()] || 0) + 1;
    }
    estimatedTextChars += accumulateResponsesTextChars(item);
  }
  return {
    ...shape,
    count: input.length,
    typeCounts,
    ...(Object.keys(roleCounts).length > 0 ? { roleCounts } : {}),
    estimatedTextChars,
  };
}

function readNumericMetaField(meta: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = meta?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readClientMetadata(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const raw = payload?.client_metadata ?? payload?.clientMetadata;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  return raw as Record<string, unknown>;
}

function logResponsesHandlerNonBlockingError(stage: string, error: unknown, details?: Record<string, unknown>): void {
  try {
    const detailSuffix = details && Object.keys(details).length
      ? ` details=${JSON.stringify(details)}`
      : '';
    console.warn(`[responses-handler] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

export async function handleResponses(
  req: Request,
  res: Response,
  ctx: HandlerContext,
  options: ResponsesHandlerOptions = {}
): Promise<void> {
  const entryEndpoint = options.entryEndpoint || '/v1/responses';
  const initialBody = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : undefined;
  const initialModel =
    typeof initialBody?.model === 'string' && initialBody.model.trim()
      ? initialBody.model.trim()
      : 'request';
  // Some client endpoints are "synthetic" entrypoints used only for Hub/Pipeline semantics
  // (e.g. submit_tool_outputs). We may rewrite the pipeline entryEndpoint after preprocessing.
  let pipelineEntryEndpoint = entryEndpoint;
  const { clientRequestId, providerRequestId } = nextRequestIdentifiers(req.headers['x-request-id'], {
    entryEndpoint,
    providerId: 'router',
    model: initialModel
  });
  const requestId = providerRequestId;
  const rawTimeout = String(
    process.env.ROUTECODEX_HTTP_RESPONSES_TIMEOUT_MS ||
      process.env.RCC_HTTP_RESPONSES_TIMEOUT_MS ||
      ''
  ).trim();
  const parsedTimeout = Number(rawTimeout);
  const configuredRequestTimeoutMs =
    rawTimeout === ''
      ? DEFAULT_TIMEOUTS.HTTP_SSE_TOTAL_MS
      : (Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : undefined);
  let requestTimeoutMs = configuredRequestTimeoutMs;
  let isVideoRequest = false;
  let timedOut = false;
  let isSubmitToolOutputs = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const clearTimeoutHandle = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
  };
  let requestStartLogged = false;
  const emitRequestStart = (meta: Record<string, unknown> | undefined): void => {
    if (requestStartLogged) {
      return;
    }
    requestStartLogged = true;
    logRequestStart(entryEndpoint, requestId, meta);
  };

  try {
    let payload = (req.body && typeof req.body === 'object'
      ? req.body
      : {}) as ResponsesPayload;
    const clientHeaders = captureClientHeaders(req.headers);
    const clientConnectionState = trackClientConnectionState(req, res);
    const acceptsSse = typeof req.headers['accept'] === 'string'
      && (req.headers['accept'] as string).includes('text/event-stream');
    const responsesConversationPortScope = buildResponsesConversationPortScopeForHttp(ctx.portContext);
    const rawInputItems = countResponsesInputItems(payload);
    const clientMetadata = readClientMetadata(payload as Record<string, unknown>);
    const preRuntimeLogMetadata = buildHandlerLogMetadata({
      entryEndpoint,
      headers: req.headers as Record<string, unknown>,
      clientMetadata,
      clientHeaders,
      portContext: ctx.portContext
    });
    const preparedRuntime = await prepareResponsesHandlerRuntimeForHttp({
        payload: payload as Record<string, unknown>,
        entryEndpoint,
        responseIdFromPath: options.responseIdFromPath,
        requestId,
        requestMetadata: {
          ...preRuntimeLogMetadata,
          clientHeaders,
        },
        portScope: responsesConversationPortScope,
        forceStream: options.forceStream,
        acceptsSse,
        requestTimeoutMs,
      });
    const requestBodyMetadata = preparedRuntime.requestBodyMetadata;
    const requestStartLogMetadata = buildHandlerLogMetadata({
      entryEndpoint,
      headers: req.headers as Record<string, unknown>,
      requestBodyMetadata,
      clientMetadata,
      clientHeaders,
      portContext: ctx.portContext,
      metadata: preRuntimeLogMetadata
    });
    emitRequestStart({
      clientRequestId,
      ...(requestBodyMetadata ?? {}),
      ...requestStartLogMetadata,
      ...preparedRuntime.streamPlan.requestStartMeta,
      rawInputItems,
      rawInputShape: summarizeResponsesInputShape(payload),
      preparedInputItems: preparedRuntime.kind === 'ok'
        ? countResponsesInputItems(preparedRuntime.payload)
        : undefined,
      preparedInputShape: preparedRuntime.kind === 'ok'
        ? summarizeResponsesInputShape(preparedRuntime.payload)
        : undefined,
      plannedEntryMode: preparedRuntime.kind === 'ok'
        ? preparedRuntime.plannedEntryMode
        : undefined,
      resumeFullInputItems: preparedRuntime.kind === 'ok'
        ? readNumericMetaField(preparedRuntime.resumeMeta, 'fullInputItems')
        : undefined,
      resumeDeltaInputItems: preparedRuntime.kind === 'ok'
        ? readNumericMetaField(preparedRuntime.resumeMeta, 'deltaInputItems')
          ?? readNumericMetaField(preparedRuntime.resumeMeta, 'continuationDeltaItems')
        : undefined,
    });
    if (!ctx.executePipeline) {
      res.status(503).json({ error: { message: 'Hub pipeline runtime not initialized' , code: 'not_ready' } });
      return;
    }
    if (preparedRuntime.kind === 'client_error') {
      res.status(preparedRuntime.status).json(preparedRuntime.body);
      return;
    }
    let resumeMeta: Record<string, unknown> | undefined;
    payload = preparedRuntime.payload as ResponsesPayload;
    isSubmitToolOutputs = preparedRuntime.isSubmitToolOutputs;
    pipelineEntryEndpoint = preparedRuntime.pipelineEntryEndpoint;
    resumeMeta = preparedRuntime.resumeMeta;
    const requestContext = preparedRuntime.requestContext;
    const responsesPipelineMetadata = buildResponsesPipelineMetadataForHttp({
      streamPlan: preparedRuntime.streamPlan,
      clientRequestId,
      clientHeaders,
      clientConnectionState,
      resumeMeta,
      requestContext,
    });
    Object.assign(responsesPipelineMetadata, requestStartLogMetadata);
    MetadataCenter.attach(responsesPipelineMetadata);
    responsesPipelineMetadata.requestId = requestId;
    responsesPipelineMetadata.clientRequestId = clientRequestId;
    if (typeof ctx.portContext?.stopMessageEnabled === 'boolean') {
      writeMetadataCenterSlot({
        target: responsesPipelineMetadata,
        family: 'runtime_control',
        key: 'stopMessageEnabled',
        value: ctx.portContext.stopMessageEnabled,
        writer: {
          module: 'src/server/handlers/responses-handler.ts',
          symbol: 'handleResponses',
          stage: 'responses_handler_port_runtime_control'
        },
        reason: 'responses port stop-message enablement'
      });
    }
    if (typeof ctx.portContext?.stopMessageExcludeDirect === 'boolean') {
      writeMetadataCenterSlot({
        target: responsesPipelineMetadata,
        family: 'runtime_control',
        key: 'stopMessageExcludeDirect',
        value: ctx.portContext.stopMessageExcludeDirect,
        writer: {
          module: 'src/server/handlers/responses-handler.ts',
          symbol: 'handleResponses',
          stage: 'responses_handler_port_runtime_control'
        },
        reason: 'responses port stop-message direct exclusion'
      });
    }
    const preparedPipelineBody = prepareResponsesRequestBodyForHttp(
      payload as Record<string, unknown>,
      responsesPipelineMetadata
    );
    const pipelineBody = preparedPipelineBody.pipelineBody;
    isVideoRequest = payloadContainsVideoInput(payload);
    if (isVideoRequest) {
      requestTimeoutMs = Math.max(configuredRequestTimeoutMs ?? 0, VIDEO_REQUEST_TIMEOUT_MS);
    }
    const wantsStream = preparedRuntime.streamPlan.outboundStream;

    const warmupCheck = detectWarmupRequest(req.headers, payload as Record<string, unknown>);
    if (warmupCheck.isWarmup) {
      recordWarmupSkipEvent({
        endpoint: entryEndpoint,
        requestId,
        userAgent: warmupCheck.userAgent,
        reason: warmupCheck.reason
      });
      res.status(200).json({ status: 'ready' });
      return;
    }
	    const pipelineInput = {
	      entryEndpoint: pipelineEntryEndpoint,
	      method: req.method,
	      requestId,
	      headers: req.headers as Record<string, unknown>,
	      query: req.query as Record<string, unknown>,
	      body: req.body,
      hubBody: pipelineBody,
      metadata: buildHandlerPipelineMetadata(preparedPipelineBody.requestBodyMetadata, responsesPipelineMetadata)
	    };
    const activeRequestTimeoutMs =
      typeof requestTimeoutMs === 'number' && Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
        ? requestTimeoutMs
        : undefined;
    if (activeRequestTimeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        if (timedOut) {return;}
        timedOut = true;
        const err = Object.assign(new Error(`[http] request timeout after ${activeRequestTimeoutMs}ms`), {
          code: 'HTTP_REQUEST_TIMEOUT',
          status: 504
        });
        const wantsStreamForError = preparedRuntime.streamPlan.outboundStream;
        try {
          logRequestError(entryEndpoint, requestId, err);
        } catch (loggingError) {
          logResponsesHandlerNonBlockingError('timeout.log_request_error', loggingError, { requestId });
        }
        // Notify pipeline/servertool/provider transport via shared connection state object.
        try {
          markClientConnectionDisconnected(clientConnectionState, 'HTTP_REQUEST_TIMEOUT');
        } catch (stateError) {
          logResponsesHandlerNonBlockingError('timeout.mark_connection_disconnected', stateError, { requestId });
        }
        if (res.headersSent) {
          if (wantsStreamForError) {
            void writeStartedSsePipelineError(res, ctx, err, entryEndpoint, requestId).catch((writeError) => {
              logResponsesHandlerNonBlockingError('timeout.started_sse_pipeline_error', writeError, { requestId });
            });
            void clearResponsesConversationOnHandlerFailureForHttp({ requestId, stage: 'timeout_started' }).catch((error) => {
              logResponsesHandlerNonBlockingError('responses_context.clear_on_timeout_started', error, { requestId });
            });
            return;
          }
          try {
            res.end();
          } catch (endError) {
            logResponsesHandlerNonBlockingError('timeout.response_end', endError, { requestId });
          }
          void clearResponsesConversationOnHandlerFailureForHttp({ requestId, stage: 'timeout_started' }).catch((error) => {
            logResponsesHandlerNonBlockingError('responses_context.clear_on_timeout_started', error, { requestId });
          });
          return;
        }
        void clearResponsesConversationOnHandlerFailureForHttp({ requestId, stage: 'timeout' }).catch((error) => {
          logResponsesHandlerNonBlockingError('responses_context.clear_on_timeout', error, { requestId });
        });
        void respondWithPipelineError(res, ctx, err, entryEndpoint, requestId, { forceSse: wantsStreamForError });
      }, activeRequestTimeoutMs);
      // Let Node exit even if a client hangs; this timer is per-request and should not keep the process alive.
      timeoutHandle.unref?.();
    }

    const result = await ctx.executePipeline(pipelineInput);
    clearTimeoutHandle();
    if (timedOut || res.headersSent) {
      return;
    }
    const effectiveRequestId = pipelineInput.requestId;
    const finalizeRouteHint = (() => {
      const md = isRecord(result.metadata) ? result.metadata as Record<string, unknown> : undefined;
      if (md) {
        if (typeof md.routeName === 'string' && md.routeName.trim()) return md.routeName.trim();
        const usage = md.usageLogInfo;
        if (usage && typeof usage === 'object' && typeof (usage as Record<string, unknown>).routeName === 'string'
          && ((usage as Record<string, unknown>).routeName as string).trim()) {
          return ((usage as Record<string, unknown>).routeName as string).trim();
        }
      }
      const usageTop = (result as { usageLogInfo?: { routeName?: unknown } }).usageLogInfo;
      if (usageTop && typeof usageTop.routeName === 'string' && usageTop.routeName.trim()) {
        return usageTop.routeName.trim();
      }
      return undefined;
    })();
    const finalizeProviderKey = (() => {
      if (typeof resumeMeta?.providerKey === 'string' && resumeMeta.providerKey.trim()) {
        return resumeMeta.providerKey.trim();
      }
      const usageTop = (result as { usageLogInfo?: { providerKey?: unknown } }).usageLogInfo;
      if (usageTop && typeof usageTop.providerKey === 'string' && usageTop.providerKey.trim()) {
        return usageTop.providerKey.trim();
      }
      const md = isRecord(result.metadata) ? result.metadata as Record<string, unknown> : undefined;
      if (md && typeof md.providerKey === 'string' && md.providerKey.trim()) {
        return md.providerKey.trim();
      }
      return undefined;
    })();
    const finalizeRequestId = (() => {
      const usageTop = (result as { usageLogInfo?: { inputRequestId?: unknown; providerRequestId?: unknown } }).usageLogInfo;
      if (typeof usageTop?.inputRequestId === 'string' && usageTop.inputRequestId.trim()) {
        return usageTop.inputRequestId.trim();
      }
      if (typeof usageTop?.providerRequestId === 'string' && usageTop.providerRequestId.trim()) {
        return usageTop.providerRequestId.trim();
      }
      return effectiveRequestId;
    })();
    result.metadata = await finalizeResponsesPipelineResultForHttp({
      entryEndpoint: pipelineEntryEndpoint,
      requestId: finalizeRequestId,
      body: result.body,
      resultMetadata: isRecord(result.metadata) ? result.metadata as Record<string, unknown> : undefined,
      requestContext,
      providerKey: finalizeProviderKey,
      ...(finalizeRouteHint ? { routeHint: finalizeRouteHint } : {})
    });
    if (result.sseStream === undefined) {
      logRequestComplete(entryEndpoint, effectiveRequestId, result.status ?? 200, result.body, {
        preserveTimingForUsage: true
      });
    }
    await sendPipelineResponse(res, result, effectiveRequestId, {
      forceSSE: wantsStream,
      entryEndpoint: pipelineEntryEndpoint,
      responsesRequestContext: requestContext,
      ...(isVideoRequest ? { sseTotalTimeoutMs: requestTimeoutMs } : {})
    });
  } catch (error: unknown) {
    clearTimeoutHandle();
    void clearResponsesConversationOnHandlerFailureForHttp({ requestId, stage: 'error' }).catch((clearError) => {
      logResponsesHandlerNonBlockingError('responses_context.clear_on_error', clearError, { requestId });
    });
    void captureResponsesInboundToolHistoryErrorsampleForHttp({
      requestId,
      entryEndpoint,
      body: req.body,
      error
    }).catch((captureError) => {
      logResponsesHandlerNonBlockingError('tool_history_errorsample.write', captureError, {
        requestId,
        entryEndpoint
      });
    });
    if (timedOut) {
      return;
    }
    logRequestError(entryEndpoint, requestId, error);
    try {
      await writeDebugErrorDiagArtifact({
        endpoint: entryEndpoint,
        requestId,
        requestBody: req.body,
        error,
      });
    } catch (diagError) {
      logResponsesHandlerNonBlockingError('debug_diag_error_artifact.write', diagError, {
        requestId,
        entryEndpoint
      });
    }
    const acceptsSse = typeof req.headers['accept'] === 'string'
      && (req.headers['accept'] as string).includes('text/event-stream');
    const failureStreamPlan = planResponsesHandlerStreamForHttp({
      payload: req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {},
      forceStream: options.forceStream,
      acceptsSse,
      requestTimeoutMs,
    });
    const wantsStream = failureStreamPlan.outboundStream;
    if (res.headersSent) {
      if (wantsStream && !res.writableEnded) {
        await writeStartedSsePipelineError(res, ctx, error, entryEndpoint, requestId);
      }
      return;
    }
    await respondWithPipelineError(res, ctx, error, entryEndpoint, requestId, { forceSse: wantsStream });
  }
}

export default { handleResponses };
