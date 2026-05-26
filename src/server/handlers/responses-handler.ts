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
  captureRawRequestBodyForMetadata,
  mergePipelineMetadata,
  readRequestBodyMetadata
} from './handler-utils.js';
import { captureResponsesRequestContextForRequest, recordResponsesResponseForRequest, resumeResponsesConversation } from '../../modules/llmswitch/bridge.js';
import { applySystemPromptOverride } from '../../utils/system-prompt-loader.js';
import { detectWarmupRequest } from '../utils/warmup-detector.js';
import { recordWarmupSkipEvent } from '../utils/warmup-storm-tracker.js';
import { trackClientConnectionState } from '../utils/client-connection-state.js';
import { DEFAULT_TIMEOUTS } from '../../constants/index.js';
import { payloadContainsVideoInput, VIDEO_REQUEST_TIMEOUT_MS } from '../utils/video-request-detection.js';
import { writeErrorsampleJson } from '../../utils/errorsamples.js';
import { formatUnknownError, isRecord } from '../../utils/common-utils.js';
import { deriveFinishReason } from '../utils/finish-reason.js';

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

function isResponsesSubmitToolOutputsPayload(payload: ResponsesPayload | undefined): boolean {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  if (typeof payload.response_id !== 'string' || !payload.response_id.trim()) {
    return false;
  }
  return Array.isArray(payload.tool_outputs);
}


