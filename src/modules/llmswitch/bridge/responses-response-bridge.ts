import { Transform, type Readable } from 'node:stream';
/**
 * /v1/responses response-side handler bridge surface.
 *
 * Single projection-facing bridge entry for responses SSE/JSON projection and
 * continuation lifecycle writes on the response path.
 */

// feature_id: server.responses_response_handler_bridge_surface
// canonical_builders: resolveResponsesRequestContextForHttp, isToolCallContinuationResponseForHttp, inspectResponsesContinuationProbeForHttp, planResponsesContinuationCloseActionForHttp, shouldRepairResponsesContinuationTerminalForHttp, rebindResponsesConversationRequestIdForHttp, clearResponsesConversationByRequestIdForHttpProjection, recordResponsesResponseForHttpProjection, finalizeResponsesConversationRequestRetentionForHttp, normalizeResponsesJsonBodyForHttp, buildResponsesPayloadFromChatForHttp, projectResponsesClientPayloadForClientForHttp

import type { AnyRecord } from './module-loader.js';
import {
  createResponsesJsonToSseConverter,
  importCoreDist,
  isToolCallContinuationResponseNative,
  rebindResponsesConversationRequestId,
  requireCoreDist,
} from './index.js';
import {
  captureResponsesRequestContextForRequest,
  clearResponsesConversationByRequestId,
  finalizeResponsesConversationRequestRetention,
  recordResponsesResponseForRequest,
} from './runtime-integrations.js';
import {
  buildResponsesPayloadFromChatNative,
  projectResponsesClientPayloadForClientNative,
} from './native-exports.js';
import { deriveFinishReason } from '../../../server/utils/finish-reason.js';
import { normalizeUsage } from '../../../server/runtime/http-server/executor/usage-aggregator.js';
import { MetadataCenter } from '../../../server/runtime/http-server/metadata-center/metadata-center.js';
import {
  readRuntimeControlProjection,
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
}): ResponsesRequestContextForHttp | undefined {
  const metadata =
    args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata)
      ? args.metadata as Record<string, unknown>
      : undefined;
  const fromMetadata = readMetadataCenterContinuationContextForHttp(metadata).responsesRequestContext;
  if (fromMetadata && typeof fromMetadata === 'object' && !Array.isArray(fromMetadata)) {
    const metadataContext = fromMetadata as ResponsesRequestContextForHttp;
    return {
      payload:
        metadataContext.payload && typeof metadataContext.payload === 'object' && !Array.isArray(metadataContext.payload)
          ? metadataContext.payload
          : {},
      context:
        metadataContext.context && typeof metadataContext.context === 'object' && !Array.isArray(metadataContext.context)
          ? metadataContext.context
          : {},
      ...(typeof metadataContext.sessionId === 'string' && metadataContext.sessionId.trim()
        ? { sessionId: metadataContext.sessionId.trim() }
        : {}),
      ...(typeof metadataContext.conversationId === 'string' && metadataContext.conversationId.trim()
        ? { conversationId: metadataContext.conversationId.trim() }
        : {}),
      ...(typeof metadataContext.matchedPort === 'number'
        ? { matchedPort: metadataContext.matchedPort }
        : {}),
      ...(typeof metadataContext.routingPolicyGroup === 'string' && metadataContext.routingPolicyGroup.trim()
        ? { routingPolicyGroup: metadataContext.routingPolicyGroup.trim() }
        : {}),
    };
  }
  return undefined;
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

