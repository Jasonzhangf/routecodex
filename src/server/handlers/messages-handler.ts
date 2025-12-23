import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
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
import { parseSseJsonRequest, createReadableFromSse } from '../utils/sse-request-parser.js';
import { SlidingWindowRateLimiter } from '../utils/rate-limiter.js';

type MessagesPayload = {
  stream?: boolean;
  model?: string;
  [key: string]: unknown;
};

const warmupRateLimiter = new SlidingWindowRateLimiter({
  // 已不再用于实际下游请求节流，仅用于为上游提供 Retry-After 提示，避免持续风暴。
  limit: Number(process.env.ROUTECODEX_MESSAGES_WARMUP_RPM_LIMIT || process.env.ROUTECODEX_MESSAGES_RPM_LIMIT || 1),
  intervalMs: 60_000
});

function isWarmupMessagesPayload(payload: MessagesPayload | undefined): boolean {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const messages = Array.isArray((payload as MessagesPayload).messages)
    ? ((payload as MessagesPayload).messages as Array<Record<string, unknown>>)
    : undefined;
  if (!messages || messages.length === 0) {
    return false;
  }
  const first = messages[0];
  const content = Array.isArray(first.content)
    ? (first.content as Array<Record<string, unknown>>)
    : undefined;
  if (!content || content.length === 0) {
    return false;
  }
  const last = content[content.length - 1] ?? {};
  const text = typeof last.text === 'string' ? last.text.trim() : '';
  const cacheControl = last.cache_control as { type?: unknown } | undefined;
  const cacheType =
    cacheControl && typeof cacheControl.type === 'string'
      ? cacheControl.type
      : undefined;
  if (text !== 'Warmup') {
    return false;
  }
  // 严格要求 cache_control.type === 'ephemeral'，避免误伤用户正常请求。
  return cacheType === 'ephemeral';
}

export async function handleMessages(req: Request, res: Response, ctx: HandlerContext): Promise<void> {
  const entryEndpoint = '/v1/messages';
  const { clientRequestId, providerRequestId } = nextRequestIdentifiers(req.headers['x-request-id'], { entryEndpoint });
  const requestId = providerRequestId;
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
    let warmupPayload: MessagesPayload | undefined;
    let pipelineBody: Record<string, unknown> | { readable?: Readable } | Readable;
    let originalPayload: MessagesPayload | undefined;
    let rawRequestMetadata: unknown;
    let inferredModel: string | undefined;

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
          jsonPayload = parsed.firstPayload as MessagesPayload;
          inferredModel =
            typeof jsonPayload.model === 'string'
              ? String(jsonPayload.model)
              : undefined;
        }
        if (parsed.lastPayload && typeof parsed.lastPayload === 'object') {
          warmupPayload = parsed.lastPayload as MessagesPayload;
        } else if (jsonPayload && typeof jsonPayload === 'object') {
          warmupPayload = jsonPayload;
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
      warmupPayload = jsonPayload;
    }

    // Warmup 请求从第一条起直接在入口挡掉：
    // 1) 不再进入 HubPipeline / 虚拟路由器；
    // 2) 不再打到下游 provider，避免浪费 token；
    // 3) 通过 429 + Retry-After 明确告诉上游不要继续 warmup 风暴。
    if (isWarmupMessagesPayload(warmupPayload)) {
      const throttleResult = warmupRateLimiter.tryAcquire();
      const retryAfterMs = throttleResult.retryAfterMs ?? warmupRateLimiter.intervalMs;
      if (retryAfterMs > 0) {
        res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000).toString());
      }
      res.status(429).json({
        error: {
          message: 'Warmup /v1/messages is not supported; please stop sending warmup requests.',
          code: 'warmup_not_allowed',
          type: 'warmup'
        }
      });
      return;
    }

    const clientHeaders = captureClientHeaders(req.headers);
    const clientRequestedStream = Boolean(isSseRequest || jsonPayload?.stream === true);
    const inboundStream = clientRequestedStream;
    const wantsStream = clientRequestedStream;
    const outboundStream = clientRequestedStream;

    logRequestStart(entryEndpoint, requestId, {
      clientRequestId,
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
    const acceptsSse = typeof req.headers['accept'] === 'string'
      && (req.headers['accept'] as string).includes('text/event-stream');
    const originalStream = Boolean(req.body && typeof req.body === 'object' && (req.body as { stream?: unknown }).stream === true);
    const wantsStream = acceptsSse || originalStream;
    await respondWithPipelineError(res, ctx, error, entryEndpoint, requestId, { forceSse: wantsStream });
  }
}

export default { handleMessages };
