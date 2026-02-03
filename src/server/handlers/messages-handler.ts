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
import { parseSseJsonRequest } from '../utils/sse-request-parser.js';
import { detectWarmupRequest } from '../utils/warmup-detector.js';
import { recordWarmupSkipEvent } from '../utils/warmup-storm-tracker.js';
import { trackClientConnectionState } from '../utils/client-connection-state.js';

type MessagesPayload = {
  stream?: boolean;
  model?: string;
  [key: string]: unknown;
};

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
    let pipelineBody: Record<string, unknown>;
    let originalPayload: MessagesPayload | undefined;
    let rawRequestMetadata: unknown;
    let inferredModel: string | undefined;

    if (isSseRequest) {
      try {
        const parsed = await parseSseJsonRequest(req);
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
        const aggregatedPayload = parsed.lastPayload ?? parsed.firstPayload;
        if (!aggregatedPayload || typeof aggregatedPayload !== 'object') {
          throw new Error('SSE request did not contain a valid JSON payload');
        }
        jsonPayload = aggregatedPayload as MessagesPayload;
        warmupPayload = aggregatedPayload as MessagesPayload;
        applySystemPromptOverride(entryEndpoint, jsonPayload);
        pipelineBody = jsonPayload;
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

    const warmupCheck = detectWarmupRequest(req.headers, warmupPayload as Record<string, unknown>);
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

    const clientHeaders = captureClientHeaders(req.headers);
    const clientConnectionState = trackClientConnectionState(req, res);
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
    const mockSampleReqId =
      process.env.ROUTECODEX_USE_MOCK === '1' &&
      pipelineBody &&
      typeof pipelineBody === 'object' &&
      (pipelineBody as { metadata?: Record<string, unknown> }).metadata &&
      typeof (pipelineBody as { metadata?: Record<string, unknown> }).metadata?.mockSampleReqId === 'string'
        ? String((pipelineBody as { metadata?: Record<string, unknown> }).metadata?.mockSampleReqId).trim()
        : undefined;
    const result = await ctx.executePipeline({
      entryEndpoint,
      method: req.method,
      requestId,
      headers: req.headers as Record<string, unknown>,
      query: req.query as Record<string, unknown>,
      body: pipelineBody,
      metadata: {
        stream: wantsStream,
        clientRequestId,
        inboundStream,
        outboundStream,
        providerProtocol: 'anthropic-messages',
        __raw_request_body: rawRequestMetadata,
        clientHeaders,
        clientConnectionState,
        ...(mockSampleReqId ? { mockSampleReqId } : {})
      }
    });
    logRequestComplete(entryEndpoint, requestId, result.status ?? 200);
    sendPipelineResponse(res, result, requestId, { forceSSE: wantsStream, entryEndpoint });
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
