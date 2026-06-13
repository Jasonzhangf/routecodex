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
  hasSsePayload,
  logRequestStart,
  logRequestComplete,
  logRequestError,
  captureClientHeaders,
  mergePipelineMetadata,
  readRequestBodyMetadata,
  stripRequestBodyMetadataForPipeline
} from './handler-utils.js';
import {
  attachResponsesRequestContextToResultForHttp,
  buildResponsesResumeClientErrorForHttp,
  buildResponsesRequestContextForHttp,
  buildResponsesScopeContinuationExpiredErrorForHttp,
  captureResponsesRequestContextForHttp,
  clearResponsesConversationOnHandlerFailureForHttp,
  finalizeResponsesHandlerPayloadForHttp,
  prepareResponsesHandlerEntryForHttp,
  readResponsesConversationIdFromHttp,
  readResponsesSessionIdFromHttp,
  shouldProjectResponsesResumeClientErrorForHttp,
  shouldManageResponsesConversationForHttp,
  seedResponsesToolCallResponseForHttp
} from '../../modules/llmswitch/bridge/responses-request-bridge.js';
import { detectWarmupRequest } from '../utils/warmup-detector.js';
import { recordWarmupSkipEvent } from '../utils/warmup-storm-tracker.js';
import { markClientConnectionDisconnected, trackClientConnectionState } from '../utils/client-connection-state.js';
import { DEFAULT_TIMEOUTS } from '../../constants/index.js';
import { payloadContainsVideoInput, VIDEO_REQUEST_TIMEOUT_MS } from '../utils/video-request-detection.js';
import { writeErrorsampleJson } from '../../utils/errorsamples.js';
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


