import type { Request, Response } from 'express';
import type { HandlerContext } from './types.js';
import {
  nextRequestIdentifiers,
  respondWithPipelineError,
  sendPipelineResponse,
  logRequestStart,
  logRequestComplete,
  logRequestError,
  captureClientHeaders
} from './handler-utils.js';
import { resumeResponsesConversation } from '../../modules/llmswitch/bridge.js';
import { applySystemPromptOverride } from '../../utils/system-prompt-loader.js';
import { detectWarmupRequest } from '../utils/warmup-detector.js';
import { recordWarmupSkipEvent } from '../utils/warmup-storm-tracker.js';
import { trackClientConnectionState } from '../utils/client-connection-state.js';
import { DEFAULT_TIMEOUTS } from '../../constants/index.js';

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

export async function handleResponses(
  req: Request,
  res: Response,
  ctx: HandlerContext,
  options: ResponsesHandlerOptions = {}
): Promise<void> {
  const entryEndpoint = options.entryEndpoint || '/v1/responses';
  const isSubmitToolOutputs = entryEndpoint === '/v1/responses.submit_tool_outputs';
  // Some client endpoints are "synthetic" entrypoints used only for Hub/Pipeline semantics
  // (e.g. submit_tool_outputs). We may rewrite the pipeline entryEndpoint after preprocessing.
  let pipelineEntryEndpoint = entryEndpoint;
  const { clientRequestId, providerRequestId } = nextRequestIdentifiers(req.headers['x-request-id'], { entryEndpoint });
  const requestId = providerRequestId;
  const rawTimeout = String(
    process.env.ROUTECODEX_HTTP_RESPONSES_TIMEOUT_MS ||
      process.env.RCC_HTTP_RESPONSES_TIMEOUT_MS ||
      ''
  ).trim();
  const parsedTimeout = Number(rawTimeout);
  const defaultTimeoutMs = DEFAULT_TIMEOUTS.HTTP_SSE_TOTAL_MS;
  const requestTimeoutMs =
    rawTimeout === ''
      ? defaultTimeoutMs
      : (Number.isFinite(parsedTimeout) ? parsedTimeout : defaultTimeoutMs);
  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const clearTimeoutHandle = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
  };
  try {
    if (!ctx.executePipeline) {
      res.status(503).json({ error: { message: 'Hub pipeline runtime not initialized' } });
      return;
    }
    let payload = (req.body && typeof req.body === 'object'
      ? req.body
      : {}) as ResponsesPayload;
    const originalPayload = JSON.parse(JSON.stringify(payload)) as ResponsesPayload;
    if (options.responseIdFromPath && !payload.response_id) {
      payload.response_id = options.responseIdFromPath;
    }
    const clientHeaders = captureClientHeaders(req.headers);
    const clientConnectionState = trackClientConnectionState(req, res);
    const acceptsSse = typeof req.headers['accept'] === 'string'
      && (req.headers['accept'] as string).includes('text/event-stream');
    const originalStream = payload?.stream === true;
    // submit_tool_outputs is a synthetic entrypoint: do not infer streaming from Accept headers.
    // Some upstreams (e.g. OpenAI-compatible local servers) do not implement streaming on submit paths.
    const inboundStream = isSubmitToolOutputs ? originalStream : (acceptsSse || originalStream);
    const outboundStream = originalStream;
    let resumeMeta: Record<string, unknown> | undefined;
    if (entryEndpoint === '/v1/responses.submit_tool_outputs') {
      const responseId = typeof payload?.response_id === 'string'
        ? payload.response_id
        : options.responseIdFromPath;
      if (!responseId) {
        res.status(400).json({ error: { message: 'response_id is required for submit_tool_outputs', type: 'invalid_request_error' } });
        return;
      }
      try {
        const resumeResult = await resumeResponsesConversation(responseId, payload, { requestId });
        payload = (resumeResult.payload ?? {}) as ResponsesPayload;
        resumeMeta = resumeResult.meta;
        // After resuming, the outbound request becomes a normal `/v1/responses` create request.
        // Keeping the synthetic entrypoint would cause the outbound mapper to rebuild an upstream
        // submit_tool_outputs payload (which many OpenAI-compatible upstreams do not implement).
        pipelineEntryEndpoint = '/v1/responses';
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
    if (!isSubmitToolOutputs && (acceptsSse || options.forceStream) && (!originalStream || options.forceStream)) {
      payload.stream = true;
    }
    const wantsStream = typeof options.forceStream === 'boolean' ? options.forceStream : inboundStream;

    if (entryEndpoint === '/v1/responses') {
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
	      metadata: {
	        stream: wantsStream,
	        clientRequestId,
	        clientStream: acceptsSse || undefined,
	        inboundStream: wantsStream,
	        outboundStream,
	        providerProtocol: 'openai-responses',
	        __raw_request_body: originalPayload,
	        clientHeaders,
	        clientConnectionState,
	        ...(resumeMeta ? { responsesResume: resumeMeta } : {}),
	        ...(mockSampleReqId ? { mockSampleReqId } : {})
	      }
	    };

    if (Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (timedOut) {return;}
        timedOut = true;
        const err = Object.assign(new Error(`[http] request timeout after ${requestTimeoutMs}ms`), {
          code: 'HTTP_REQUEST_TIMEOUT',
          status: 504
        });
        const wantsStreamForError = typeof options.forceStream === 'boolean' ? options.forceStream : inboundStream;
        try {
          logRequestError(entryEndpoint, requestId, err);
        } catch {
          /* ignore logging */
        }
        // Best-effort: notify pipeline/servertool via shared connection state object.
        try {
          const state = clientConnectionState as unknown as { disconnected?: boolean };
          if (state && typeof state === 'object') {
            state.disconnected = true;
          }
        } catch {
          /* ignore */
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
            } catch {
              /* ignore */
            }
          }
          try {
            res.end();
          } catch {
            /* ignore */
          }
          return;
        }
        void respondWithPipelineError(res, ctx, err, entryEndpoint, requestId, { forceSse: wantsStreamForError });
      }, requestTimeoutMs);
      // Let Node exit even if a client hangs; this timer is per-request and should not keep the process alive.
      timeoutHandle.unref?.();
    }

    logRequestStart(entryEndpoint, requestId, {
      clientRequestId,
      inboundStream: wantsStream,
      outboundStream,
      clientAcceptsSse: acceptsSse,
      originalStream,
      type: payload?.type
    });
    const result = await ctx.executePipeline(pipelineInput);
    clearTimeoutHandle();
    if (timedOut || res.headersSent) {
      return;
    }
    const effectiveRequestId = pipelineInput.requestId;
    logRequestComplete(entryEndpoint, effectiveRequestId, result.status ?? 200);
    sendPipelineResponse(res, result, effectiveRequestId, { forceSSE: wantsStream, entryEndpoint });
  } catch (error: unknown) {
    clearTimeoutHandle();
    if (timedOut) {
      return;
    }
    logRequestError(entryEndpoint, requestId, error);
    if (res.headersSent) {
      return;
    }
    const acceptsSse = typeof req.headers['accept'] === 'string'
      && (req.headers['accept'] as string).includes('text/event-stream');
    const originalStream = Boolean(req.body && typeof req.body === 'object' && (req.body as ResponsesPayload).stream === true);
    const wantsStream = isSubmitToolOutputs
      ? (options.forceStream === true || originalStream)
      : (acceptsSse || originalStream || options.forceStream === true);
    await respondWithPipelineError(res, ctx, error, entryEndpoint, requestId, { forceSse: wantsStream });
  }
}

export default { handleResponses };
