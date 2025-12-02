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
import { applySystemPromptOverride } from '../../utils/system-prompt-loader.js';

export async function handleChatCompletions(req: Request, res: Response, ctx: HandlerContext): Promise<void> {
  const entryEndpoint = '/v1/chat/completions';
  const requestId = nextRequestId(req.headers['x-request-id']);
  try {
    if (!ctx.executePipeline) {
      res.status(503).json({ error: { message: 'Hub pipeline runtime not initialized' } });
      return;
    }
    const payload = (req.body || {}) as any;
    const originalPayload =
      payload && typeof payload === 'object' ? JSON.parse(JSON.stringify(payload)) : payload;
    const clientHeaders = captureClientHeaders(req.headers);
    const acceptsSse = typeof req.headers['accept'] === 'string'
      && (req.headers['accept'] as string).includes('text/event-stream');
    const originalStream = payload?.stream === true;
    const wantsSSE = acceptsSse || originalStream;
    const outboundStream = originalStream;
    if (acceptsSse && payload && typeof payload === 'object' && !originalStream) {
      payload.stream = true;
    }
    applySystemPromptOverride(entryEndpoint, payload);

    logRequestStart(entryEndpoint, requestId, {
      inboundStream: wantsSSE,
      outboundStream,
      clientAcceptsSse: acceptsSse,
      originalStream,
      model: payload?.model
    });
    const result = await ctx.executePipeline({
      entryEndpoint,
      method: req.method,
      requestId,
      headers: req.headers as Record<string, unknown>,
      query: req.query as Record<string, unknown>,
      body: payload,
      metadata: {
        stream: wantsSSE,
        clientStream: acceptsSse || undefined,
        inboundStream: wantsSSE,
        outboundStream,
        __raw_request_body: originalPayload,
        clientHeaders
      }
    });
    logRequestComplete(entryEndpoint, requestId, result.status ?? 200);
    sendPipelineResponse(res, result, requestId, { forceSSE: wantsSSE });
  } catch (error: any) {
    logRequestError(entryEndpoint, requestId, error);
    if (res.headersSent) return;
    await respondWithPipelineError(res, ctx, error, entryEndpoint, requestId);
  }
}

export default { handleChatCompletions };