function buildResponsesConversationPortScope(ctx: HandlerContext): { matchedPort?: number; routingPolicyGroup?: string } {
  const matchedPort = typeof ctx.portContext?.matchedPort === 'number'
    ? ctx.portContext.matchedPort
    : typeof ctx.portContext?.localPort === 'number'
      ? ctx.portContext.localPort
      : undefined;
  const routingPolicyGroup = typeof ctx.portContext?.routingPolicyGroup === 'string' && ctx.portContext.routingPolicyGroup.trim()
    ? ctx.portContext.routingPolicyGroup.trim()
    : undefined;
  return {
    ...(typeof matchedPort === 'number' ? { matchedPort } : {}),
    ...(routingPolicyGroup ? { routingPolicyGroup } : {})
  };
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

function queueInboundToolHistoryErrorsample(args: {
  requestId: string;
  entryEndpoint: string;
  body: unknown;
  error: unknown;
}): void {
  void writeErrorsampleJson({
    group: 'payload-contract-error',
    kind: 'responses.inbound_tool_history_contract',
    payload: {
      kind: 'responses.inbound_tool_history_contract',
      timestamp: new Date().toISOString(),
      requestId: args.requestId,
      entryEndpoint: args.entryEndpoint,
      body: args.body,
      error:
        args.error && typeof args.error === 'object'
          ? {
              name: (args.error as { name?: unknown }).name,
              message: (args.error as { message?: unknown }).message,
              code: (args.error as { code?: unknown }).code,
              details: (args.error as { details?: unknown }).details
            }
          : { message: String(args.error ?? 'unknown_error') }
    }
  }).catch((error) => {
    logResponsesHandlerNonBlockingError('tool_history_errorsample.write', error, {
      requestId: args.requestId,
      entryEndpoint: args.entryEndpoint
    });
  });
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
    const originalStream = payload?.stream === true;
    // Responses API stream contract is driven by payload.stream, not Accept.
    // Accept only indicates the client can consume SSE if stream=true.
    // Do not upgrade stream=false requests into SSE-visible execution just because the client advertises SSE.
    const outboundStream = typeof options.forceStream === 'boolean'
      ? options.forceStream
      : originalStream;
    // submit_tool_outputs is a synthetic entrypoint: keep transport intent aligned with outbound stream.
    // Some upstreams do not implement streaming on submit paths; we must not infer it from Accept headers.
    const inboundStream = outboundStream;
    emitRequestStart({
      clientRequestId,
      inboundStream: outboundStream,
      outboundStream,
      clientAcceptsSse: acceptsSse,
      originalStream,
      type: payload?.type,
      timeoutMs: requestTimeoutMs
    });
    if (!ctx.executePipeline) {
      res.status(503).json({ error: { message: 'Hub pipeline runtime not initialized' , code: 'not_ready' } });
      return;
    }
    const requestBodyMetadata = readRequestBodyMetadata(payload);
    const sessionIdForResume = readResponsesSessionIdFromHttp(requestBodyMetadata);
    const conversationIdForResume = readResponsesConversationIdFromHttp(requestBodyMetadata);
    const responsesConversationPortScope = buildResponsesConversationPortScope(ctx);
    let resumeMeta: Record<string, unknown> | undefined;
    try {
      const preparedEntry = await prepareResponsesHandlerEntryForHttp({
        payload: payload as Record<string, unknown>,
        entryEndpoint,
        responseIdFromPath: options.responseIdFromPath,
        requestId,
        sessionId: sessionIdForResume,
        conversationId: conversationIdForResume,
        ...responsesConversationPortScope
      });
      if (preparedEntry.kind === 'scope_continuation_expired') {
        res.status(400).json(buildResponsesScopeContinuationExpiredErrorForHttp());
        return;
      }
      payload = preparedEntry.payload as ResponsesPayload;
      isSubmitToolOutputs = preparedEntry.isSubmitToolOutputs;
      pipelineEntryEndpoint = preparedEntry.pipelineEntryEndpoint;
      resumeMeta = preparedEntry.resumeMeta;
    } catch (error: unknown) {
      const structured = error as { status?: number; code?: string; origin?: string };
      const origin = typeof structured?.origin === 'string' ? structured.origin : undefined;
      const status = typeof structured?.status === 'number' ? structured.status : undefined;
      const code = typeof structured?.code === 'string' ? structured.code : 'responses_resume_failed';
      const message = error instanceof Error ? error.message : 'Unable to resume Responses conversation';
      logRequestError(entryEndpoint, requestId, error);
      if (shouldProjectResponsesResumeClientErrorForHttp({ origin })) {
        const clientError = buildResponsesResumeClientErrorForHttp({
          status,
          code,
          origin,
          message,
        });
        res.status(clientError.status).json(clientError.body);
        return;
      }
      const wantsStreamForError = typeof options.forceStream === 'boolean' ? options.forceStream : inboundStream;
      await respondWithPipelineError(res, ctx, error, entryEndpoint, requestId, { forceSse: wantsStreamForError });
      return;
    }
    payload = finalizeResponsesHandlerPayloadForHttp({
      payload: payload as Record<string, unknown>,
      entryEndpoint,
      isSubmitToolOutputs,
      outboundStream,
    }) as ResponsesPayload;
    const pipelineBody = stripRequestBodyMetadataForPipeline(payload);
    const responsesRequestContext = buildResponsesRequestContextForHttp({
      payload: pipelineBody as Record<string, unknown>,
      metadata: requestBodyMetadata,
      ...responsesConversationPortScope
    });
    isVideoRequest = payloadContainsVideoInput(payload);
    if (isVideoRequest) {
      requestTimeoutMs = Math.max(configuredRequestTimeoutMs ?? 0, VIDEO_REQUEST_TIMEOUT_MS);
    }
    const wantsStream = outboundStream;

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
      metadata: mergePipelineMetadata(requestBodyMetadata, {
        stream: wantsStream,
        clientRequestId,
        clientStream: acceptsSse || undefined,
        inboundStream: wantsStream,
        outboundStream,
        providerProtocol: 'openai-responses',
        clientAbortSignal: (() => {
          const ac = clientConnectionState;
          if (!ac) return undefined;
          const sym = Reflect.ownKeys(ac as object).find(
            (k) => typeof k === 'symbol' && k.description === 'routecodex.clientConnectionAbortSignal'
          );
          if (sym) {
            const s = Reflect.get(ac as object, sym);
            if (s && typeof s === 'object' && 'aborted' in (s as object)) return s as AbortSignal;
          }
          return undefined;
        })(),
        clientHeaders,
        clientConnectionState,
	        ...(resumeMeta ? { responsesResume: resumeMeta } : {}),
        responsesRequestContext,
	      })
	    };
    if (shouldManageResponsesConversationForHttp(pipelineEntryEndpoint)) {
      await captureResponsesRequestContextForHttp({
        requestId,
        ...responsesRequestContext,
        providerKey: typeof resumeMeta?.providerKey === 'string' ? resumeMeta.providerKey : undefined
      }).catch((error) => {
        logResponsesHandlerNonBlockingError('responses_context.capture_inbound', error, { requestId });
      });
    }

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
        const wantsStreamForError = outboundStream;
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
          // If we've already started an SSE response, try to emit an explicit error event
          // so SSE clients don't hang on a silent TCP close.
          if (wantsStreamForError) {
            try {
              const payload = {
                type: 'error',
                status: 504,
                error: {
                  message: err.message,
                  code: 'HTTP_REQUEST_TIMEOUT',
                  request_id: requestId
                }
              };
              res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
            } catch (writeError) {
              logResponsesHandlerNonBlockingError('timeout.sse_error_frame_write', writeError, { requestId });
            }
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
    result.metadata = attachResponsesRequestContextToResultForHttp({
      entryEndpoint: pipelineEntryEndpoint,
      resultMetadata: isRecord(result.metadata) ? result.metadata as Record<string, unknown> : undefined,
      requestContext: responsesRequestContext,
    });
    if (!hasSsePayload(result.body)) {
      logRequestComplete(entryEndpoint, effectiveRequestId, result.status ?? 200, result.body, {
        preserveTimingForUsage: true
      });
    }
    if (shouldManageResponsesConversationForHttp(pipelineEntryEndpoint)) {
      try {
        await seedResponsesToolCallResponseForHttp({
          body: result.body,
          requestContext: result.metadata?.responsesRequestContext as {
            payload?: Record<string, unknown>;
            context?: Record<string, unknown>;
            sessionId?: string;
            conversationId?: string;
            matchedPort?: number;
            routingPolicyGroup?: string;
          } | undefined,
          providerKey: typeof resumeMeta?.providerKey === 'string' ? resumeMeta.providerKey : undefined
        });
      } catch (error) {
        logResponsesHandlerNonBlockingError('responses_context.seed_response_id', error, { requestId: effectiveRequestId });
      }
    }
    await sendPipelineResponse(res, result, effectiveRequestId, {
      forceSSE: wantsStream,
      entryEndpoint: pipelineEntryEndpoint,
      responsesRequestContext: result.metadata?.responsesRequestContext as {
        payload: Record<string, unknown>;
        context: Record<string, unknown>;
        sessionId?: string;
        conversationId?: string;
      } | undefined,
      ...(isVideoRequest ? { sseTotalTimeoutMs: requestTimeoutMs } : {})
    });
  } catch (error: unknown) {
    clearTimeoutHandle();
    void clearResponsesConversationOnHandlerFailureForHttp({ requestId, stage: 'error' }).catch((clearError) => {
      logResponsesHandlerNonBlockingError('responses_context.clear_on_error', clearError, { requestId });
    });
    if (timedOut) {
      return;
    }
    const errorRecord = error as Record<string, unknown> | null;
    const code = typeof errorRecord?.code === 'string' ? String(errorRecord.code) : '';
    const message = error instanceof Error ? error.message : String(error ?? '');
    const details = errorRecord && typeof errorRecord.details === 'object'
      ? (errorRecord.details as Record<string, unknown>)
      : undefined;
    if (
      code === 'MALFORMED_REQUEST'
      && (
        message.includes('Tool history contract violated')
        || Boolean(details?.toolHistoryContractViolation)
      )
    ) {
      queueInboundToolHistoryErrorsample({
        requestId,
        entryEndpoint,
        body: req.body,
        error
      });
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
    const bodyPayload = req.body && typeof req.body === 'object' ? req.body as ResponsesPayload : undefined;
    const originalStream = bodyPayload?.stream === true;
    const wantsStream = options.forceStream === true || originalStream;
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