function readMetadataCenterContinuationContextForHttp(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  return MetadataCenter.read(metadata)?.readContinuationContext() ?? {};
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

export function shouldRequireResponsesTerminalEventForHttp(args: {
  entryEndpoint?: string;
  probe: unknown;
}): boolean {
  return (
    Boolean(args.probe)
    && (args.entryEndpoint === '/v1/responses' || args.entryEndpoint === '/v1/responses.submit_tool_outputs')
  );
}

export function shouldPersistResponsesConversationStateForHttp(args: {
  entryEndpoint?: string;
  probe: unknown;
}): boolean {
  return shouldRequireResponsesTerminalEventForHttp(args);
}

export function resolveResponsesTerminalProbeFinishReasonForHttp(args: {
  finishReason?: string;
  probe: unknown;
}): string | undefined {
  if (typeof args.finishReason === 'string' && args.finishReason.trim()) {
    return args.finishReason.trim();
  }
  if (!args.probe || typeof args.probe !== 'object' || Array.isArray(args.probe)) {
    return undefined;
  }
  const derived = deriveFinishReason(args.probe);
  if (derived && derived.trim()) {
    return derived.trim();
  }
  const probeRecord = args.probe as Record<string, unknown>;
  const output = Array.isArray(probeRecord.output) ? probeRecord.output : [];
  const sawCompletedAssistantMessage = output.some((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return false;
    }
    const row = item as Record<string, unknown>;
    return row.type === 'message'
      && row.role === 'assistant'
      && typeof row.status === 'string'
      && row.status.trim().toLowerCase() === 'completed';
  });
  if (sawCompletedAssistantMessage) {
    return 'stop';
  }
  return undefined;
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

export function isToolCallContinuationResponseForHttp(body: unknown): boolean {
  return isToolCallContinuationResponseNative(body);
}

export function inspectResponsesContinuationProbeForHttp(args: {
  entryEndpoint?: string;
  probe: unknown;
}): {
  isToolCallContinuation: boolean;
  hasRequiredAction: boolean;
  hasHarvestableFunctionCallHistory: boolean;
} {
  if (
    args.entryEndpoint !== '/v1/responses'
    && args.entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) {
    return {
      isToolCallContinuation: false,
      hasRequiredAction: false,
      hasHarvestableFunctionCallHistory: false,
    };
  }
  if (!args.probe || typeof args.probe !== 'object' || Array.isArray(args.probe)) {
    return {
      isToolCallContinuation: false,
      hasRequiredAction: false,
      hasHarvestableFunctionCallHistory: false,
    };
  }
  const isToolCallContinuation = isToolCallContinuationResponseForHttp(args.probe);
  const probeRecord = args.probe as Record<string, unknown>;
  const output = Array.isArray(probeRecord.output) ? probeRecord.output : [];
  return {
    isToolCallContinuation,
    hasRequiredAction:
      isToolCallContinuation
      && Boolean(
        probeRecord.required_action
        && typeof probeRecord.required_action === 'object'
        && !Array.isArray(probeRecord.required_action)
      ),
    hasHarvestableFunctionCallHistory:
      output.some((item) =>
        item
        && typeof item === 'object'
        && !Array.isArray(item)
        && (item as Record<string, unknown>).type === 'function_call'
      ),
  };
}

export function shouldPersistResponsesContinuationOnProbeUpdateForHttp(args: {
  entryEndpoint?: string;
  probe: unknown;
}): boolean {
  const probeState = inspectResponsesContinuationProbeForHttp(args);
  return probeState.isToolCallContinuation && probeState.hasHarvestableFunctionCallHistory;
}

export function planResponsesContinuationCloseActionForHttp(args: {
  entryEndpoint?: string;
  requestContextPresent: boolean;
  probe: unknown;
}): {
  action: 'persist_continuation' | 'clear_abandoned';
  keepForSubmitToolOutputs: boolean;
} {
  const probeState = inspectResponsesContinuationProbeForHttp({
    entryEndpoint: args.entryEndpoint,
    probe: args.probe,
  });
  if (args.requestContextPresent && probeState.isToolCallContinuation) {
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

export function shouldRepairResponsesContinuationTerminalForHttp(args: {
  entryEndpoint?: string;
  probe: unknown;
}): boolean {
  return inspectResponsesContinuationProbeForHttp({
    entryEndpoint: args.entryEndpoint,
    probe: args.probe,
  }).isToolCallContinuation;
}

export async function captureResponsesRequestContextForHttpProjection(args: {
  requestId: string;
  payload: AnyRecord;
  context: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  providerKey?: string;
  matchedPort?: number;
  routingPolicyGroup?: string;
}): Promise<void> {
  await captureResponsesRequestContextForRequest(args);
}

export async function rebindResponsesConversationRequestIdForHttp(
  oldId?: string,
  newId?: string
): Promise<void> {
  await rebindResponsesConversationRequestId(oldId, newId);
}

export async function clearResponsesConversationByRequestIdForHttpProjection(
  requestId?: string
): Promise<void> {
  await clearResponsesConversationByRequestId(requestId);
}

export async function recordResponsesResponseForHttpProjection(args: {
  requestId: string;
  response: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  providerKey?: string;
  continuationOwner?: 'direct' | 'relay';
  matchedPort?: number;
  routingPolicyGroup?: string;
  allowScopeContinuation?: boolean;
}): Promise<void> {
  await recordResponsesResponseForRequest(args);
}

function readResponsesConversationResponseIdForHttp(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const nested = record.response && typeof record.response === 'object' && !Array.isArray(record.response)
    ? record.response as Record<string, unknown>
    : undefined;
  for (const value of [record.id, record.response_id, nested?.id]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizeResponsesConversationPersistBodyForHttp(
  body: unknown
): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }
  const record = body as Record<string, unknown>;
  const nested = record.response && typeof record.response === 'object' && !Array.isArray(record.response)
    ? record.response as Record<string, unknown>
    : undefined;
  const topHasCanonicalShape = typeof record.id === 'string'
    || Array.isArray(record.output)
    || (record.required_action && typeof record.required_action === 'object');
  if (topHasCanonicalShape || !nested) {
    return body;
  }
  return {
    ...(nested as Record<string, unknown>),
    ...(record.required_action
      ? { required_action: record.required_action }
      : {}),
  };
}

function resolveResponsesConversationRecordRequestIdsForHttp(args: {
  requestLabel: string;
  timingRequestIds?: string[];
  responseId?: unknown;
}): string[] {
  const responseIds: string[] = [];
  const requestIds: string[] = [];
  const add = (target: string[], value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || target.includes(trimmed)) return;
    target.push(trimmed);
  };
  add(responseIds, args.responseId);
  add(requestIds, args.requestLabel);
  if (Array.isArray(args.timingRequestIds)) {
    for (const id of args.timingRequestIds) add(requestIds, id);
  }
  return responseIds.length > 0 ? responseIds : requestIds;
}

function resolveResponsesConversationStaleRequestIdsForHttp(args: {
  requestLabel: string;
  timingRequestIds?: string[];
  canonicalRequestIds?: string[];
}): string[] {
  const staleRequestIds: string[] = [];
  const canonical = new Set(
    Array.isArray(args.canonicalRequestIds)
      ? args.canonicalRequestIds
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter(Boolean)
      : []
  );
  const add = (value: unknown): void => {
    if (typeof value !== 'string') {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed || canonical.has(trimmed) || staleRequestIds.includes(trimmed)) {
      return;
    }
    staleRequestIds.push(trimmed);
  };
  add(args.requestLabel);
  if (Array.isArray(args.timingRequestIds)) {
    for (const requestId of args.timingRequestIds) {
      add(requestId);
    }
  }
  return staleRequestIds;
}

function readResponsesToolDefinitionNameForHttp(tool: unknown): string | undefined {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
    return undefined;
  }
  const record = tool as Record<string, unknown>;
  const directName = typeof record.name === 'string' ? record.name.trim() : '';
  if (directName) {
    return directName;
  }
  const fn =
    record.function && typeof record.function === 'object' && !Array.isArray(record.function)
      ? record.function as Record<string, unknown>
      : undefined;
  const fnName = typeof fn?.name === 'string' ? fn.name.trim() : '';
  return fnName || undefined;
}

function buildMinimalResponsesToolDefinitionForHttp(name: string): Record<string, unknown> {
  return {
    type: 'function',
    name,
    parameters: { type: 'object' },
  };
}

function collectResponsesProjectedToolDefinitionsForHttp(body: unknown): unknown[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return [];
  }
  const record = body as Record<string, unknown>;
  const output = Array.isArray(record.output) ? record.output : [];
  const requiredAction =
    record.required_action && typeof record.required_action === 'object' && !Array.isArray(record.required_action)
      ? record.required_action as Record<string, unknown>
      : undefined;
  const submitToolOutputs =
    requiredAction?.submit_tool_outputs
    && typeof requiredAction.submit_tool_outputs === 'object'
    && !Array.isArray(requiredAction.submit_tool_outputs)
      ? requiredAction.submit_tool_outputs as Record<string, unknown>
      : undefined;
  const requiredToolCalls = Array.isArray(submitToolOutputs?.tool_calls) ? submitToolOutputs.tool_calls : [];
  const merged: unknown[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    if (row.type !== 'function_call') {
      continue;
    }
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name) {
      continue;
    }
    merged.push(buildMinimalResponsesToolDefinitionForHttp(name));
  }
  for (const item of requiredToolCalls) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const functionRecord =
      row.function && typeof row.function === 'object' && !Array.isArray(row.function)
        ? row.function as Record<string, unknown>
        : undefined;
    const name =
      (typeof functionRecord?.name === 'string' ? functionRecord.name.trim() : '')
      || (typeof row.name === 'string' ? row.name.trim() : '');
    if (!name) {
      continue;
    }
    merged.push(buildMinimalResponsesToolDefinitionForHttp(name));
  }
  return merged;
}

