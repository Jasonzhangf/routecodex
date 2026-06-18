import fs from 'fs';
// feature_id: server.responses_handler_family
// feature_id: server.responses_request_handler_bridge_surface
import path from 'path';
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
  buildHandlerPipelineMetadata,
} from './handler-utils.js';
import {
  buildResponsesConversationPortScopeForHttp,
  buildResponsesPipelineMetadataForHttp,
  captureResponsesInboundToolHistoryErrorsampleForHttp,
  captureResponsesPipelineRequestContextForHttp,
  clearResponsesConversationOnHandlerFailureForHttp,
  finalizeResponsesPipelineResultForHttp,
  planResponsesHandlerStreamForHttp,
  prepareResponsesRequestBodyForHttp,
  prepareResponsesHandlerRuntimeForHttp,
} from '../../modules/llmswitch/bridge/responses-request-bridge.js';
import { detectWarmupRequest } from '../utils/warmup-detector.js';
import { recordWarmupSkipEvent } from '../utils/warmup-storm-tracker.js';
import { markClientConnectionDisconnected, trackClientConnectionState } from '../utils/client-connection-state.js';
import { DEFAULT_TIMEOUTS } from '../../constants/index.js';
import { payloadContainsVideoInput, VIDEO_REQUEST_TIMEOUT_MS } from '../utils/video-request-detection.js';
import { formatUnknownError, isRecord } from '../../utils/common-utils.js';

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
    const preparedRuntime = await prepareResponsesHandlerRuntimeForHttp({
      payload: payload as Record<string, unknown>,
      entryEndpoint,
      responseIdFromPath: options.responseIdFromPath,
      requestId,
      requestMetadata: {
        clientHeaders,
      },
      portScope: responsesConversationPortScope,
      forceStream: options.forceStream,
      acceptsSse,
      requestTimeoutMs,
    });
    emitRequestStart({
      clientRequestId,
      ...preparedRuntime.streamPlan.requestStartMeta,
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
	      body: pipelineBody,
      metadata: buildHandlerPipelineMetadata(preparedPipelineBody.requestBodyMetadata, responsesPipelineMetadata)
	    };
    await captureResponsesPipelineRequestContextForHttp({
      entryEndpoint: pipelineEntryEndpoint,
      requestId,
      requestContext,
      providerKey: typeof resumeMeta?.providerKey === 'string' ? resumeMeta.providerKey : undefined
    }).catch((error) => {
      logResponsesHandlerNonBlockingError('responses_context.capture_inbound', error, { requestId });
    });

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
    result.metadata = await finalizeResponsesPipelineResultForHttp({
      entryEndpoint: pipelineEntryEndpoint,
      body: result.body,
      resultMetadata: isRecord(result.metadata) ? result.metadata as Record<string, unknown> : undefined,
      requestContext,
      providerKey: typeof resumeMeta?.providerKey === 'string' ? resumeMeta.providerKey : undefined
    });
    if (result.sseStream === undefined) {
      logRequestComplete(entryEndpoint, effectiveRequestId, result.status ?? 200, result.body, {
        preserveTimingForUsage: true
      });
    }
    await sendPipelineResponse(res, result, effectiveRequestId, {
      forceSSE: wantsStream,
      entryEndpoint: pipelineEntryEndpoint,
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
      const diagDir = path.join(process.env.HOME || '/tmp', '.rcc', 'diag');
      fs.mkdirSync(diagDir, { recursive: true });
      const errRec = error as Record<string, unknown>;
      fs.writeFileSync(path.join(diagDir, `error-${requestId}.json`), JSON.stringify({
        endpoint: entryEndpoint,
        requestId,
        requestBody: req.body,
        message: error instanceof Error ? error.message : String(error),
        code: typeof errRec?.code === 'string' ? errRec.code : undefined,
        statusCode: typeof errRec?.statusCode === 'number' ? errRec.statusCode : undefined,
        status: typeof errRec?.status === 'number' ? errRec.status : undefined,
        details: errRec?.details,
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString(),
      }, null, 2));
    } catch {}
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
