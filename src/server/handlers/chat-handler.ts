import type { Request, Response } from 'express';
import type { HandlerContext } from './types.js';
import {
  nextRequestId,
  respondWithPipelineError,
  sendPipelineResponse,
  logRequestStart,
  logRequestComplete,
  logRequestError
} from './handler-utils.js';
import { ensureSsePipelineResult } from '../utils/sse-response-normalizer.js';

export async function handleChatCompletions(req: Request, res: Response, ctx: HandlerContext): Promise<void> {
  const entryEndpoint = '/v1/chat/completions';
  const requestId = nextRequestId(req.headers['x-request-id']);
  try {
    if (!ctx.executePipeline) {
      res.status(503).json({ error: { message: 'Super pipeline runtime not initialized' } });
      return;
    }
    const payload = (req.body || {}) as any;
    const wantsSSE = (typeof req.headers['accept'] === 'string' && (req.headers['accept'] as string).includes('text/event-stream')) || payload.stream === true;
    logRequestStart(entryEndpoint, requestId, { stream: wantsSSE, model: payload?.model });
    const result = await ctx.executePipeline({
      entryEndpoint,
      method: req.method,
      requestId,
      headers: req.headers as Record<string, unknown>,
      query: req.query as Record<string, unknown>,
      body: payload,
      metadata: {
        stream: wantsSSE
      }
    });
    const finalResult = wantsSSE
      ? await ensureSsePipelineResult(result, requestId)
      : result;
    logRequestComplete(entryEndpoint, requestId, finalResult.status ?? 200);
    sendPipelineResponse(res, finalResult, requestId, { forceSSE: wantsSSE });
  } catch (error: any) {
    logRequestError(entryEndpoint, requestId, error);
    if (res.headersSent) return;
    await respondWithPipelineError(res, ctx, error, entryEndpoint, requestId);
  }
}

export default { handleChatCompletions };
