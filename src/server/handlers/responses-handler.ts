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
  const { clientRequestId, providerRequestId } = nextRequestIdentifiers(req.headers['x-request-id'], { entryEndpoint });
  const requestId = providerRequestId;
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
        payload = (resumeResult.payload ?? {}) as ResponsesPayload;
        resumeMeta = resumeResult.meta;
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
    if ((acceptsSse || options.forceStream) && (!originalStream || options.forceStream)) {
      payload.stream = true;
    }
    const wantsStream = typeof options.forceStream === 'boolean' ? options.forceStream : inboundStream;

    if (entryEndpoint === '/v1/responses') {
      applySystemPromptOverride(entryEndpoint, payload);
    }

    const pipelineInput = {
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
        providerProtocol: 'openai-responses',
        __raw_request_body: originalPayload,
        clientHeaders,
        responsesResume: resumeMeta
      }
    };

    logRequestStart(entryEndpoint, requestId, {
      clientRequestId,
      inboundStream: wantsStream,
      outboundStream,
      clientAcceptsSse: acceptsSse,
      originalStream,
      type: payload?.type
    });
    const result = await ctx.executePipeline(pipelineInput);
    const effectiveRequestId = pipelineInput.requestId;
    logRequestComplete(entryEndpoint, effectiveRequestId, result.status ?? 200);
    sendPipelineResponse(res, result, effectiveRequestId, { forceSSE: wantsStream });
  } catch (error: unknown) {
    logRequestError(entryEndpoint, requestId, error);
    if (res.headersSent) {
      return;
    }
    const acceptsSse = typeof req.headers['accept'] === 'string'
      && (req.headers['accept'] as string).includes('text/event-stream');
    const originalStream = Boolean(req.body && typeof req.body === 'object' && (req.body as ResponsesPayload).stream === true);
    const wantsStream = acceptsSse || originalStream || options.forceStream === true;
    await respondWithPipelineError(res, ctx, error, entryEndpoint, requestId, { forceSse: wantsStream });
  }
}

export default { handleResponses };
