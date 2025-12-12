import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
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
import { parseSseJsonRequest, createReadableFromSse } from '../utils/sse-request-parser.js';
import { SlidingWindowRateLimiter } from '../utils/rate-limiter.js';

type MessagesPayload = {
  stream?: boolean;
  model?: string;
  [key: string]: unknown;
};

const inboundRateLimiter = new SlidingWindowRateLimiter({
  limit: Number(process.env.ROUTECODEX_MESSAGES_RPM_LIMIT || 10),
  intervalMs: 60_000
});

export async function handleMessages(req: Request, res: Response, ctx: HandlerContext): Promise<void> {
  const entryEndpoint = '/v1/messages';
  const requestId = nextRequestId(req.headers['x-request-id']);
  try {
    if (!ctx.executePipeline) {
      res.status(503).json({ error: { message: 'Hub pipeline runtime not initialized' } });
      return;
    }
    const contentType = typeof req.headers['content-type'] === 'string'
      ? (req.headers['content-type'] as string).toLowerCase()
      : '';
    const isSseRequest = contentType.includes('text/event-stream');
    let jsonPayload: MessagesPayload | undefined;
    let pipelineBody: Record<string, unknown> | { readable?: Readable } | Readable;
    let originalPayload: MessagesPayload | undefined;
    let rawRequestMetadata: unknown;
    let inferredModel: string | undefined;

    const throttleResult = inboundRateLimiter.tryAcquire();
    if (!throttleResult.allowed) {
      const retryAfterMs = throttleResult.retryAfterMs ?? inboundRateLimiter.intervalMs;
      res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000).toString());
      res.status(429).json({
        error: {
          message: 'Too many /v1/messages requests; limit 10 per minute. Please retry later.',
          code: 'rate_limited',
          type: 'capacity_error'
        }
      });
      return;
    }

    if (isSseRequest) {
      try {
        const parsed = await parseSseJsonRequest(req);
        pipelineBody = createReadableFromSse(parsed.rawText);
        rawRequestMetadata = {
          format: 'sse',
          rawText: parsed.rawText,
          events: parsed.events
        };
        if (parsed.firstPayload && typeof parsed.firstPayload === 'object') {
          inferredModel =
            typeof (parsed.firstPayload as Record<string, unknown>).model === 'string'
              ? String((parsed.firstPayload as Record<string, unknown>).model)
              : undefined;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid SSE request payload';
        res.status(400).json({ error: { message, code: 'invalid_sse_request' } });
        return;
      }
    } else {
      jsonPayload = (req.body && typeof req.body === 'object'
        ? req.body
        : {}) as MessagesPayload;
      originalPayload = JSON.parse(JSON.stringify(jsonPayload)) as MessagesPayload;
      rawRequestMetadata = originalPayload;
      applySystemPromptOverride(entryEndpoint, jsonPayload);
      pipelineBody = jsonPayload;
      inferredModel = typeof jsonPayload?.model === 'string' ? jsonPayload.model : undefined;
    }

    const clientHeaders = captureClientHeaders(req.headers);
    const clientRequestedStream = Boolean(isSseRequest || jsonPayload?.stream === true);
    if (jsonPayload) {
      jsonPayload.stream = clientRequestedStream;
    }
    const inboundStream = clientRequestedStream;
    const wantsStream = clientRequestedStream;
    const outboundStream = clientRequestedStream;

    logRequestStart(entryEndpoint, requestId, {
      inboundStream,
      outboundStream,
      model: inferredModel ?? jsonPayload?.model
    });
    const result = await ctx.executePipeline({
      entryEndpoint,
      method: req.method,
      requestId,
      headers: req.headers as Record<string, unknown>,
      query: req.query as Record<string, unknown>,
      body: pipelineBody,
      metadata: {
        stream: wantsStream,
        inboundStream,
        outboundStream,
        providerProtocol: 'anthropic-messages',
        __raw_request_body: rawRequestMetadata,
        clientHeaders
      }
    });
    logRequestComplete(entryEndpoint, requestId, result.status ?? 200);
    sendPipelineResponse(res, result, requestId, { forceSSE: wantsStream });
  } catch (error: unknown) {
    logRequestError(entryEndpoint, requestId, error);
    if (res.headersSent) {
      return;
    }
    await respondWithPipelineError(res, ctx, error, entryEndpoint, requestId);
  }
}

export default { handleMessages };