function mergeResponsesToolDefinitionsForHttp(...sources: unknown[][]): unknown[] {
  const merged: unknown[] = [];
  const seenNames = new Set<string>();
  for (const source of sources) {
    if (!Array.isArray(source)) {
      continue;
    }
    for (const tool of source) {
      const name = readResponsesToolDefinitionNameForHttp(tool);
      if (name) {
        if (seenNames.has(name)) {
          continue;
        }
        seenNames.add(name);
      }
      merged.push(tool);
    }
  }
  return merged;
}

function buildPersistResponsesRequestContextForHttp(
  requestContext: ResponsesRequestContextForHttp | undefined,
  canonicalBody: unknown,
): ResponsesRequestContextForHttp | undefined {
  if (!requestContext) {
    return undefined;
  }
  const payloadTools = Array.isArray(requestContext.payload?.tools) ? requestContext.payload.tools : [];
  const contextTools = Array.isArray(requestContext.context?.toolsRaw) ? requestContext.context.toolsRaw : [];
  const contextClientTools = Array.isArray(requestContext.context?.clientToolsRaw)
    ? requestContext.context.clientToolsRaw
    : [];
  const responseDeltaTools = collectResponsesProjectedToolDefinitionsForHttp(canonicalBody);
  const mergedTools = mergeResponsesToolDefinitionsForHttp(
    payloadTools,
    contextTools,
    contextClientTools,
    responseDeltaTools,
  );
  if (mergedTools.length <= 0) {
    return requestContext;
  }
  return {
    ...requestContext,
    payload: {
      ...requestContext.payload,
      tools: mergedTools,
    },
    context: {
      ...requestContext.context,
      ...(Array.isArray(requestContext.context?.clientToolsRaw)
        ? { clientToolsRaw: requestContext.context.clientToolsRaw }
        : {}),
      toolsRaw: mergedTools,
    },
  };
}

