import { Readable } from 'node:stream';

import { AnthropicMessagesLanguageModel } from '@ai-sdk/anthropic/internal';

import { stripInternalKeysDeep } from '../../../../utils/strip-internal-keys.js';
import type { UnknownObject } from '../../../../types/common-types.js';
import type { PreparedHttpRequest } from '../http-request-executor.js';
import { buildAnthropicSdkCallOptions } from './anthropic-sdk-call-options.js';
import { asRecord, pickString, type UnknownRecord } from './anthropic-sdk-transport-shared.js';

function mergePreservedRequestFields(rawBody: UnknownRecord, builtBody: UnknownRecord): UnknownRecord {
  const next = { ...builtBody };
  const metadata = rawBody.metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    next.metadata = stripInternalKeysDeep(metadata as UnknownRecord);
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

export async function executeAnthropicRequestWithBody(
  rawBody: UnknownRecord,
  requestInfo: PreparedHttpRequest
): Promise<unknown> {
  const modelId = pickString(rawBody.model);
  if (!modelId) {
    throw new Error('provider-runtime-error: missing model from anthropic sdk transport');
  }

  const model = new AnthropicMessagesLanguageModel(modelId, {
    provider: 'anthropic.messages',
    baseURL: requestInfo.targetUrl,
    headers: () => ({}),
    buildRequestUrl: () => requestInfo.targetUrl,
    transformRequestBody: (body: Record<string, unknown>) => mergePreservedRequestFields(rawBody, body)
  } as never) as any;

  const callOptions = buildAnthropicSdkCallOptions(rawBody, requestInfo.headers);
  const argsResult = await model.getArgs({
    ...callOptions,
    stream: requestInfo.wantsSse,
    userSuppliedBetas: await model.getBetasFromHeaders(callOptions.headers)
  });
  const args = asRecord(argsResult.args);
  const betas = argsResult.betas instanceof Set ? argsResult.betas : new Set<string>();
  const url = model.buildRequestUrl(requestInfo.wantsSse);
  const headers = await model.getHeaders({ betas, headers: callOptions.headers });
  const body = model.transformRequestBody(args, betas);

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
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
