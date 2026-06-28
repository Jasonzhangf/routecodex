import type { Readable } from 'node:stream';
/**
 * /v1/responses response-side handler bridge surface.
 *
 * Single projection-facing bridge entry for Responses JSON projection and
 * direct-continuation closeout IO.
 */

// feature_id: server.responses_response_handler_bridge_surface
// canonical_builders: resolveResponsesRequestContextForHttp, planResponsesContinuationCloseActionForHttp, rebindResponsesConversationRequestIdForHttp, normalizeResponsesJsonBodyForHttp, buildResponsesPayloadFromChatForHttp

import type { AnyRecord } from './module-loader.js';
import {
  createResponsesJsonToSseConverter,
  importCoreDist,
  isToolCallContinuationResponseNative,
  rebindResponsesConversationRequestId,
  requireCoreDist,
} from './index.js';
import {
  clearResponsesConversationByRequestId,
} from './runtime-integrations.js';
import {
  buildResponsesPayloadFromChatNative,
  projectResponsesClientPayloadForClientNative,
} from './native-exports.js';
import { normalizeUsage } from '../../../server/runtime/http-server/executor/usage-aggregator.js';
import {
  readRuntimeRequestTruthIdentifiers,
} from '../../../server/runtime/http-server/metadata-center/request-truth-readers.js';
import { stripInternalKeysDeep } from '../../../utils/strip-internal-keys.js';

export type ResponsesRequestContextForHttp = {
  payload: AnyRecord;
  context: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  matchedPort?: number;
  routingPolicyGroup?: string;
};

export function resolveResponsesRequestContextForHttp(args: {
  metadata?: unknown;
  fallback?: ResponsesRequestContextForHttp;
}): ResponsesRequestContextForHttp | undefined {
  void args.metadata;
  return args.fallback;
}

type ChatUsageNormalizationResultForHttp = {
  payload: unknown;
  normalized: boolean;
  source?: 'body' | 'usage_log';
};

function isChatCompletionsEndpointForHttp(entryEndpoint?: string): boolean {
  return typeof entryEndpoint === 'string' && entryEndpoint.toLowerCase().includes('/v1/chat/completions');
}