function shouldPersistResponsesToolCallContinuationRecordForHttp(
  entryEndpoint: string | undefined,
  requestContext?: ResponsesRequestContextForHttp,
): boolean {
  if (entryEndpoint === '/v1/responses.submit_tool_outputs') {
    return true;
  }
  return entryEndpoint === '/v1/responses';
}

type PersistResponsesConversationLifecycleForHttpArgs = {
  entryEndpoint?: string;
  requestLabel: string;
  timingRequestIds?: string[];
  providerKey?: string;
  continuationOwner?: 'direct' | 'relay';
  sessionId?: unknown;
  conversationId?: unknown;
  usageLogInfo?: {
    providerKey?: string;
    timingRequestIds?: string[];
    sessionId?: unknown;
    conversationId?: unknown;
  };
  metadata?: Record<string, unknown>;
  requestContext?: ResponsesRequestContextForHttp;
  body: unknown;
  onTrace?: (stage: string, details?: Record<string, unknown>) => void;
  onNonBlockingError?: (operation: string, error: unknown) => void;
};

export type PersistResponsesConversationLifecycleResultForHttp =
  | { recorded: true; responseId: string }
  | { recorded: false; reason: 'not_responses_endpoint' | 'not_continuation' | 'missing_response_id' | 'no_recorded_request_context' };

