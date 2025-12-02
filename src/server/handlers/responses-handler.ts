import type { Request, Response } from 'express';
import type { HandlerContext } from './types.js';
import {
  nextRequestId,
  respondWithPipelineError,
  sendPipelineResponse,
  logRequestStart,
  logRequestComplete,
  logRequestError,
  captureClientHeaders
} from './handler-utils.js';
import { resumeResponsesConversation } from '../../modules/llmswitch/bridge.js';
import { applySystemPromptOverride } from '../../utils/system-prompt-loader.js';

interface ResponsesHandlerOptions {
  entryEndpoint?: string;
  forceStream?: boolean;
  responseIdFromPath?: string;
}

export async function handleResponses(
  req: Request,
  res: Response,
  ctx: HandlerContext,
  options: ResponsesHandlerOptions = {}
): Promise<void> {
  const entryEndpoint = options.entryEndpoint || '/v1/responses';
  const requestId = nextRequestId(req.headers['x-request-id']);
  try {
    if (!ctx.executePipeline) {
      res.status(503).json({ error: { message: 'Hub pipeline runtime not initialized' } });
      return;
    }
    let payload = (req.body || {}) as any;
    const originalPayload =
      payload && typeof payload === 'object' ? JSON.parse(JSON.stringify(payload)) : payload;
    if (options.responseIdFromPath && payload && typeof payload === 'object' && !payload.response_id) {
      payload.response_id = options.responseIdFromPath;
    }
    const clientHeaders = captureClientHeaders(req.headers);
    const acceptsSse = typeof req.headers['accept'] === 'string'
      && (req.headers['accept'] as string).includes('text/event-stream');
    const originalStream = payload?.stream === true;
    const inboundStream = acceptsSse || originalStream;
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
        payload = resumeResult.payload as typeof payload;
        resumeMeta = resumeResult.meta as Record<string, unknown>;
      } catch (error: any) {
        const message = typeof error?.message === 'string' ? error.message : 'Unable to resume Responses conversation';
        res.status(400).json({ error: { message, type: 'invalid_request_error', code: 'responses_resume_failed' } });
        return;
      }
    }
    if ((acceptsSse || options.forceStream) && payload && typeof payload === 'object' && (!originalStream || options.forceStream)) {
      payload.stream = true;
    }
    const wantsStream = options.forceStream ?? inboundStream;

    if (entryEndpoint === '/v1/responses') {
      applySystemPromptOverride(entryEndpoint, payload);
    }

    logRequestStart(entryEndpoint, requestId, {
      inboundStream: wantsStream,
      outboundStream,
      clientAcceptsSse: acceptsSse,
      originalStream,
      type: payload?.type
    });
    const result = await ctx.executePipeline({
      entryEndpoint,
      method: req.method,
      requestId,
      headers: req.headers as Record<string, unknown>,
      query: req.query as Record<string, unknown>,
      body: payload,
      metadata: {
        stream: wantsStream,
        clientStream: acceptsSse || undefined,
        inboundStream: wantsStream,
        outboundStream,
        __raw_request_body: originalPayload,
        clientHeaders,
        responsesResume: resumeMeta
      }
    });
    logRequestComplete(entryEndpoint, requestId, result.status ?? 200);
    sendPipelineResponse(res, result, requestId, { forceSSE: wantsStream });
  } catch (error: any) {
    logRequestError(entryEndpoint, requestId, error);
    if (res.headersSent) return;
    await respondWithPipelineError(res, ctx, error, entryEndpoint, requestId);
  }
}

export default { handleResponses };
