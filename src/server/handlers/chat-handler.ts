import type { Request, Response } from 'express';
// feature_id: server.responses_handler_family
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
  readRequestBodyMetadata,
  stripRequestBodyMetadataForPipeline
} from './handler-utils.js';
import { applySystemPromptOverride } from '../../utils/system-prompt-loader.js';
import { trackClientConnectionState } from '../utils/client-connection-state.js';
import { payloadContainsVideoInput, VIDEO_REQUEST_TIMEOUT_MS } from '../utils/video-request-detection.js';

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
      res.status(503).json({ error: { message: 'Hub pipeline runtime not initialized' , code: 'not_ready' } });
      return;
    }
    const payload = (req.body && typeof req.body === 'object'
      ? req.body
      : {}) as ChatCompletionPayload;
    const isVideoRequest = payloadContainsVideoInput(payload);
    const requestBodyMetadata = readRequestBodyMetadata(payload);
    const clientHeaders = captureClientHeaders(req.headers);
    const clientConnectionState = trackClientConnectionState(req, res);
    const acceptsSse = typeof req.headers['accept'] === 'string'
      && (req.headers['accept'] as string).includes('text/event-stream');
    const originalStream = payload?.stream === true;
    const wantsSSE = acceptsSse || originalStream;
    const outboundStream = originalStream;
    applySystemPromptOverride(entryEndpoint, payload);
    const logMetadata = buildHandlerLogMetadata({
      entryEndpoint,
      requestId,
      headers: req.headers as Record<string, unknown>,
      requestBodyMetadata,
      clientHeaders,
      portContext: ctx.portContext
    });

    logRequestStart(entryEndpoint, requestId, {
      clientRequestId,
      ...(requestBodyMetadata ?? {}),
      ...logMetadata,
      inboundStream: wantsSSE,
      outboundStream,
      clientAcceptsSse: acceptsSse,
      originalStream,
      model: payload?.model,
      videoRequest: isVideoRequest || undefined
    });
    const pipelineBody = stripRequestBodyMetadataForPipeline(payload);
    const result = await ctx.executePipeline({
      entryEndpoint,
      method: req.method,
      requestId,
      headers: req.headers as Record<string, unknown>,
      query: req.query as Record<string, unknown>,
      body: pipelineBody,
      metadata: buildHandlerPipelineMetadata(requestBodyMetadata, {
        ...logMetadata,
        stream: wantsSSE,
        clientRequestId,
        clientStream: acceptsSse || undefined,
        inboundStream: wantsSSE,
        outboundStream,
        providerProtocol: 'openai-chat',
        clientHeaders,
        clientConnectionState
      })
    });
    if (result.sseStream === undefined) {
      logRequestComplete(entryEndpoint, requestId, result.status ?? 200, result.body, {
        preserveTimingForUsage: true
      });
    }
    await sendPipelineResponse(res, result, requestId, {
      forceSSE: wantsSSE,
      entryEndpoint,
      ...(isVideoRequest ? { sseTotalTimeoutMs: VIDEO_REQUEST_TIMEOUT_MS } : {})
    });
  } catch (error: unknown) {
    logRequestError(entryEndpoint, requestId, error);
    const acceptsSse = typeof req.headers['accept'] === 'string'
      && (req.headers['accept'] as string).includes('text/event-stream');
    const originalStream = Boolean(req.body && typeof req.body === 'object' && (req.body as ChatCompletionPayload).stream === true);
    const wantsSSE = acceptsSse || originalStream;
    if (res.headersSent) {
      if (wantsSSE && !res.writableEnded) {
        await writeStartedSsePipelineError(res, ctx, error, entryEndpoint, requestId);
      }
      return;
    }
    await respondWithPipelineError(res, ctx, error, entryEndpoint, requestId, { forceSse: wantsSSE });
  }
}

export default { handleChatCompletions };