function parseResponsesLifecycleSseFrameForHttp(frame: string): Record<string, unknown> | undefined {
  const lines = frame.split(/\r?\n/);
  const eventName = lines
    .find((line) => line.startsWith('event:'))
    ?.slice('event:'.length)
    .trim();
  if (eventName !== 'response.completed' && eventName !== 'response.done') {
    return undefined;
  }
  const dataText = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
    .join('\n')
    .trim();
  if (!dataText || dataText === '[DONE]') {
    return undefined;
  }
  try {
    const data = JSON.parse(dataText) as Record<string, unknown>;
    const response =
      data.response && typeof data.response === 'object' && !Array.isArray(data.response)
        ? data.response as Record<string, unknown>
        : data;
    return response && typeof response === 'object' && !Array.isArray(response)
      ? response
      : undefined;
  } catch {
    return undefined;
  }
}

export function attachResponsesConversationLifecycleStreamForHttp(args: {
  stream: Readable;
  entryEndpoint?: string;
  requestLabel: string;
  usageLogInfo?: PersistResponsesConversationLifecycleForHttpArgs['usageLogInfo'];
  metadata?: Record<string, unknown>;
  requestContext?: ResponsesRequestContextForHttp;
  onTrace?: (stage: string, details?: Record<string, unknown>) => void;
  onNonBlockingError?: (operation: string, error: unknown) => void;
}): Readable {
  if (
    args.entryEndpoint !== '/v1/responses'
    && args.entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) {
    return args.stream;
  }
  let pending = '';
  let finalResponse: Record<string, unknown> | undefined;

  const inspectFrames = (text: string): void => {
    pending += text;
    let boundary = /\r?\n\r?\n/.exec(pending);
    while (boundary) {
      const frameEnd = boundary.index + boundary[0].length;
      const frame = pending.slice(0, frameEnd);
      pending = pending.slice(frameEnd);
      const response = parseResponsesLifecycleSseFrameForHttp(frame);
      if (response) {
        finalResponse = response;
      }
      boundary = /\r?\n\r?\n/.exec(pending);
    }
  };
  const persistFinalResponse = async (): Promise<void> => {
    if (pending.trim()) {
      const response = parseResponsesLifecycleSseFrameForHttp(`${pending}\n\n`);
      if (response) {
        finalResponse = response;
      }
      pending = '';
    }
    if (!finalResponse) {
      args.onTrace?.('stream_lifecycle.skip_no_final_response', {
        entryEndpoint: args.entryEndpoint,
      });
      return;
    }
    await persistResponsesConversationLifecycleForHttp({
      entryEndpoint: args.entryEndpoint,
      requestLabel: args.requestLabel,
      usageLogInfo: args.usageLogInfo,
      metadata: args.metadata,
      requestContext: args.requestContext,
      body: stripInternalKeysDeep(finalResponse),
      onTrace: (stage, details) => args.onTrace?.(`stream_lifecycle.${stage}`, details),
      onNonBlockingError: args.onNonBlockingError,
    });
  };
  const lifecycleTransform = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const text = typeof chunk === 'string'
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString('utf8')
            : chunk instanceof Uint8Array
              ? Buffer.from(chunk).toString('utf8')
              : String(chunk ?? '');
        if (text) {
          inspectFrames(text);
        }
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      persistFinalResponse()
        .then(() => callback())
        .catch((error) => {
          args.onNonBlockingError?.(`responses-conversation-stream-lifecycle:${args.requestLabel}`, error);
          callback();
        });
    },
  });
  return args.stream.pipe(lifecycleTransform);
}

