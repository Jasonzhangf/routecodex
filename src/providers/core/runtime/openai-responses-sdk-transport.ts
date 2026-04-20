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

function normalizeOpenAiSdkError(error: unknown): never {
  const record = asRecord(error);
  const status = typeof record.status === 'number' ? record.status : typeof record.statusCode === 'number' ? record.statusCode : undefined;
  const message = pickString(record.message) ?? 'Unknown OpenAI SDK transport error';
  if (status) {
    throw buildHttpError(status, message);
  }
  throw error instanceof Error ? error : new Error(String(error));
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
      if (!response.body) {
        throw buildHttpError(502, 'missing upstream SSE body');
      }
      return {
        __sse_responses: Readable.fromWeb(response.body as never),
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
