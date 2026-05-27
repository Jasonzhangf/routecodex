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

function cloneUnknown<T>(value: T): T {
  if (value == null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function extractReasoningText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractReasoningText(item))
      .filter((item): item is string => Boolean(item));
    return parts.length ? parts.join('\n') : undefined;
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  return (
    extractReasoningText(row.text) ??
    extractReasoningText(row.thinking) ??
    extractReasoningText(row.content) ??
    extractReasoningText(row.reasoning) ??
    extractReasoningText(row.reasoning_content)
  );
}

function hasAnthropicThinkingBlock(content: unknown[]): boolean {
  return content.some((entry) => {
    if (!entry || typeof entry !== 'object') {
      return false;
    }
    const type = pickString((entry as Record<string, unknown>).type)?.toLowerCase();
    return type === 'thinking' || type === 'redacted_thinking';
  });
}

function canonicalizeAnthropicAssistantBlocks(content: unknown[]): unknown[] {
  return content.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      return cloneUnknown(entry);
    }
    const row = cloneUnknown(entry as Record<string, unknown>);
    const type = pickString(row.type)?.toLowerCase();
    if (type !== 'thinking') {
      return row;
    }
    const thinkingText = extractReasoningText(row.thinking) ?? extractReasoningText(row.text);
    if (!thinkingText) {
      return row;
    }
    row.thinking = thinkingText;
    if (Object.prototype.hasOwnProperty.call(row, 'text')) {
      delete row.text;
    }
    return row;
  });
}

function toAnthropicAssistantContent(rawMessage: UnknownRecord): unknown {
  const rawContent = rawMessage.content;
  const reasoningText =
    extractReasoningText(rawMessage.reasoning_content) ??
    extractReasoningText(rawMessage.reasoningContent) ??
    extractReasoningText(rawMessage.reasoning);

  if (Array.isArray(rawContent)) {
    const content = canonicalizeAnthropicAssistantBlocks(rawContent);
    if (reasoningText && !hasAnthropicThinkingBlock(content)) {
      content.unshift({ type: 'thinking', thinking: reasoningText });
    }
    return content;
  }

  if (typeof rawContent === 'string') {
    const trimmedContent = rawContent.trim();
    if (!reasoningText) {
      return trimmedContent ? rawContent : rawContent;
    }
    const content: unknown[] = [{ type: 'thinking', thinking: reasoningText }];
    if (trimmedContent) {
      content.push({ type: 'text', text: rawContent });
    }
    return content;
  }

  if (reasoningText) {
    return [{ type: 'thinking', thinking: reasoningText }];
  }

  return cloneUnknown(rawContent);
}

function toAnthropicAssistantContentBlocks(content: unknown): unknown[] {
  if (Array.isArray(content)) {
    return cloneUnknown(content);
  }
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content }] : [];
  }
  if (content == null) {
    return [];
  }
  return [cloneUnknown(content)];
}

function toAnthropicUserContentBlocks(content: unknown): unknown[] {
  if (Array.isArray(content)) {
    return cloneUnknown(content);
  }
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content }] : [];
  }
  if (content == null) {
    return [];
  }
  return [cloneUnknown(content)];
}

function coalesceConsecutiveAnthropicMessages(messages: UnknownRecord[]): UnknownRecord[] {
  const out: UnknownRecord[] = [];
  for (const message of messages) {
    const role = pickString(message.role)?.toLowerCase();
    const previous = out[out.length - 1];
    const previousRole = previous ? pickString(previous.role)?.toLowerCase() : undefined;
    if (!previous || previousRole !== role) {
      out.push(message);
      continue;
    }
    if (role === 'assistant') {
      previous.content = [
        ...toAnthropicAssistantContentBlocks(previous.content),
        ...toAnthropicAssistantContentBlocks(message.content)
      ];
      continue;
    }
    if (role === 'user') {
      previous.content = [
        ...toAnthropicUserContentBlocks(previous.content),
        ...toAnthropicUserContentBlocks(message.content)
      ];
      continue;
    }
    out.push(message);
  }
  return out;
}

export function restoreAnthropicThinkingHistoryFromRawBody(
  rawBody: UnknownRecord,
  builtBody: UnknownRecord
): UnknownRecord {
  const rawMessages = Array.isArray(rawBody.messages) ? rawBody.messages : undefined;
  if (!rawMessages?.length) {
    return builtBody;
  }

  const thinking = asRecord(rawBody.thinking);
  const thinkingType = pickString(thinking.type)?.toLowerCase();
  const shouldRestoreThinkingHistory =
    thinkingType === 'enabled' || thinkingType === 'adaptive' || rawMessages.some((message) => {
      if (!message || typeof message !== 'object') {
        return false;
      }
      const row = message as Record<string, unknown>;
      return (
        extractReasoningText(row.reasoning_content) !== undefined ||
        extractReasoningText(row.reasoningContent) !== undefined ||
        extractReasoningText(row.reasoning) !== undefined
      );
    });
  if (!shouldRestoreThinkingHistory) {
    return builtBody;
  }

  const restoredMessages = coalesceConsecutiveAnthropicMessages(rawMessages
    .filter((message): message is UnknownRecord => Boolean(message && typeof message === 'object'))
    .map((message) => {
      const role = pickString(message.role)?.toLowerCase();
      if (role !== 'assistant') {
        return cloneUnknown(message);
      }
      const next: UnknownRecord = {
        ...cloneUnknown(message),
        content: toAnthropicAssistantContent(message)
      };
      delete next.reasoning_content;
      delete next.reasoningContent;
      delete next.reasoning;
      return next;
    }));

  return {
    ...builtBody,
    messages: restoredMessages
  };
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
  const headers = sanitizeAnthropicOutboundHeaders(
    await model.getHeaders({ betas, headers: callOptions.headers })
  );
  const body = restoreAnthropicThinkingHistoryFromRawBody(
    rawBody,
    asRecord(model.transformRequestBody(args, betas))
  );

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
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