function resolveResponsesConversationPersistInputsForHttp(
  args: PersistResponsesConversationLifecycleForHttpArgs,
): {
  timingRequestIds: string[] | undefined;
  providerKey: string | undefined;
  continuationOwner: 'direct' | 'relay';
  sessionId: string | undefined;
  conversationId: string | undefined;
} {
  const timingRequestIds =
    Array.isArray(args.timingRequestIds) && args.timingRequestIds.length > 0
      ? args.timingRequestIds
      : Array.isArray(args.usageLogInfo?.timingRequestIds) && args.usageLogInfo.timingRequestIds.length > 0
        ? args.usageLogInfo.timingRequestIds
        : undefined;
  const providerKey =
    typeof args.providerKey === 'string' && args.providerKey.trim()
      ? args.providerKey.trim()
      : deriveResponsesConversationProviderKeyForHttp(args.usageLogInfo);
  const metadataCenterContinuation = readMetadataCenterContinuationContextForHttp(args.metadata);
  const metadataCenterOwner =
    metadataCenterContinuation.continuationOwner === 'direct' || metadataCenterContinuation.continuationOwner === 'relay'
      ? metadataCenterContinuation.continuationOwner
      : undefined;
  const continuationOwner = args.continuationOwner ?? metadataCenterOwner ?? 'relay';
  const requestTruth = readRuntimeRequestTruthIdentifiers(args.metadata);
  const sessionId =
    typeof args.sessionId === 'string' && args.sessionId.trim()
      ? args.sessionId.trim()
      : typeof args.usageLogInfo?.sessionId === 'string' && args.usageLogInfo.sessionId.trim()
        ? args.usageLogInfo.sessionId.trim()
        : requestTruth.sessionId
          ? requestTruth.sessionId
        : undefined;
  const conversationId =
    typeof args.conversationId === 'string' && args.conversationId.trim()
      ? args.conversationId.trim()
      : typeof args.usageLogInfo?.conversationId === 'string' && args.usageLogInfo.conversationId.trim()
        ? args.usageLogInfo.conversationId.trim()
        : requestTruth.conversationId
          ? requestTruth.conversationId
        : undefined;
  return {
    timingRequestIds,
    providerKey,
    continuationOwner,
    sessionId,
    conversationId,
  };
}