function sanitizeNumericUsageFieldForHttp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function resolveNormalizedChatUsageForHttp(
  body: unknown,
  options: {
    entryEndpoint?: string;
    usageFallback?: Record<string, unknown>;
  }
): { usage?: Record<string, unknown>; source?: 'body' | 'usage_log' } {
  if (!isChatCompletionsEndpointForHttp(options.entryEndpoint)) {
    return {};
  }
  const record =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  const rawUsage = record?.usage;
  const normalizedFromBody = normalizeUsage(rawUsage);
  const normalizedFromFallback = normalizeUsage(options.usageFallback);
  const normalized = normalizedFromBody ?? normalizedFromFallback;
  if (!normalized) {
    return {};
  }
  const usageSource: 'body' | 'usage_log' = normalizedFromBody ? 'body' : 'usage_log';
  const usageRecord =
    rawUsage && typeof rawUsage === 'object' && !Array.isArray(rawUsage)
      ? ({ ...(rawUsage as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  const promptTokens = sanitizeNumericUsageFieldForHttp(normalized.prompt_tokens);
  const completionTokens = sanitizeNumericUsageFieldForHttp(normalized.completion_tokens);
  let totalTokens = sanitizeNumericUsageFieldForHttp(normalized.total_tokens);
  if (totalTokens === undefined && promptTokens !== undefined && completionTokens !== undefined) {
    totalTokens = promptTokens + completionTokens;
  }
  if (promptTokens !== undefined) {
    usageRecord.input_tokens = promptTokens;
    usageRecord.prompt_tokens = promptTokens;
  }
  if (completionTokens !== undefined) {
    usageRecord.output_tokens = completionTokens;
    usageRecord.completion_tokens = completionTokens;
  }
  if (totalTokens !== undefined) {
    usageRecord.total_tokens = totalTokens;
  }
  return { usage: usageRecord, source: usageSource };
}

function asRecordForHttp(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const RESPONSES_DEBUG = (process.env.ROUTECODEX_RESPONSES_DEBUG || '').trim() === '1';

function summarizeDebugToolsForHttp(tools: unknown): Record<string, unknown> {
  const list = Array.isArray(tools) ? tools : [];
  return {
    count: list.length,
    names: list.map((tool) => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
        return 'unknown';
      }
      const row = tool as Record<string, unknown>;
      const directName = typeof row.name === 'string' ? row.name.trim() : '';
      if (directName) {
        return directName;
      }
      const fn =
        row.function && typeof row.function === 'object' && !Array.isArray(row.function)
          ? (row.function as Record<string, unknown>)
          : undefined;
      const fnName = typeof fn?.name === 'string' ? fn.name.trim() : '';
      return fnName || 'unknown';
    }),
  };
}

export function buildResponsesRequestLogContextForHttp(args: {
  metadata?: unknown;
  usageLogInfo?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const metadata = asRecordForHttp(args.metadata);
  const usageLogInfo = asRecordForHttp(args.usageLogInfo);
  const requestTruth = readRuntimeRequestTruthIdentifiers(metadata);
  return {
    logSessionColorKey: usageLogInfo.logSessionColorKey ?? metadata.logSessionColorKey,
    clientTmuxSessionId: usageLogInfo.clientTmuxSessionId ?? metadata.clientTmuxSessionId,
    client_tmux_session_id: usageLogInfo.client_tmux_session_id ?? metadata.client_tmux_session_id,
    tmuxSessionId: usageLogInfo.tmuxSessionId ?? metadata.tmuxSessionId,
    tmux_session_id: usageLogInfo.tmux_session_id ?? metadata.tmux_session_id,
    rccSessionClientTmuxSessionId:
      usageLogInfo.rccSessionClientTmuxSessionId ?? metadata.rccSessionClientTmuxSessionId,
    rcc_session_client_tmux_session_id:
      usageLogInfo.rcc_session_client_tmux_session_id ?? metadata.rcc_session_client_tmux_session_id,
    sessionId: usageLogInfo.sessionId ?? requestTruth.sessionId,
    session_id: usageLogInfo.session_id ?? requestTruth.sessionId,
    conversationId: usageLogInfo.conversationId ?? requestTruth.conversationId,
    conversation_id: usageLogInfo.conversation_id ?? requestTruth.conversationId
  };
}

export function normalizeChatUsagePayloadForHttp(
  body: unknown,
  options: {
    entryEndpoint?: string;
    usageFallback?: Record<string, unknown>;
  }
): ChatUsageNormalizationResultForHttp {
  if (!isChatCompletionsEndpointForHttp(options.entryEndpoint)) {
    return { payload: body, normalized: false };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { payload: body, normalized: false };
  }
  const record = body as Record<string, unknown>;
  const resolved = resolveNormalizedChatUsageForHttp(body, options);
  if (!resolved.usage) {
    return { payload: body, normalized: false };
  }
  return {
    payload: {
      ...record,
      usage: resolved.usage
    },
    normalized: true,
    source: resolved.source
  };
}

export function shouldDispatchResponsesSseToClientForHttp(args: {
  body: unknown;
  forceSSE: boolean;
  metadata?: Record<string, unknown>;
}): boolean {
  return args.forceSSE;
}

export function buildClientSseKeepaliveFrameForHttp(entryEndpoint?: string): string {
  const commentFrame = ': keepalive\n\n';
  return commentFrame;
}

export function shouldClearResponsesConversationOnClientCloseForHttp(args: {
  entryEndpoint?: string;
  closeBeforeStreamEnd: boolean;
}): boolean {
  return args.closeBeforeStreamEnd && args.entryEndpoint === '/v1/responses';
}

export function shouldClearResponsesConversationOnFailureForHttp(args: {
  entryEndpoint?: string;
  status: number;
  phase: 'sse_stream_error' | 'sse_incomplete' | 'json_empty' | 'json';
}): boolean {
  if (
    args.entryEndpoint !== '/v1/responses'
    && args.entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) {
    return false;
  }
  if (args.phase === 'sse_stream_error' || args.phase === 'sse_incomplete') {
    return true;
  }
  return args.status >= 400;
}

export function resolveResponsesConversationClearReasonForHttp(
  phase: 'sse_stream_error' | 'sse_incomplete' | 'json_empty' | 'json'
): 'sse-stream-error' | 'sse-incomplete' | 'json-empty-error' | 'json-error' {
  switch (phase) {
    case 'sse_stream_error':
      return 'sse-stream-error';
    case 'sse_incomplete':
      return 'sse-incomplete';
    case 'json_empty':
      return 'json-empty-error';
    case 'json':
      return 'json-error';
  }
}

function isDirectResponsesToolCallContinuationForHttp(args: {
  entryEndpoint?: string;
  responseBody: unknown;
}): boolean {
  if (
    args.entryEndpoint !== '/v1/responses'
    && args.entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) {
    return false;
  }
  return isToolCallContinuationResponseNative(args.responseBody);
}

export function planResponsesContinuationCloseActionForHttp(args: {
  entryEndpoint?: string;
  requestContextPresent: boolean;
  probe: unknown;
}): {
  action: 'persist_continuation' | 'clear_abandoned';
  keepForSubmitToolOutputs: boolean;
} {
  const isToolCallContinuation = isDirectResponsesToolCallContinuationForHttp({
    entryEndpoint: args.entryEndpoint,
    responseBody: args.probe,
  });
  if (args.requestContextPresent && isToolCallContinuation) {
    return {
      action: 'persist_continuation',
      keepForSubmitToolOutputs: true,
    };
  }
  return {
    action: 'clear_abandoned',
    keepForSubmitToolOutputs: false,
  };
}

export async function rebindResponsesConversationRequestIdForHttp(
  oldId?: string,
  newId?: string
): Promise<void> {
  await rebindResponsesConversationRequestId(oldId, newId);
}
export async function clearResponsesConversationRequestIdsForHttp(args: {
  requestLabel: string;
  timingRequestIds?: string[];
  responseId?: string;
  reason: string;
  onNonBlockingError?: (operation: string, error: unknown) => void;
}): Promise<void> {
  const ids: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || ids.includes(trimmed)) return;
    ids.push(trimmed);
  };
  add(args.requestLabel);
  add(args.responseId);
  if (Array.isArray(args.timingRequestIds)) {
    for (const id of args.timingRequestIds) add(id);
  }
  for (const requestId of ids) {
    await clearResponsesConversationByRequestId(requestId).catch((error) => {
      args.onNonBlockingError?.(`responses-conversation-clear-${args.reason}:${requestId}`, error);
    });
  }
}

type ChatJsonToSseModule = {
  ChatJsonToSseConverter?: new () => {
    convertResponseToJsonToSse(
      payload: unknown,
      options: AnyRecord,
    ): Promise<unknown>;
  };
};

let cachedChatJsonToSseConverterFactory:
  | (() => {
      convertResponseToJsonToSse(
        payload: unknown,
        options: AnyRecord,
      ): Promise<unknown>;
    })
  | null = null;

export async function createChatJsonToSseConverterForHttp(): Promise<{
  convertResponseToJsonToSse(
    payload: unknown,
    options: AnyRecord,
  ): Promise<unknown>;
}> {
  if (!cachedChatJsonToSseConverterFactory) {
    const mod = await importResponsesHandlerCoreDist<ChatJsonToSseModule>(
      'sse/json-to-sse/index'
    );
    const Ctor = mod.ChatJsonToSseConverter;
    if (typeof Ctor !== 'function') {
      throw new Error('[handler-response] ChatJsonToSseConverter not available');
    }
    cachedChatJsonToSseConverterFactory = () => new Ctor();
  }
  return cachedChatJsonToSseConverterFactory();
}

export function shouldReprojectRelayResponsesSseForHttp(args: {
  entryEndpoint?: string;
  continuationOwner?: 'direct' | 'relay';
  hasSseStream: boolean;
}): boolean {
  if (!args.hasSseStream) {
    return false;
  }
  const entry = String(args.entryEndpoint || '').trim().toLowerCase();
  if (entry !== '/v1/responses' && entry !== '/v1/responses.submit_tool_outputs') {
    return false;
  }
  return args.continuationOwner !== 'direct';
}

export async function resolveRelayResponsesClientSseStreamForHttp(args: {
  entryEndpoint?: string;
  continuationOwner?: 'direct' | 'relay';
  sseStream?: unknown;
  body?: Record<string, unknown>;
  requestId: string;
  createConverter?: typeof createResponsesJsonToSseConverter;
}): Promise<import('node:stream').Readable | undefined> {
  if (!shouldReprojectRelayResponsesSseForHttp({
    entryEndpoint: args.entryEndpoint,
    continuationOwner: args.continuationOwner,
    hasSseStream: args.sseStream !== undefined,
  })) {
    return args.sseStream as import('node:stream').Readable | undefined;
  }
  if (!args.body || typeof args.body !== 'object' || Array.isArray(args.body)) {
    throw new Error(
      `[server.response_projection] relay /v1/responses SSE requires standardized response body (requestId=${args.requestId})`
    );
  }
  const converter = await (args.createConverter ?? createResponsesJsonToSseConverter)();
  return await converter.convertResponseToJsonToSse(args.body, {
    requestId: args.requestId,
  }) as import('node:stream').Readable;
}

export function buildResponsesSseErrorPayloadForHttp(args: {
  requestLabel: string;
  status: number;
  message: string;
  code: string;
  error?: Record<string, unknown>;
}): Record<string, unknown> {
  const payloadError: Record<string, unknown> = {
    ...(args.error ?? {}),
    message: args.message,
    code: args.code,
    request_id:
      typeof args.error?.request_id === 'string' && args.error.request_id.trim()
        ? args.error.request_id.trim()
        : args.requestLabel,
  };
  return {
    type: 'error',
    status: args.status,
    error: payloadError,
  };
}

export function buildResponsesStructuredSseErrorPayloadForHttp(args: {
  body: unknown;
  requestLabel: string;
  status: number;
}): Record<string, unknown> | null {
  if (!args.body || typeof args.body !== 'object' || Array.isArray(args.body)) {
    return null;
  }
  const record = args.body as Record<string, unknown>;
  const error =
    record.error && typeof record.error === 'object' && !Array.isArray(record.error)
      ? (record.error as Record<string, unknown>)
      : undefined;
  if (!error) {
    return null;
  }
  const message =
    typeof error.message === 'string' && error.message.trim()
      ? error.message
      : 'Upstream provider error';
  const code =
    typeof error.code === 'string' && error.code.trim()
      ? error.code
      : 'HTTP_HANDLER_ERROR';
  return buildResponsesSseErrorPayloadForHttp({
    requestLabel: args.requestLabel,
    status: args.status,
    message,
    code,
    error,
  });
}

export function buildResponsesMissingSseBridgeErrorPayloadForHttp(requestLabel: string, status = 502): Record<string, unknown> {
  return buildResponsesSseErrorPayloadForHttp({
    requestLabel,
    status,
    message: 'SSE stream missing from pipeline result',
    code: 'sse_bridge_error',
  });
}

export function buildResponsesStreamIncompleteErrorPayloadForHttp(requestLabel: string): Record<string, unknown> {
  return buildResponsesSseErrorPayloadForHttp({
    requestLabel,
    status: 502,
    message: 'stream closed before response.completed',
    code: 'upstream_stream_incomplete',
  });
}

export async function prepareResponsesJsonBodyForSseBridgeForHttp(args: {
  body: unknown;
  entryEndpoint?: string;
  requestLabel?: string;
}): Promise<Record<string, unknown> | null> {
  if (!args.body || typeof args.body !== 'object' || Array.isArray(args.body)) {
    return null;
  }
  const record = args.body as Record<string, unknown>;
  const isResponsesEndpoint =
    args.entryEndpoint === '/v1/responses'
    || args.entryEndpoint === '/v1/responses.submit_tool_outputs';
  if (
    isResponsesEndpoint
    && (
      record.object === 'response'
      || typeof record.output === 'object'
      || typeof record.status === 'string'
    )
  ) {
    return record;
  }
  if (args.entryEndpoint !== '/v1/responses' || record.object !== 'chat.completion') {
    return null;
  }
  return await buildResponsesPayloadFromChatForHttp(args.body, {
    requestId: args.requestLabel
  }) as Record<string, unknown>;
}

export function normalizeResponsesJsonBodyForHttp(args: {
  body: unknown;
  entryEndpoint?: string;
  requestLabel?: string;
  resolveBridge?: typeof importResponsesHandlerCoreDist;
}): Promise<unknown> {
  if (args.entryEndpoint !== '/v1/responses') {
    return Promise.resolve(args.body);
  }
  if (!args.body || typeof args.body !== 'object' || Array.isArray(args.body)) {
    return Promise.resolve(args.body);
  }
  if ((args.body as Record<string, unknown>).object !== 'chat.completion') {
    return Promise.resolve(args.body);
  }
  return (args.resolveBridge ?? importResponsesHandlerCoreDist)<{
    buildResponsesPayloadFromChat?: (payload: unknown, context?: Record<string, unknown>) => unknown
  }>('conversion/responses/responses-openai-bridge').then((mod) => {
    if (typeof mod.buildResponsesPayloadFromChat !== 'function') {
      throw new Error('[handler-response] buildResponsesPayloadFromChat not available');
    }
    return mod.buildResponsesPayloadFromChat(args.body, {
      requestId: args.requestLabel
    });
  });
}

export function requireResponsesHandlerCoreDist<TModule extends object>(
  specifier: string
): TModule {
  return requireCoreDist<TModule>(specifier);
}

export async function importResponsesHandlerCoreDist<TModule extends object>(
  specifier: string
): Promise<TModule> {
  return await importCoreDist<TModule>(specifier);
}

export async function buildResponsesPayloadFromChatForHttp(
  payload: unknown,
  context?: Record<string, unknown>
): Promise<unknown> {
  return buildResponsesPayloadFromChatNative(payload, context);
}

function readResponsesRequestModelForHttp(requestContext?: {
  payload: AnyRecord;
  context: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  matchedPort?: number;
  routingPolicyGroup?: string;
}): string | undefined {
  const payloadModel = requestContext?.payload?.model;
  if (typeof payloadModel === 'string' && payloadModel.trim()) {
    return payloadModel.trim();
  }
  const contextModel = requestContext?.context?.model;
  if (typeof contextModel === 'string' && contextModel.trim()) {
    return contextModel.trim();
  }
  return undefined;
}

function ensureResponsesJsonToSseRequiredFieldsForHttp(args: {
  payload: unknown;
  requestContext?: {
    payload: AnyRecord;
    context: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    matchedPort?: number;
    routingPolicyGroup?: string;
  };
}): unknown {
  if (!args.payload || typeof args.payload !== 'object' || Array.isArray(args.payload)) {
    return args.payload;
  }
  const payload = args.payload as Record<string, unknown>;
  if (payload.object !== 'response') {
    return args.payload;
  }
  if (typeof payload.model === 'string' && payload.model.trim()) {
    return args.payload;
  }
  const model = readResponsesRequestModelForHttp(args.requestContext);
  if (!model) {
    return args.payload;
  }
  return {
    ...payload,
    model,
  };
}

function readResponsesClientToolsRawForHttp(requestContext?: {
  payload: AnyRecord;
  context: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  matchedPort?: number;
  routingPolicyGroup?: string;
}): unknown[] {
  const contextToolsRaw = requestContext?.context?.toolsRaw;
  if (Array.isArray(contextToolsRaw)) {
    return contextToolsRaw;
  }
  const contextClientToolsRaw = requestContext?.context?.clientToolsRaw;
  if (Array.isArray(contextClientToolsRaw)) {
    return contextClientToolsRaw;
  }
  const payloadTools = requestContext?.payload?.tools;
  if (Array.isArray(payloadTools)) {
    return payloadTools;
  }
  return [];
}

export async function normalizeResponsesClientPayloadForHttp(args: {
  payload: unknown;
  entryEndpoint?: string;
  requestContext?: {
    payload: AnyRecord;
    context: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    matchedPort?: number;
    routingPolicyGroup?: string;
  };
  metadata?: Record<string, unknown>;
}): Promise<unknown> {
  if (
    args.entryEndpoint !== '/v1/responses'
    && args.entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) {
    return args.payload;
  }
  if (!args.payload || typeof args.payload !== 'object' || Array.isArray(args.payload)) {
    return args.payload;
  }
  const projectedPayload = projectResponsesClientPayloadForClientNative({
    payload: args.payload,
    toolsRaw: readResponsesClientToolsRawForHttp(args.requestContext),
    metadata: args.metadata,
  });
  return ensureResponsesJsonToSseRequiredFieldsForHttp({
    payload: stripClientVisibleMetadataDeep(projectedPayload),
    requestContext: args.requestContext,
  });
}

export async function prepareResponsesJsonSseDispatchPlanForHttp(args: {
  responsesPayload: Record<string, unknown>;
  entryEndpoint?: string;
  requestLabel: string;
  metadata?: Record<string, unknown>;
  requestContext?: {
    payload: AnyRecord;
    context: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    matchedPort?: number;
    routingPolicyGroup?: string;
  };
}): Promise<{
  normalizedPayload: Record<string, unknown>;
  sanitizedPayload: Record<string, unknown>;
}> {
  const normalizedPayload = ensureResponsesJsonToSseRequiredFieldsForHttp({
    payload: args.responsesPayload,
    requestContext: args.requestContext,
  }) as Record<string, unknown>;
  const sanitizedPayload = stripInternalKeysDeep(normalizedPayload);
  return {
    normalizedPayload,
    sanitizedPayload,
  };
}

export async function prepareResponsesJsonClientDispatchPlanForHttp(args: {
  body: unknown;
  entryEndpoint?: string;
  requestLabel?: string;
  requestContext?: {
    payload: AnyRecord;
    context: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    matchedPort?: number;
    routingPolicyGroup?: string;
  };
  metadata?: Record<string, unknown>;
  resolveBridge?: typeof importResponsesHandlerCoreDist;
}): Promise<{
  clientBody: unknown;
  sanitizedBody: unknown;
}> {
  const normalizedJsonBody = await normalizeResponsesJsonBodyForHttp({
    body: args.body,
    entryEndpoint: args.entryEndpoint,
    requestLabel: args.requestLabel,
    resolveBridge: args.resolveBridge,
  });
  const clientBody = await normalizeResponsesClientPayloadForHttp({
    payload: normalizedJsonBody,
    entryEndpoint: args.entryEndpoint,
    requestContext: args.requestContext,
    metadata: args.metadata,
  });
  return {
    clientBody,
    sanitizedBody: stripInternalKeysDeep(clientBody),
  };
}


function stripClientVisibleMetadataDeep<T>(value: T): T {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripClientVisibleMetadataDeep(item)) as T;
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === 'metadata') {
      continue;
    }
    out[key] = stripClientVisibleMetadataDeep(entry);
  }
  return out as T;
}
