import { Readable } from 'node:stream';

import OpenAI from 'openai';

import type { ProviderContext } from '../api/provider-types.js';
import type { PreparedHttpRequest } from './http-request-executor.js';
import type { UnknownObject } from '../../../types/common-types.js';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function pickString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function responseHeadersToRecord(headers: Headers): Record<string, string> | undefined {
  const entries = Array.from(headers.entries()).filter(([key, value]) => key && value);
  if (!entries.length) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function deriveResponsesSdkBaseUrl(targetUrl: string): string {
  const url = new URL(targetUrl);
  if (url.pathname.endsWith('/responses')) {
    url.pathname = url.pathname.slice(0, -'/responses'.length) || '/';
  }
  return url.toString().replace(/\/$/, '');
}

function extractSdkApiKey(headers: Record<string, string>): string {
  const authHeader = headers.authorization ?? headers.Authorization;
  const bearer = typeof authHeader === 'string' ? authHeader.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() : undefined;
  if (bearer) {
    return bearer;
  }
  const xApiKey = pickString(headers['x-api-key'] ?? headers['X-API-Key']);
  if (xApiKey) {
    return xApiKey;
  }
  throw new Error('provider-runtime-error: missing api key for openai responses sdk transport');
}

function buildSdkHeaders(headers: Record<string, string>): Record<string, string> | undefined {
  const filtered = Object.entries(headers).filter(([key]) => {
    const lowered = key.toLowerCase();
    return lowered !== 'authorization' && lowered !== 'content-length' && lowered !== 'host';
  });
  if (!filtered.length) {
    return undefined;
  }
  return Object.fromEntries(filtered);
}

function buildHttpError(status: number, responseText: string): Error & {
  statusCode: number;
  status: number;
  response: { status: number; data: { error: { message: string; code: string } } };
} {
  const error = new Error(`HTTP ${status}: ${responseText}`) as Error & {
    statusCode: number;
    status: number;
    response: { status: number; data: { error: { message: string; code: string } } };
  };
  error.statusCode = status;
  error.status = status;
  error.response = {
    status,
    data: {
      error: {
        message: responseText,
        code: `HTTP_${status}`
      }
    }
  };
  return error;
}

function buildInvalidJsonError(responseText: string): Error & {
  statusCode: number;
  status: number;
  response: { status: number; data: { error: { message: string; code: string } } };
} {
  const error = new Error('Invalid JSON response') as Error & {
    statusCode: number;
    status: number;
    response: { status: number; data: { error: { message: string; code: string } } };
  };
  error.statusCode = 200;
  error.status = 200;
  error.response = {
    status: 200,
    data: {
      error: {
        message: responseText,
        code: 'HTTP_200'
      }
    }
  };
  return error;
}

function buildResponsesSseProviderError(args: {
  message: string;
  code?: string;
}): Error & {
  statusCode: number;
  status: number;
  code: string;
  upstreamCode?: string;
  retryable: boolean;
  requestExecutorProviderErrorStage: string;
} {
  const error = new Error(args.message) as Error & {
    statusCode: number;
    status: number;
    code: string;
    upstreamCode?: string;
    retryable: boolean;
    requestExecutorProviderErrorStage: string;
  };
  error.statusCode = 429;
  error.status = 429;
  error.code = 'PROVIDER_TRAFFIC_SATURATED';
  if (args.code) {
    error.upstreamCode = args.code;
  }
  error.retryable = true;
  error.requestExecutorProviderErrorStage = 'provider.http';
  return error;
}

function normalizeOpenAiSdkError(error: unknown): never {
  const record = asRecord(error);
  const status = typeof record.status === 'number' ? record.status : typeof record.statusCode === 'number' ? record.statusCode : undefined;
  const message = pickString(record.message) ?? 'Unknown OpenAI SDK transport error';
  if (status) {
    throw buildHttpError(status, message);
  }
  throw error instanceof Error ? error : new Error(String(error));
}

function parseResponsesSseFrame(block: string): { eventName?: string; data?: UnknownRecord } {
  const lines = block.split(/\r?\n/);
  const eventName = lines
    .filter((line) => line.startsWith('event:'))
    .map((line) => line.slice('event:'.length).trim())
    .find(Boolean);
  const dataText = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('\n');
  if (!dataText || dataText === '[DONE]') {
    return { eventName };
  }
  try {
    const data = JSON.parse(dataText) as unknown;
    return {
      eventName,
      data: asRecord(data)
    };
  } catch {
    return { eventName };
  }
}

function readErrorPayload(data: UnknownRecord | undefined): { code?: string; message?: string } {
  if (!data) {
    return {};
  }
  const nestedError = asRecord(data.error);
  const response = asRecord(data.response);
  const responseError = asRecord(response.error);
  return {
    code: pickString(data.code) ?? pickString(nestedError.code) ?? pickString(responseError.code),
    message: pickString(data.message) ?? pickString(nestedError.message) ?? pickString(responseError.message)
  };
}

function isResponsesSseRateLimitLike(args: { code?: string; message?: string }): boolean {
  const code = (args.code ?? '').trim().toLowerCase();
  const message = (args.message ?? '').trim().toLowerCase();
  return code === 'rate_limit_error'
    || code === 'provider_traffic_saturated'
    || code === 'http_429'
    || message.includes('concurrency limit exceeded')
    || message.includes('rate limit')
    || message.includes('too many requests');
}

async function prepareResponsesSseStream(response: Response): Promise<Readable> {
  if (!response.body) {
    throw buildHttpError(502, 'missing upstream SSE body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const bufferedChunks: Uint8Array[] = [];
  let bufferedText = '';
  let sawSemanticFrame = false;

  while (!sawSemanticFrame) {
    const read = await reader.read();
    if (read.done) {
      break;
    }
    bufferedChunks.push(read.value);
    bufferedText += decoder.decode(read.value, { stream: true });
    const parts = bufferedText.split(/\n\n/);
    bufferedText = parts.pop() ?? '';
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || trimmed.startsWith(':')) {
        continue;
      }
      const parsed = parseResponsesSseFrame(part);
      const payload = readErrorPayload(parsed.data);
      const type = pickString(parsed.data?.type);
      if (
        parsed.eventName === 'error'
        || parsed.eventName === 'response.failed'
        || type === 'error'
        || type === 'response.failed'
      ) {
        if (isResponsesSseRateLimitLike(payload)) {
          await reader.cancel().catch(() => undefined);
          throw buildResponsesSseProviderError({
            message: payload.message ?? 'upstream Responses SSE rate limit error',
            code: payload.code
          });
        }
      }
      sawSemanticFrame = true;
      break;
    }
    if (bufferedChunks.reduce((total, chunk) => total + chunk.byteLength, 0) > 64 * 1024) {
      break;
    }
  }

  async function* replayAndRead(): AsyncGenerator<Uint8Array> {
    for (const chunk of bufferedChunks) {
      yield chunk;
    }
    while (true) {
      const read = await reader.read();
      if (read.done) {
        break;
      }
      yield read.value;
    }
  }

  return Readable.from(replayAndRead());
}

export class OpenAiResponsesSdkTransport {
  async executePreparedRequest(
    requestInfo: PreparedHttpRequest,
    _context: ProviderContext
  ): Promise<unknown> {
    const rawBody = asRecord(requestInfo.body) as UnknownObject;
    const apiKey = extractSdkApiKey(requestInfo.headers);
    const client = new OpenAI({
      apiKey,
      baseURL: deriveResponsesSdkBaseUrl(requestInfo.targetUrl),
      maxRetries: 0,
      defaultHeaders: buildSdkHeaders(requestInfo.headers),
      fetch: global.fetch
    });

    const requestBody: UnknownObject = {
      ...rawBody,
      ...(requestInfo.wantsSse ? { stream: true } : {})
    };

    let response: Response;
    try {
      response = await client.responses
        .create(requestBody as never, {
          headers: buildSdkHeaders(requestInfo.headers),
          ...(requestInfo.abortSignal ? { signal: requestInfo.abortSignal } : {})
        } as never)
        .asResponse();
    } catch (error) {
      normalizeOpenAiSdkError(error);
    }

    const responseHeaders = responseHeadersToRecord(response.headers);
    if (requestInfo.wantsSse) {
      const sseStream = await prepareResponsesSseStream(response);
      return {
        __sse_responses: sseStream,
        ...(responseHeaders ? { headers: responseHeaders } : {})
      };
    }

    const responseText = await response.text();
    let responseBody: UnknownObject;
    try {
      responseBody = JSON.parse(responseText) as UnknownObject;
    } catch {
      throw buildInvalidJsonError(responseText);
    }

    return {
      data: responseBody,
      status: response.status,
      ...(responseHeaders ? { headers: responseHeaders } : {})
    };
  }
}

export { deriveResponsesSdkBaseUrl };