export async function persistResponsesConversationLifecycleForHttp(
  args: PersistResponsesConversationLifecycleForHttpArgs,
): Promise<PersistResponsesConversationLifecycleResultForHttp> {
  if (
    args.entryEndpoint !== '/v1/responses'
    && args.entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) {
    return { recorded: false, reason: 'not_responses_endpoint' };
  }

  const responseId = readResponsesConversationResponseIdForHttp(args.body);
  const canonicalBody = normalizeResponsesConversationPersistBodyForHttp(args.body);
  const finishReason = deriveFinishReason(canonicalBody);
  const isContinuation = isToolCallContinuationResponseForHttp(canonicalBody);
  const persisted = resolveResponsesConversationPersistInputsForHttp(args);
  const isToolCallFinish = finishReason === 'tool_calls';
  const persistRequestContext = buildPersistResponsesRequestContextForHttp(
    args.requestContext,
    canonicalBody,
  );
  if (RESPONSES_DEBUG) {
    console.log('[responses-bridge] persist.lifecycle', JSON.stringify({
      requestLabel: args.requestLabel,
      entryEndpoint: args.entryEndpoint,
      responseId,
      finishReason,
      isContinuation,
      isToolCallFinish,
      requestContextPayloadTools: summarizeDebugToolsForHttp(args.requestContext?.payload?.tools),
      requestContextToolsRaw: summarizeDebugToolsForHttp(args.requestContext?.context?.toolsRaw),
      persistPayloadTools: summarizeDebugToolsForHttp(persistRequestContext?.payload?.tools),
      persistToolsRaw: summarizeDebugToolsForHttp(persistRequestContext?.context?.toolsRaw),
      persistSessionId: persistRequestContext?.sessionId,
      persistConversationId: persistRequestContext?.conversationId,
      matchedPort: persistRequestContext?.matchedPort,
      routingPolicyGroup: persistRequestContext?.routingPolicyGroup,
    }));
  }

  if (
    (isContinuation || isToolCallFinish)
    && shouldPersistResponsesToolCallContinuationRecordForHttp(args.entryEndpoint, args.requestContext)
    && canonicalBody
    && typeof canonicalBody === 'object'
    && !Array.isArray(canonicalBody)
    ) {
      if (!responseId) {
        args.onTrace?.('record.skip_missing_response_id', {
          providerKey: args.providerKey,
        });
        return { recorded: false, reason: 'missing_response_id' };
      }
    args.onTrace?.('capture.start', {
      responseId,
      providerKey: args.providerKey,
    });
    const captureRequestIds = resolveResponsesConversationRecordRequestIdsForHttp({
      requestLabel: args.requestLabel,
      timingRequestIds: persisted.timingRequestIds,
      responseId,
    });
    if (persistRequestContext) {
      for (const requestId of captureRequestIds) {
        await captureResponsesRequestContextForHttpProjection({
          requestId,
          payload: persistRequestContext.payload,
          context: persistRequestContext.context,
          sessionId: persistRequestContext.sessionId,
          conversationId: persistRequestContext.conversationId,
          providerKey: persisted.providerKey,
          matchedPort: persistRequestContext.matchedPort,
          routingPolicyGroup: persistRequestContext.routingPolicyGroup,
        }).catch((error) => {
          args.onTrace?.('capture.error', {
            captureRequestId: requestId,
            responseId,
            message: error instanceof Error ? error.message : String(error ?? 'unknown'),
          });
          args.onNonBlockingError?.(`responses-conversation-capture:${requestId}`, error);
        });
      }
    }

    let recordedRequestId: string | undefined;
    try {
      await recordResponsesResponseForHttpProjection({
        requestId: responseId,
        response: canonicalBody as AnyRecord,
        sessionId: persisted.sessionId ?? persistRequestContext?.sessionId,
        conversationId: persisted.conversationId ?? persistRequestContext?.conversationId,
        providerKey: persisted.providerKey,
        continuationOwner: persisted.continuationOwner,
        matchedPort: persistRequestContext?.matchedPort,
        routingPolicyGroup: persistRequestContext?.routingPolicyGroup,
      });
      recordedRequestId = responseId;
    } catch (error) {
      args.onTrace?.('record.error', {
        recordRequestId: responseId,
        responseId,
        message: error instanceof Error ? error.message : String(error ?? 'unknown'),
      });
      args.onNonBlockingError?.(`responses-conversation-record:${responseId}`, error);
    }

    if (!recordedRequestId) {
      args.onTrace?.('record.skipped_no_context', {
        responseId,
        attemptedRequestIds: [responseId],
      });
      return { recorded: false, reason: 'no_recorded_request_context' };
    }

    await finalizeResponsesConversationRequestRetentionForHttp(recordedRequestId, {
      keepForSubmitToolOutputs: true,
    }).catch((error) => {
      args.onTrace?.('record.finalize_error', {
        retainRequestId: recordedRequestId,
        responseId,
        message: error instanceof Error ? error.message : String(error ?? 'unknown'),
      });
      args.onNonBlockingError?.(`responses-conversation-finalize:${recordedRequestId}`, error);
    });

    const staleRequestIds = resolveResponsesConversationStaleRequestIdsForHttp({
      requestLabel: args.requestLabel,
      timingRequestIds: persisted.timingRequestIds,
      canonicalRequestIds: [recordedRequestId],
    });
    for (const staleRequestId of staleRequestIds) {
      await clearResponsesConversationByRequestIdForHttpProjection(staleRequestId).catch((error) => {
        args.onTrace?.('record.clear_stale_error', {
          staleRequestId,
          responseId,
          message: error instanceof Error ? error.message : String(error ?? 'unknown'),
        });
        args.onNonBlockingError?.(`responses-conversation-clear-stale:${staleRequestId}`, error);
      });
    }

    args.onTrace?.('record.done', { responseId, retainedRequestIds: [recordedRequestId] });
    return { recorded: true, responseId };
  }

  if (isContinuation || isToolCallFinish) {
    return { recorded: false, reason: 'not_continuation' };
  }

  const retainRequestIds = resolveResponsesConversationRecordRequestIdsForHttp({
    requestLabel: args.requestLabel,
    timingRequestIds: persisted.timingRequestIds,
    responseId,
  });
  for (const retainRequestId of retainRequestIds) {
    await finalizeResponsesConversationRequestRetentionForHttp(retainRequestId, {
      keepForSubmitToolOutputs: false,
    }).catch((error) => {
      args.onNonBlockingError?.(`responses-conversation-finalize:${retainRequestId}`, error);
    });
  }
  const staleRequestIds = resolveResponsesConversationStaleRequestIdsForHttp({
    requestLabel: args.requestLabel,
    timingRequestIds: persisted.timingRequestIds,
    canonicalRequestIds: retainRequestIds,
  });
  for (const staleRequestId of staleRequestIds) {
    await clearResponsesConversationByRequestIdForHttpProjection(staleRequestId).catch((error) => {
      args.onNonBlockingError?.(`responses-conversation-clear-stale:${staleRequestId}`, error);
    });
  }
  return { recorded: false, reason: 'not_continuation' };
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
    await clearResponsesConversationByRequestIdForHttpProjection(requestId).catch((error) => {
      args.onNonBlockingError?.(`responses-conversation-clear-${args.reason}:${requestId}`, error);
    });
  }
}

