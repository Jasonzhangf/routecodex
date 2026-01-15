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
import { applySystemPromptOverride } from '../../utils/system-prompt-loader.js';
import { trackClientConnectionState } from '../utils/client-connection-state.js';

type ChatCompletionPayload = {
  stream?: boolean;
  model?: string;
  [key: string]: unknown;
};

export async function handleChatCompletions(req: Request, res: Response, ctx: HandlerContext): Promise<void> {
  const entryEndpoint = '/v1/chat/completions';
  const { clientRequestId, providerRequestId } = nextRequestIdentifiers(req.headers['x-request-id'], { entryEndpoint });
  const requestId = providerRequestId;
  try {
    if (!ctx.executePipeline) {
      res.status(503).json({ error: { message: 'Hub pipeline runtime not initialized' } });
      return;
    }
    const payload = (req.body && typeof req.body === 'object'
      ? req.body
      : {}) as ChatCompletionPayload;
    const originalPayload = JSON.parse(JSON.stringify(payload)) as ChatCompletionPayload;
    const clientHeaders = captureClientHeaders(req.headers);
    const clientConnectionState = trackClientConnectionState(req, res);
    const acceptsSse = typeof req.headers['accept'] === 'string'
      && (req.headers['accept'] as string).includes('text/event-stream');
    const originalStream = payload?.stream === true;
    const wantsSSE = acceptsSse || originalStream;
    const outboundStream = originalStream;
    if (acceptsSse && !originalStream) {
      payload.stream = true;
    }
    applySystemPromptOverride(entryEndpoint, payload);

    logRequestStart(entryEndpoint, requestId, {
      clientRequestId,
      inboundStream: wantsSSE,
      outboundStream,
      clientAcceptsSse: acceptsSse,
      originalStream,
      model: payload?.model
    });
    const mockSampleReqId =
      process.env.ROUTECODEX_USE_MOCK === '1' &&
      payload &&
      typeof payload === 'object' &&
      (payload as { metadata?: Record<string, unknown> }).metadata &&
      typeof (payload as { metadata?: Record<string, unknown> }).metadata?.mockSampleReqId === 'string'
        ? String((payload as { metadata?: Record<string, unknown> }).metadata?.mockSampleReqId).trim()
        : undefined;
    const result = await ctx.executePipeline({
      entryEndpoint,
      method: req.method,
      requestId,
      headers: req.headers as Record<string, unknown>,
      query: req.query as Record<string, unknown>,
      body: payload,
      metadata: {
        stream: wantsSSE,
        clientRequestId,
        clientStream: acceptsSse || undefined,
        inboundStream: wantsSSE,
        outboundStream,
        providerProtocol: 'openai-chat',
        __raw_request_body: originalPayload,
        clientHeaders,
        clientConnectionState,
        ...(mockSampleReqId ? { mockSampleReqId } : {})
      }
    });
    logRequestComplete(entryEndpoint, requestId, result.status ?? 200);
    sendPipelineResponse(res, result, requestId, { forceSSE: wantsSSE });
  } catch (error: unknown) {
    logRequestError(entryEndpoint, requestId, error);
    if (res.headersSent) {
      return;
    }
    const acceptsSse = typeof req.headers['accept'] === 'string'
      && (req.headers['accept'] as string).includes('text/event-stream');
    const originalStream = Boolean(req.body && typeof req.body === 'object' && (req.body as ChatCompletionPayload).stream === true);
    const wantsSSE = acceptsSse || originalStream;
    await respondWithPipelineError(res, ctx, error, entryEndpoint, requestId, { forceSse: wantsSSE });
  }
}

export default { handleChatCompletions };
