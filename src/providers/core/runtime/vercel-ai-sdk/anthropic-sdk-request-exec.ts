import { Readable } from 'node:stream';

import type { UnknownObject } from '../../../../types/common-types.js';
import type { PreparedHttpRequest } from '../http-request-executor.js';
import { pickString, type UnknownRecord } from './anthropic-sdk-transport-shared.js';

function sanitizeAnthropicOutboundHeaders(headers: Record<string, string>): Record<string, string> {
  const next = { ...headers };
  delete next.session_id;
  delete next.conversation_id;
  delete next.originator;
  delete next.Session_Id;
  delete next.Conversation_Id;
  delete next.Originator;
  for (const key of Object.keys(next)) {
    const lowered = key.toLowerCase();
    if (
      lowered === 'session_id'
      || lowered === 'conversation_id'
      || lowered === 'originator'
    ) {
      delete next[key];
    }
  }
  return next;
}

function responseHeadersToRecord(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== 'object') {
    return undefined;
  }
  const entries = Object.entries(headers as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  if (!entries.length) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function parseWrappedUpstreamStatus(responseText: string): number | undefined {
  const trimmed = responseText.trim();
  if (!trimmed) {
    return undefined;
  }
  const candidates: string[] = [trimmed];
  if (trimmed.startsWith('data:')) {
    candidates.push(trimmed.slice('data:'.length).trim());
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const errorBag =
        parsed?.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)
          ? (parsed.error as Record<string, unknown>)
          : undefined;
      const directStatus = typeof errorBag?.status === 'number' ? errorBag.status : undefined;
      if (directStatus && directStatus >= 100 && directStatus <= 599) {
        return directStatus;
      }
      const message = typeof errorBag?.message === 'string' ? errorBag.message : '';
      const code = typeof errorBag?.code === 'string' ? errorBag.code.trim() : '';
      const text = `${message}\n${code}`;
      const statusMatch =
        text.match(/\b(502|503|504|520)\b/) ??
        text.match(/\b(429|408|425)\b/);
      if (statusMatch) {
        const parsedStatus = Number.parseInt(statusMatch[1], 10);
        if (Number.isFinite(parsedStatus)) {
          return parsedStatus;
        }
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function buildHttpError(status: number, responseText: string): Error & {
  statusCode: number;
  status: number;
  response: { status: number; data: { error: { message: string; code: string } } };
} {
  const effectiveStatus = parseWrappedUpstreamStatus(responseText) ?? status;
  const error = new Error(`HTTP ${effectiveStatus}: ${responseText}`) as Error & {
    statusCode: number;
    status: number;
    response: { status: number; data: { error: { message: string; code: string } } };
  };
  error.statusCode = effectiveStatus;
  error.status = effectiveStatus;
  error.response = {
    status: effectiveStatus,
    data: {
      error: {
        message: responseText,
        code: `HTTP_${effectiveStatus}`
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

function assertAnthropicProviderWireBody(providerWireBody: UnknownRecord): void {
  if (Object.prototype.hasOwnProperty.call(providerWireBody, 'metadata')) {
    throw new Error('provider-runtime-error: anthropic provider wire body contains internal metadata');
  }
}

export async function executeAnthropicRequestWithBody(
  providerWireBody: UnknownRecord,
  requestInfo: PreparedHttpRequest
): Promise<unknown> {
  assertAnthropicProviderWireBody(providerWireBody);
  const modelId = pickString(providerWireBody.model);
  if (!modelId) {
    throw new Error('provider-runtime-error: missing model from anthropic sdk transport');
  }

  const headers = sanitizeAnthropicOutboundHeaders(requestInfo.headers);

  const response = await fetch(requestInfo.targetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(providerWireBody),
    ...(requestInfo.abortSignal ? { signal: requestInfo.abortSignal } : {})
  });

  if (!response.ok) {
    throw buildHttpError(response.status, await response.text());
  }

  const responseHeaders = responseHeadersToRecord(Object.fromEntries(response.headers.entries()));
  if (requestInfo.wantsSse) {
    if (!response.body) {
      throw buildHttpError(502, 'missing upstream SSE body');
    }
    return {
      sseStream: Readable.fromWeb(response.body as never),
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