function buildResponsesResumeRawRequestBody(originalPayload: ResponsesPayload, responseId?: string): Record<string, unknown> {
  const raw = originalPayload && typeof originalPayload === 'object' && !Array.isArray(originalPayload)
    ? { ...(originalPayload as Record<string, unknown>) }
    : {};
  if (typeof responseId === 'string' && responseId.trim() && typeof raw.response_id !== 'string') {
    raw.response_id = responseId.trim();
  }
  return raw;
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

function readResponsesSessionId(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = typeof metadata?.session_id === 'string'
    ? metadata.session_id
    : typeof metadata?.sessionId === 'string'
      ? metadata.sessionId
      : undefined;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

function shouldPersistResponsesConversation(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const record = payload as Record<string, unknown>;
  if (record.store === true) {
    return true;
  }
  const previousResponseId =
    typeof record.previous_response_id === 'string' && record.previous_response_id.trim()
      ? record.previous_response_id.trim()
      : '';
  const toolOutputs = Array.isArray(record.tool_outputs) ? record.tool_outputs : [];
  return Boolean(previousResponseId && toolOutputs.length > 0);
}

function shouldPersistResponsesConversationForEndpoint(
  entryEndpoint: string | undefined,
  payload: unknown
): boolean {
  if (entryEndpoint === '/v1/responses.submit_tool_outputs') {
    return true;
  }
  return shouldPersistResponsesConversation(payload);
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

function readResponsesResponseId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const nested = record.response && typeof record.response === 'object' && !Array.isArray(record.response)
    ? (record.response as Record<string, unknown>)
    : undefined;
  for (const candidate of [record.id, record.response_id, nested?.id]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
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
      ? undefined
      : (Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : undefined);
  let requestTimeoutMs = configuredRequestTimeoutMs;
  let isVideoRequest = false;
  let timedOut = false;
  let isSubmitToolOutputs = entryEndpoint === '/v1/responses.submit_tool_outputs';
  let timeoutHandle: NodeJS.Timeout | undefined;
  const clearTimeoutHandle = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
  };
  try {
    if (!ctx.executePipeline) {
      res.status(503).json({ error: { message: 'Hub pipeline runtime not initialized' , code: 'not_ready' } });
      return;
    }
    let payload = (req.body && typeof req.body === 'object'
      ? req.body
      : {}) as ResponsesPayload;
    isSubmitToolOutputs =
      entryEndpoint === '/v1/responses.submit_tool_outputs'
      || (
        entryEndpoint === '/v1/responses'
        && isResponsesSubmitToolOutputsPayload(payload)
      );
    const originalPayload = captureRawRequestBodyForMetadata(payload) as ResponsesPayload;
    const requestBodyMetadata = readRequestBodyMetadata(originalPayload);
    const sessionIdForResume = readResponsesSessionId(requestBodyMetadata);
    if (options.responseIdFromPath && !payload.response_id) {
      payload.response_id = options.responseIdFromPath;
    }
    const clientHeaders = captureClientHeaders(req.headers);
    const clientConnectionState = trackClientConnectionState(req, res);
    const acceptsSse = typeof req.headers['accept'] === 'string'
      && (req.headers['accept'] as string).includes('text/event-stream');
    const originalStream = payload?.stream === true;
    // Responses API stream contract is driven by payload.stream, not Accept.
    // Accept only indicates the client can consume SSE if stream=true.
    // Do not upgrade stream=false requests into SSE-visible execution just because the client advertises SSE.
    const outboundStream = typeof options.forceStream === 'boolean' ? options.forceStream : originalStream;
    // submit_tool_outputs is a synthetic entrypoint: keep transport intent aligned with outbound stream.
    // Some upstreams do not implement streaming on submit paths; we must not infer it from Accept headers.
    const inboundStream = outboundStream;
    let resumeMeta: Record<string, unknown> | undefined;
    if (isSubmitToolOutputs) {
      const payloadMetadata =
        payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
          ? (payload.metadata as Record<string, unknown>)
          : undefined;
      if (
        sessionIdForResume
        && (
          !payloadMetadata
          || typeof payloadMetadata.session_id !== 'string'
          || !payloadMetadata.session_id
        )
      ) {
        payload.metadata = {
          ...(payloadMetadata ?? {}),
          session_id: sessionIdForResume
        };
      }
      const responseId = typeof payload?.response_id === 'string'
        ? payload.response_id
        : options.responseIdFromPath;
      if (!responseId) {
        res.status(400).json({ error: { message: 'response_id is required for submit_tool_outputs', type: 'invalid_request_error', code: 'bad_request' } });
        return;
      }
      try {
        const resumeResult = await resumeResponsesConversation(responseId, payload, { requestId });
        payload = (resumeResult.payload ?? {}) as ResponsesPayload;
        resumeMeta = resumeResult.meta;
        // Keep the synthetic submit endpoint through the pipeline.
        // Outbound mapping must decide based on the routed provider protocol:
        // - openai-responses target => rebuild native /submit_tool_outputs payload
        // - cross-protocol target   => use resumed payload semantics for relay
        // Rewriting to `/v1/responses` here breaks same-protocol responses providers
        // that reject `previous_response_id` on plain HTTP create requests.
        pipelineEntryEndpoint = entryEndpoint;
      } catch (error: unknown) {
        const structured = error as { status?: number; code?: string; origin?: string };
        const origin = typeof structured?.origin === 'string' ? structured.origin : undefined;
        const status = typeof structured?.status === 'number'
          ? structured.status
          : origin === 'client'
            ? 422
            : 500;
        const code = typeof structured?.code === 'string' ? structured.code : 'responses_resume_failed';
        const message = error instanceof Error ? error.message : 'Unable to resume Responses conversation';
        logRequestError(entryEndpoint, requestId, error);
        if (origin === 'client') {
          res.status(status).json({
            error: {
              message,
              type: 'invalid_request_error',
              code,
              origin
            }
          });
          return;
        }
        const wantsStreamForError = typeof options.forceStream === 'boolean' ? options.forceStream : inboundStream;
        await respondWithPipelineError(res, ctx, error, entryEndpoint, requestId, { forceSse: wantsStreamForError });
        return;
      }
    }
    if (!isSubmitToolOutputs && options.forceStream === true && (!originalStream || options.forceStream)) {
      payload.stream = true;
    }
    isVideoRequest = payloadContainsVideoInput(payload);
    if (isVideoRequest) {
      requestTimeoutMs = Math.max(configuredRequestTimeoutMs ?? 0, VIDEO_REQUEST_TIMEOUT_MS);
    }
    const wantsStream = outboundStream;

    if (wantsStream && !isVideoRequest) {
      requestTimeoutMs = undefined;
    }

    if (!isSubmitToolOutputs && entryEndpoint === '/v1/responses') {
      applySystemPromptOverride(entryEndpoint, payload);
    }
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

    const mockSampleReqId =
      process.env.ROUTECODEX_USE_MOCK === '1' &&
      payload &&
      typeof payload === 'object' &&
      (payload as { metadata?: Record<string, unknown> }).metadata &&
      typeof (payload as { metadata?: Record<string, unknown> }).metadata?.mockSampleReqId === 'string'
        ? String((payload as { metadata?: Record<string, unknown> }).metadata?.mockSampleReqId).trim()
        : undefined;
	    const pipelineInput = {
	      entryEndpoint: pipelineEntryEndpoint,
	      method: req.method,
	      requestId,
	      headers: req.headers as Record<string, unknown>,
	      query: req.query as Record<string, unknown>,
	      body: payload,
	      metadata: mergePipelineMetadata(requestBodyMetadata, {
        stream: wantsStream,
        clientRequestId,
        clientStream: acceptsSse || undefined,
        inboundStream: wantsStream,
        outboundStream,
        ...(typeof resumeMeta?.routeHint === 'string' && resumeMeta.routeHint.trim()
          ? { routeHint: resumeMeta.routeHint.trim() }
          : {}),
        providerProtocol: 'openai-responses',
        __raw_request_body: isSubmitToolOutputs
          ? buildResponsesResumeRawRequestBody(originalPayload, typeof payload.previous_response_id === 'string' ? payload.previous_response_id : options.responseIdFromPath)
          : originalPayload,
        clientHeaders,
        clientConnectionState,
	        ...(resumeMeta ? { responsesResume: resumeMeta } : {}),
          responsesRequestContext: {
            payload: payload as Record<string, unknown>,
            context: {
              input: Array.isArray(payload.input) ? payload.input : [],
              toolsRaw: Array.isArray(payload.tools) ? payload.tools : undefined,
            },
            sessionId: readResponsesSessionId(requestBodyMetadata),
          },
	        ...(mockSampleReqId ? { mockSampleReqId } : {})
	      })
	    };
    if (
      (
        pipelineEntryEndpoint === '/v1/responses'
        || pipelineEntryEndpoint === '/v1/responses.submit_tool_outputs'
      )
      && shouldPersistResponsesConversationForEndpoint(pipelineEntryEndpoint, payload)
    ) {
      await captureResponsesRequestContextForRequest({
        requestId,
        payload: payload as Record<string, unknown>,
        context: {
          input: Array.isArray(payload.input) ? payload.input : [],
          toolsRaw: Array.isArray(payload.tools) ? payload.tools : undefined,
        },
        sessionId: readResponsesSessionId(requestBodyMetadata),
        routeHint: typeof resumeMeta?.routeHint === 'string' ? resumeMeta.routeHint : undefined,
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
        // Best-effort: notify pipeline/servertool via shared connection state object.
        try {
          const state = clientConnectionState as unknown as { disconnected?: boolean };
          if (state && typeof state === 'object') {
            state.disconnected = true;
          }
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
          return;
        }
        void respondWithPipelineError(res, ctx, err, entryEndpoint, requestId, { forceSse: wantsStreamForError });
      }, activeRequestTimeoutMs);
      // Let Node exit even if a client hangs; this timer is per-request and should not keep the process alive.
      timeoutHandle.unref?.();
    }

    logRequestStart(entryEndpoint, requestId, {
      clientRequestId,
      inboundStream: wantsStream,
      outboundStream,
      clientAcceptsSse: acceptsSse,
      originalStream,
      type: payload?.type,
      videoRequest: isVideoRequest || undefined,
      timeoutMs: requestTimeoutMs
    });
    const result = await ctx.executePipeline(pipelineInput);
    clearTimeoutHandle();
    if (timedOut || res.headersSent) {
      return;
    }
    const effectiveRequestId = pipelineInput.requestId;
    if (
      (
        pipelineEntryEndpoint === '/v1/responses'
        || pipelineEntryEndpoint === '/v1/responses.submit_tool_outputs'
      )
      && shouldPersistResponsesConversationForEndpoint(pipelineEntryEndpoint, payload)
    ) {
      result.metadata = {
        ...(result.metadata || {}),
        responsesRequestContext: {
          payload: payload as Record<string, unknown>,
          context: {
            input: Array.isArray(payload.input) ? payload.input : [],
            toolsRaw: Array.isArray(payload.tools) ? payload.tools : undefined,
          },
          sessionId: readResponsesSessionId(requestBodyMetadata),
        },
      };
    }
    if (!hasSsePayload(result.body)) {
      logRequestComplete(entryEndpoint, effectiveRequestId, result.status ?? 200, result.body, {
        preserveTimingForUsage: true
      });
    }
    if (
      (
        pipelineEntryEndpoint === '/v1/responses'
        || pipelineEntryEndpoint === '/v1/responses.submit_tool_outputs'
      )
      && shouldPersistResponsesConversationForEndpoint(pipelineEntryEndpoint, payload)
    ) {
      try {
        const responseId = readResponsesResponseId(result.body);
        const finishReason = deriveFinishReason(result.body);
        if (responseId && finishReason === 'tool_calls') {
          const requestContext = result.metadata?.responsesRequestContext as {
            payload?: Record<string, unknown>;
            context?: Record<string, unknown>;
            sessionId?: string;
            conversationId?: string;
          } | undefined;
          if (requestContext?.payload && requestContext?.context) {
            await captureResponsesRequestContextForRequest({
              requestId: responseId,
              payload: requestContext.payload,
              context: requestContext.context,
              sessionId: requestContext.sessionId,
              conversationId: requestContext.conversationId,
              routeHint: typeof resumeMeta?.routeHint === 'string' ? resumeMeta.routeHint : undefined,
              providerKey: typeof resumeMeta?.providerKey === 'string' ? resumeMeta.providerKey : undefined
            });
            if (result.body && typeof result.body === 'object' && !Array.isArray(result.body)) {
              await recordResponsesResponseForRequest({
                requestId: responseId,
                response: result.body as Record<string, unknown>,
                routeHint: typeof resumeMeta?.routeHint === 'string' ? resumeMeta.routeHint : undefined,
                providerKey: typeof resumeMeta?.providerKey === 'string' ? resumeMeta.providerKey : undefined,
                sessionId: requestContext.sessionId,
                conversationId: requestContext.conversationId
              });
            }
          }
        }
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
    const acceptsSse = typeof req.headers['accept'] === 'string'
      && (req.headers['accept'] as string).includes('text/event-stream');
    const originalStream = Boolean(req.body && typeof req.body === 'object' && (req.body as ResponsesPayload).stream === true);
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
