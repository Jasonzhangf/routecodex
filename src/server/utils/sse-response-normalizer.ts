import { PassThrough, Readable } from 'node:stream';
import type { PipelineExecutionResult } from '../handlers/types.js';
// @ts-expect-error llmswitch-core sse converters do not ship type definitions yet
import { ChatJsonToSseConverter, ResponsesJsonToSseConverter } from '../../../sharedmodule/llmswitch-core/dist/v2/conversion/conversion-v3/sse/json-to-sse/index.js';
import { normalizeOpenAIChatSseStream } from './openai-sse-normalizer.js';

type SsePayload = { __sse_responses: Readable };

const chatConverter = new ChatJsonToSseConverter();
const responsesConverter = new ResponsesJsonToSseConverter();

export function hasSsePayload(body: unknown): body is SsePayload {
  return Boolean(body && typeof body === 'object' && '__sse_responses' in (body as Record<string, unknown>));
}

export async function ensureSsePipelineResult(
  result: PipelineExecutionResult,
  requestId: string
): Promise<PipelineExecutionResult> {
  if (!result || !result.body) {
    return result;
  }

  if (hasSsePayload(result.body)) {
    const stream = (result.body as SsePayload).__sse_responses;
    if (!stream) {
      return result;
    }
    if ((stream as any).__llmswitchNormalized) {
      return result;
    }
    const normalized = normalizeOpenAIChatSseStream(stream, { requestId });
    (normalized as any).__llmswitchNormalized = true;
    return {
      ...result,
      body: { __sse_responses: normalized }
    };
  }

  const stream = await convertResponseBodyToSseStream(result.body, requestId);
  if (stream) {
    return {
      ...result,
      body: { __sse_responses: stream }
    };
  }

  return {
    ...result,
    body: wrapBodyInFallbackSse(result.body, requestId)
  };
}

export async function convertResponseBodyToSseStream(body: unknown, requestId: string): Promise<Readable | null> {
  try {
    if (isChatCompletionResponse(body)) {
      const model = extractModel(body);
      const stream = await chatConverter.convertResponseToJsonToSse(body as any, { requestId, model });
      (stream as any).__llmswitchNormalized = true;
      return stream;
    }
    if (isResponsesResponse(body)) {
      const model = extractModel(body);
      const stream = await responsesConverter.convertResponseToJsonToSse(body as any, { requestId, model });
      (stream as any).__llmswitchNormalized = true;
      return stream;
    }
  } catch (error) {
    console.error('[sse-response-normalizer] Failed to convert response payload to SSE:', error);
  }
  return null;
}

export function wrapBodyInFallbackSse(body: unknown, requestId?: string): SsePayload {
  const payload = normalizeBodyForSse(body, requestId);
  const stream = new PassThrough();
  stream.write(`data: ${payload}\n\n`);
  stream.write('data: [DONE]\n\n');
  stream.end();
  (stream as any).__llmswitchNormalized = true;
  return { __sse_responses: stream };
}

function isChatCompletionResponse(body: unknown): body is { object?: string; choices?: unknown[] } {
  if (!body || typeof body !== 'object') return false;
  const record = body as Record<string, unknown>;
  if (record.object === 'chat.completion' || record.object === 'chat.completion.chunk') return true;
  return Array.isArray(record.choices);
}

function isResponsesResponse(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const record = body as Record<string, unknown>;
  if (record.object === 'response') return true;
  if (record.response && typeof record.response === 'object') {
    const inner = record.response as Record<string, unknown>;
    return inner.object === 'response' || Array.isArray(inner.output);
  }
  return false;
}

function extractModel(body: unknown): string {
  if (!body || typeof body !== 'object') return 'unknown';
  const record = body as Record<string, unknown>;
  if (typeof record.model === 'string') {
    return record.model;
  }
  if (record.response && typeof record.response === 'object' && typeof (record.response as Record<string, unknown>).model === 'string') {
    return (record.response as Record<string, unknown>).model as string;
  }
  return 'unknown';
}

function normalizeBodyForSse(body: unknown, requestId?: string): string {
  if (body === undefined || body === null) {
    return JSON.stringify({ id: requestId, object: 'chat.completion.chunk', finish_reason: 'stop' });
  }
  if (typeof body === 'string') {
    return body;
  }
  try {
    return JSON.stringify(body);
  } catch (error) {
    return JSON.stringify({ id: requestId, object: 'chat.completion.chunk', data: String(body) });
  }
}