function deriveResponsesConversationProviderKeyForHttp(usageLogInfo?: {
  providerKey?: string;
  timingRequestIds?: string[];
}): string | undefined {
  const direct = typeof usageLogInfo?.providerKey === 'string' ? usageLogInfo.providerKey.trim() : '';
  if (direct) return direct;
  const ids = Array.isArray(usageLogInfo?.timingRequestIds) ? usageLogInfo.timingRequestIds : [];
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    const match = id.match(/^openai-responses-(.+)-\d{8}T\d{9}-\d+-\d+$/);
    if (!match) continue;
    const normalized = match[1].replace(/-/g, '.');
    if (normalized) return normalized;
  }
  return undefined;
}

export async function finalizeResponsesConversationRequestRetentionForHttp(
  requestId?: string,
  options?: { keepForSubmitToolOutputs?: boolean }
): Promise<void> {
  await finalizeResponsesConversationRequestRetention(requestId, options);
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

export async function projectResponsesClientPayloadForClientForHttp(args: {
  payload: unknown;
  toolsRaw: unknown[];
  metadata?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  return stripClientVisibleMetadataDeep(await projectResponsesClientPayloadForClientNative(args));
}

function readResponsesClientToolsRawForHttp(requestContext?: {
  payload: AnyRecord;
  context: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  matchedPort?: number;
  routingPolicyGroup?: string;
}): unknown[] {
  const payloadTools = Array.isArray(requestContext?.payload?.tools) ? requestContext.payload.tools : undefined;
  if (payloadTools?.length) {
    return payloadTools;
  }
  const contextTools = Array.isArray(requestContext?.context?.toolsRaw) ? requestContext.context.toolsRaw : undefined;
  if (contextTools?.length) {
    return contextTools;
  }
  const contextClientTools = Array.isArray(requestContext?.context?.clientToolsRaw)
    ? requestContext.context.clientToolsRaw
    : undefined;
  return contextClientTools?.length ? contextClientTools : [];
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
  const projectedPayload = await projectResponsesClientPayloadForClientForHttp({
    payload: args.payload,
    toolsRaw: readResponsesClientToolsRawForHttp(args.requestContext),
    metadata: args.metadata,
  });
  return ensureResponsesJsonToSseRequiredFieldsForHttp({
    payload: projectedPayload,
    requestContext: args.requestContext,
  });
}

export function resolveResponsesClientPayloadFinishReasonForHttp(payload: unknown): string | undefined {
  return deriveFinishReason(payload);
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
  finishReason?: string;
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
    finishReason: resolveResponsesClientPayloadFinishReasonForHttp(clientBody),
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
