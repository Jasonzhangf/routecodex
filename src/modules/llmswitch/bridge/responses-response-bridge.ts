/**
 * /v1/responses response-side handler bridge surface.
 *
 * Single projection-facing bridge entry for responses SSE/JSON projection and
 * continuation lifecycle writes on the response path.
 */

// feature_id: server.responses_response_handler_bridge_surface
// canonical_builders: hasResponsesSsePayloadForHttp, shouldDispatchResponsesSseToClientForHttp, resolveResponsesRequestContextForHttp, assertDirectPassthroughResponsesSseMetadataIsolationForHttp, updateResponsesContractProbeFromSseChunkForHttp, inspectResponsesTerminalStateFromSseChunkForHttp, summarizeResponsesSseFrameForLogForHttp, resolveResponsesProviderProtocolHintFromSseFrameForHttp, buildResponsesTerminalSseFramesFromProbeForHttp, isToolCallContinuationResponseForHttp, inspectResponsesContinuationProbeForHttp, planResponsesContinuationCloseActionForHttp, shouldRepairResponsesContinuationTerminalForHttp, planResponsesStreamEndRepairForHttp, buildResponsesSseErrorPayloadForHttp, buildResponsesStructuredSseErrorPayloadForHttp, buildResponsesMissingSseBridgeErrorPayloadForHttp, buildResponsesStreamIncompleteErrorPayloadForHttp, prepareResponsesJsonBodyForSseBridgeForHttp, rebindResponsesConversationRequestIdForHttp, clearResponsesConversationByRequestIdForHttpProjection, recordResponsesResponseForHttpProjection, finalizeResponsesConversationRequestRetentionForHttp, createResponsesJsonToSseConverterForHttp, normalizeResponsesJsonBodyForHttp, buildResponsesPayloadFromChatForHttp, projectResponsesClientPayloadForClientForHttp, projectResponsesSseFrameForClientForHttp

import type { AnyRecord } from './module-loader.js';
import {
  buildResponsesTerminalSseFramesFromProbeNative,
  createResponsesJsonToSseConverter,
  importCoreDist,
  isToolCallContinuationResponseNative,
  rebindResponsesConversationRequestId,
  requireCoreDist,
  updateResponsesContractProbeFromSseChunkNative,
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
  projectResponsesSseFrameForClientNative,
} from './native-exports.js';
import { deriveFinishReason } from '../../../server/utils/finish-reason.js';
import { normalizeUsage } from '../../../server/runtime/http-server/executor/usage-aggregator.js';
import { stripInternalKeysDeep } from '../../../utils/strip-internal-keys.js';

const RESPONSES_DIRECT_PASSTHROUGH_ALLOWED_EVENTS: ReadonlySet<string> = new Set([
  'error',
  'ping',
  'response.queued',
  'response.created',
  'response.in_progress',
  'response.incomplete',
  'response.completed',
  'response.failed',
  'response.cancelled',
  'response.done',
  'response.output_item.added',
  'response.output_item.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.output_text.annotation.added',
  'response.output_text.delta',
  'response.output_text.done',
  'response.audio.delta',
  'response.audio.done',
  'response.audio.transcript.delta',
  'response.audio.transcript.done',
  'response.refusal.delta',
  'response.refusal.done',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.custom_tool_call_input.delta',
  'response.custom_tool_call_input.done',
  'response.code_interpreter_call.in_progress',
  'response.code_interpreter_call.interpreting',
  'response.code_interpreter_call.completed',
  'response.code_interpreter_call_code.delta',
  'response.code_interpreter_call_code.done',
  'response.file_search_call.in_progress',
  'response.file_search_call.searching',
  'response.file_search_call.completed',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
  'response.reasoning.delta',
  'response.reasoning.done',
  'response.web_search_call.in_progress',
  'response.web_search_call.searching',
  'response.web_search_call.completed',
  'response.image_generation_call.in_progress',
  'response.image_generation_call.generating',
  'response.image_generation_call.partial_image',
  'response.image_generation_call.completed',
  'response.mcp_call.in_progress',
  'response.mcp_call_arguments.delta',
  'response.mcp_call_arguments.done',
  'response.mcp_call.completed',
  'response.mcp_call.failed',
  'response.mcp_list_tools.in_progress',
  'response.mcp_list_tools.completed',
  'response.mcp_list_tools.failed',
]);

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
  const metadata = args.metadata;
  const fromMetadata =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).responsesRequestContext
      : undefined;
  if (fromMetadata && typeof fromMetadata === 'object' && !Array.isArray(fromMetadata)) {
    return fromMetadata as ResponsesRequestContextForHttp;
  }
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

export function hasResponsesSsePayloadForHttp(body: unknown): body is { __sse_responses?: unknown } {
  return Boolean(body && typeof body === 'object' && '__sse_responses' in (body as Record<string, unknown>));
}

export function buildResponsesRequestLogContextForHttp(args: {
  metadata?: unknown;
  usageLogInfo?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const metadata = asRecordForHttp(args.metadata);
  const usageLogInfo = asRecordForHttp(args.usageLogInfo);
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
    sessionId: usageLogInfo.sessionId ?? metadata.sessionId,
    session_id: usageLogInfo.session_id ?? metadata.session_id,
    conversationId: usageLogInfo.conversationId ?? metadata.conversationId,
    conversation_id: usageLogInfo.conversation_id ?? metadata.conversation_id
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
  if ('__sse_responses' in record) {
    return { payload: body, normalized: false };
  }
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
  if (!hasResponsesSsePayloadForHttp(args.body)) {
    return false;
  }
  if (args.forceSSE) {
    return true;
  }
  const metadata = args.metadata;
  return metadata?.outboundStream === true || metadata?.stream === true;
}

type InspectResponsesTerminalStateFromSseChunkForHttpInput = {
  chunk: unknown;
  finishReason?: string;
  seenTerminalEvent?: boolean;
  sawTerminalChunk?: boolean;
  sawResponsesCompletedChunk?: boolean;
  sawResponsesDoneEvent?: boolean;
  sawAssistantMessageDoneTerminal?: boolean;
  requiresResponsesTerminalEvent?: boolean;
  terminalSource?: string;
  pendingTerminalEvent?: 'response.completed' | 'response.done' | 'response.error' | 'response.cancelled' | 'response.failed';
};

type InspectResponsesTerminalStateFromSseChunkForHttpResult = {
  finishReason?: string;
  seenTerminalEvent: boolean;
  sawTerminalChunk: boolean;
  sawResponsesCompletedChunk: boolean;
  sawResponsesDoneEvent: boolean;
  sawAssistantMessageDoneTerminal: boolean;
  requiresResponsesTerminalEvent: boolean;
  terminalSource?: string;
  pendingTerminalEvent?: 'response.completed' | 'response.done' | 'response.error' | 'response.cancelled' | 'response.failed';
};

function isResponsesRequiredActionFrame(frame: string): boolean {
  return frame.split(/\r?\n/).some((line) => {
    if (!line.startsWith('data:')) {
      return false;
    }
    const data = line.slice('data:'.length).trim();
    if (!data || data === '[DONE]') {
      return false;
    }
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      return parsed.type === 'response.required_action';
    } catch {
      return false;
    }
  });
}

export function buildClientSseKeepaliveFrameForHttp(entryEndpoint?: string): string {
  const commentFrame = ': keepalive\n\n';
  if (
    entryEndpoint === '/v1/responses'
    || entryEndpoint === '/v1/responses.submit_tool_outputs'
  ) {
    return `${commentFrame}event: ping\ndata: {"type":"ping"}\n\n`;
  }
  return commentFrame;
}

export function shouldDropClientSseFrameForHttp(frame: string, entryEndpoint?: string): boolean {
  return (
    (entryEndpoint === '/v1/responses' || entryEndpoint === '/v1/responses.submit_tool_outputs') &&
    frame.trim() === 'data: [DONE]'
  );
}

export function isDirectPassthroughTransportKeepaliveFrameForHttp(frame: string): boolean {
  const trimmed = frame.trim();
  if (!trimmed) {
    return false;
  }
  const lines = trimmed.split(/\r?\n/);
  const eventNames = lines
    .filter((line) => line.startsWith('event:'))
    .map((line) => line.slice('event:'.length).trim())
    .filter(Boolean);
  if (eventNames.length !== 1 || eventNames[0] !== 'keepalive') {
    return false;
  }
  return lines.every((line) => !line || line.startsWith('event:') || line.startsWith('data:') || line.startsWith(':'));
}

export function assertDirectPassthroughResponsesSseFrameForHttp(frame: string, requestId: string): void {
  const eventNames = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('event:'))
    .map((line) => line.slice('event:'.length).trim())
    .filter(Boolean);
  for (const eventName of eventNames) {
    if (!RESPONSES_DIRECT_PASSTHROUGH_ALLOWED_EVENTS.has(eventName)) {
      throw Object.assign(
        new Error(`[server.response_projection] direct passthrough SSE emitted non-Responses event "${eventName}" (requestId=${requestId})`),
        { code: 'RESPONSES_DIRECT_SSE_PROTOCOL_VIOLATION' }
      );
    }
  }
  if (isDirectPassthroughTransportKeepaliveFrameForHttp(frame)) {
    return;
  }
  if (isResponsesRequiredActionFrame(frame)) {
    throw Object.assign(
      new Error(`[server.response_projection] direct passthrough SSE must not rewrite response.required_action into output_item/function_call frames (requestId=${requestId})`),
      { code: 'RESPONSES_DIRECT_SSE_PROTOCOL_VIOLATION' }
    );
  }
}

function isInternalMetadataCarrierForHttp(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).some(
    (key) => key.startsWith('__routecodex') || key.startsWith('__rt') || key === 'providerKey'
  );
}

export function assertDirectPassthroughResponsesSseMetadataIsolationForHttp(frame: string, requestId: string): void {
  assertDirectPassthroughResponsesSseFrameForHttp(frame, requestId);
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith('data:')) {
      continue;
    }
    const dataText = line.slice(5).trim();
    if (!dataText || dataText === '[DONE]') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataText);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      continue;
    }
    const stack: unknown[] = [parsed];
    const seen = new WeakSet<object>();
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        continue;
      }
      if (seen.has(current as object)) {
        continue;
      }
      seen.add(current as object);
      const record = current as Record<string, unknown>;
      const metadata = record.metadata;
      if (metadata !== undefined) {
        if (isInternalMetadataCarrierForHttp(metadata)) {
          throw new Error(
            `[server.response_projection] direct passthrough SSE metadata contains internal control fields (requestId=${requestId})`
          );
        }
        if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
          stack.push(metadata);
        }
      }
      for (const [key, value] of Object.entries(record)) {
        if (key === 'metadata') {
          continue;
        }
        if (key === 'metaCarrier' || key === 'runtimeMetadata' || key === 'errorCarrier' || key === '__rt') {
          throw new Error(
            `[server.response_projection] client response contains internal carrier field "${key}" (requestId=${requestId})`
          );
        }
        if (value && typeof value === 'object') {
          stack.push(value);
        }
      }
    }
  }
}

export function updateResponsesContractProbeFromSseChunkForHttp(
  chunk: unknown,
  probe?: Record<string, unknown>
): Record<string, unknown> | undefined {
  return updateResponsesContractProbeFromSseChunkNative(chunk, probe);
}

export function inspectResponsesTerminalStateFromSseChunkForHttp(
  input: InspectResponsesTerminalStateFromSseChunkForHttpInput,
): InspectResponsesTerminalStateFromSseChunkForHttpResult {
  const result: InspectResponsesTerminalStateFromSseChunkForHttpResult = {
    finishReason: input.finishReason,
    seenTerminalEvent: input.seenTerminalEvent === true,
    sawTerminalChunk: input.sawTerminalChunk === true,
    sawResponsesCompletedChunk: input.sawResponsesCompletedChunk === true,
    sawResponsesDoneEvent: input.sawResponsesDoneEvent === true,
    sawAssistantMessageDoneTerminal: input.sawAssistantMessageDoneTerminal === true,
    requiresResponsesTerminalEvent: input.requiresResponsesTerminalEvent === true,
    terminalSource:
      typeof input.terminalSource === 'string' && input.terminalSource.trim()
        ? input.terminalSource.trim()
        : undefined,
    pendingTerminalEvent: input.pendingTerminalEvent,
  };
  const text =
    typeof input.chunk === 'string'
      ? input.chunk
      : Buffer.isBuffer(input.chunk)
        ? input.chunk.toString('utf8')
        : input.chunk instanceof Uint8Array
          ? Buffer.from(input.chunk).toString('utf8')
          : '';
  if (!text) {
    return result;
  }

  if (text.includes('data: [DONE]') && !result.requiresResponsesTerminalEvent) {
    result.seenTerminalEvent = true;
    result.sawTerminalChunk = true;
    result.terminalSource = result.terminalSource ?? '[DONE]';
  }

  const blocks = text.split(/\n\n+/);
  for (const block of blocks) {
    if (!block) {
      continue;
    }
    const lines = block.split(/\n/);
    const eventName = lines
      .filter((line) => line.startsWith('event:'))
      .map((line) => line.slice('event:'.length).trim())
      .find(Boolean);
    if (
      eventName === 'response.completed'
      || eventName === 'response.done'
      || eventName === 'response.failed'
      || eventName === 'response.error'
      || eventName === 'response.cancelled'
    ) {
      result.pendingTerminalEvent = eventName;
    }
    const dataText = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .join('\n');
    if (!dataText || dataText === '[DONE]') {
      continue;
    }
    try {
      const parsed = JSON.parse(dataText) as unknown;
      const parsedType =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (typeof (parsed as Record<string, unknown>).type === 'string'
            ? ((parsed as Record<string, unknown>).type as string).trim()
            : '')
          : '';
      const parsedItem =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? ((parsed as Record<string, unknown>).item as Record<string, unknown> | undefined)
          : undefined;
      if (
        parsedType === 'response.completed'
        || parsedType === 'response.done'
        || parsedType === 'response.failed'
        || parsedType === 'response.error'
        || parsedType === 'response.cancelled'
      ) {
        result.pendingTerminalEvent = parsedType as InspectResponsesTerminalStateFromSseChunkForHttpResult['pendingTerminalEvent'];
      }
      const derived = deriveFinishReason(parsed);
      if (!derived) {
        const itemType = typeof parsedItem?.type === 'string' ? parsedItem.type.trim() : '';
        const itemRole = typeof parsedItem?.role === 'string' ? parsedItem.role.trim() : '';
        const itemStatus = typeof parsedItem?.status === 'string' ? parsedItem.status.trim().toLowerCase() : '';
        if (
          parsedType === 'response.output_item.done'
          && itemType === 'message'
          && itemRole === 'assistant'
          && itemStatus === 'completed'
        ) {
          result.sawTerminalChunk = true;
          result.sawAssistantMessageDoneTerminal = true;
          result.terminalSource = result.terminalSource ?? parsedType;
        }
        continue;
      }
      result.finishReason = derived;
      if (parsedType === 'response.completed') {
        result.sawResponsesCompletedChunk = true;
      }
      if (parsedType === 'response.done') {
        result.sawResponsesDoneEvent = true;
      }
      const trueTerminal =
        parsedType === 'response.completed'
        || parsedType === 'response.done'
        || parsedType === 'response.error'
        || parsedType === 'response.cancelled'
        || parsedType === 'response.failed';
      if (trueTerminal) {
        result.seenTerminalEvent = true;
        result.sawTerminalChunk = true;
        result.terminalSource = result.terminalSource ?? eventName ?? parsedType;
      }
      if (
        parsedType === 'response.output_item.done'
        && typeof parsedItem?.type === 'string'
        && parsedItem.type.trim() === 'message'
        && typeof parsedItem?.role === 'string'
        && parsedItem.role.trim() === 'assistant'
        && typeof parsedItem?.status === 'string'
        && parsedItem.status.trim().toLowerCase() === 'completed'
      ) {
        result.sawTerminalChunk = true;
        result.sawAssistantMessageDoneTerminal = true;
        result.terminalSource = result.terminalSource ?? parsedType;
      }
    } catch {
      // ignore parse failure; terminal event scanning below still applies
    }
  }

  for (const block of blocks) {
    if (!block) {
      continue;
    }
    const lines = block.split(/\n/);
    const eventName = lines
      .filter((line) => line.startsWith('event:'))
      .map((line) => line.slice('event:'.length).trim())
      .find((name) => name === 'response.completed' || name === 'response.done' || name === 'response.failed' || name === 'response.error' || name === 'response.cancelled');
    const effectiveTerminalEvent = (eventName ?? result.pendingTerminalEvent ?? undefined) as string | undefined;
    if (!effectiveTerminalEvent) {
      continue;
    }
    if (!eventName) {
      result.pendingTerminalEvent = undefined;
    }
    const dataText = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .join('\n');
    let derived = result.finishReason;
    if (dataText && dataText !== '[DONE]') {
      try {
        const parsed = JSON.parse(dataText) as unknown;
        derived = deriveFinishReason(parsed) ?? derived;
      } catch {
        // ignore parse failure; terminal event itself is enough
      }
    }
    if (effectiveTerminalEvent === 'response.completed') {
      result.sawResponsesCompletedChunk = true;
    }
    if (effectiveTerminalEvent === 'response.done') {
      result.sawResponsesDoneEvent = true;
    }
    const trueTerminal =
      effectiveTerminalEvent === 'response.completed'
      || effectiveTerminalEvent === 'response.done'
      || effectiveTerminalEvent === 'response.error'
      || effectiveTerminalEvent === 'response.cancelled'
      || effectiveTerminalEvent === 'response.failed';
    if (trueTerminal) {
      result.seenTerminalEvent = true;
      result.sawTerminalChunk = true;
    }
    result.finishReason = derived ?? result.finishReason;
    result.terminalSource = effectiveTerminalEvent;
    result.pendingTerminalEvent = undefined;
  }

  return result;
}

export function summarizeResponsesSseFrameForLogForHttp(frame: string): Record<string, unknown> | null {
  const lines = frame.split(/\r?\n/);
  const eventName = lines.find((line) => line.startsWith('event:'))?.slice('event:'.length).trim();
  const dataText = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('\n');
  const summary: Record<string, unknown> = {};
  if (eventName) {
    summary.event = eventName;
  }
  if (!dataText || dataText === '[DONE]') {
    if (dataText === '[DONE]') {
      summary.done = true;
    }
    return Object.keys(summary).length > 0 ? summary : null;
  }
  try {
    const parsed = JSON.parse(dataText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      summary.dataKind = typeof parsed;
      return summary;
    }
    const record = parsed as Record<string, unknown>;
    const response =
      record.response && typeof record.response === 'object' && !Array.isArray(record.response)
        ? (record.response as Record<string, unknown>)
        : undefined;
    const requiredAction =
      (record.required_action && typeof record.required_action === 'object' && !Array.isArray(record.required_action)
        ? record.required_action
        : undefined)
      ?? (response?.required_action && typeof response.required_action === 'object' && !Array.isArray(response.required_action)
        ? response.required_action
        : undefined);
    const output =
      Array.isArray(record.output) ? record.output
      : Array.isArray(response?.output) ? response.output
      : [];
    const functionCallCount = output.filter((item) => {
      return item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).type === 'function_call';
    }).length;
    const requiredToolCalls =
      requiredAction
      && typeof requiredAction === 'object'
      && !Array.isArray(requiredAction)
      && typeof (requiredAction as Record<string, unknown>).submit_tool_outputs === 'object'
      && !Array.isArray((requiredAction as Record<string, unknown>).submit_tool_outputs)
      && Array.isArray(((requiredAction as Record<string, unknown>).submit_tool_outputs as Record<string, unknown>).tool_calls)
        ? (((requiredAction as Record<string, unknown>).submit_tool_outputs as Record<string, unknown>).tool_calls as unknown[]).length
        : undefined;
    if (typeof record.type === 'string') {
      summary.type = record.type;
    }
    if (typeof record.status === 'string') {
      summary.status = record.status;
    } else if (typeof response?.status === 'string') {
      summary.status = response.status;
    }
    if (typeof record.finish_reason === 'string') {
      summary.finishReason = record.finish_reason;
    } else if (typeof response?.finish_reason === 'string') {
      summary.finishReason = response.finish_reason;
    }
    if (requiredAction) {
      summary.hasRequiredAction = true;
    }
    if (requiredToolCalls !== undefined) {
      summary.requiredToolCalls = requiredToolCalls;
    }
    if (functionCallCount > 0) {
      summary.outputFunctionCalls = functionCallCount;
    }
    return Object.keys(summary).length > 0 ? summary : null;
  } catch {
    summary.dataParse = 'non_json';
    return summary;
  }
}

export function resolveResponsesProviderProtocolHintFromSseFrameForHttp(frame: string): string | undefined {
  if (/\bevent:\s*response\./.test(frame) || /"type"\s*:\s*"response\./.test(frame)) {
    return 'openai-responses';
  }
  if (/\bevent:\s*message_/.test(frame) || /"type"\s*:\s*"message_/.test(frame)) {
    return 'anthropic';
  }
  return undefined;
}

export function buildResponsesTerminalSseFramesFromProbeForHttp(
  probe: Record<string, unknown> | undefined,
  requestLabel: string
): string[] {
  return buildResponsesTerminalSseFramesFromProbeNative(probe, requestLabel);
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
} {
  if (
    args.entryEndpoint !== '/v1/responses'
    && args.entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) {
    return {
      isToolCallContinuation: false,
      hasRequiredAction: false,
    };
  }
  if (!args.probe || typeof args.probe !== 'object' || Array.isArray(args.probe)) {
    return {
      isToolCallContinuation: false,
      hasRequiredAction: false,
    };
  }
  const isToolCallContinuation = isToolCallContinuationResponseForHttp(args.probe);
  const probeRecord = args.probe as Record<string, unknown>;
  return {
    isToolCallContinuation,
    hasRequiredAction:
      isToolCallContinuation
      && Boolean(
        probeRecord.required_action
        && typeof probeRecord.required_action === 'object'
        && !Array.isArray(probeRecord.required_action)
      ),
  };
}

export function shouldPersistResponsesContinuationOnProbeUpdateForHttp(args: {
  entryEndpoint?: string;
  probe: unknown;
}): boolean {
  return inspectResponsesContinuationProbeForHttp(args).isToolCallContinuation;
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

export function planResponsesStreamEndRepairForHttp(args: {
  entryEndpoint?: string;
  probe: Record<string, unknown> | undefined;
  sawResponsesCompletedChunk: boolean;
  sawResponsesDoneEvent: boolean;
  sawTerminalEvent: boolean;
}): {
  shouldRepairTerminalFrames: boolean;
  shouldRepairContinuationTerminal: boolean;
  shouldProjectIncompleteError: boolean;
} {
  const shouldRepairTerminalFrames =
    !args.sawResponsesCompletedChunk || !args.sawResponsesDoneEvent;
  const shouldRepairContinuationTerminal =
    !args.sawTerminalEvent
    && shouldRepairResponsesContinuationTerminalForHttp({
      entryEndpoint: args.entryEndpoint,
      probe: args.probe,
    });
  return {
    shouldRepairTerminalFrames,
    shouldRepairContinuationTerminal,
    shouldProjectIncompleteError:
      !args.sawTerminalEvent && !shouldRepairContinuationTerminal,
  };
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

function resolveResponsesConversationRecordAttemptIdsForHttp(args: {
  requestLabel: string;
  timingRequestIds?: string[];
  responseId?: unknown;
}): string[] {
  const preferred = resolveResponsesConversationRecordRequestIdsForHttp(args);
  const combined = [...preferred];
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || combined.includes(trimmed)) return;
    combined.push(trimmed);
  };
  add(args.requestLabel);
  if (Array.isArray(args.timingRequestIds)) {
    for (const id of args.timingRequestIds) add(id);
  }
  return combined;
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
  const continuationOwner =
    args.continuationOwner
    ?? (args.metadata?.__routecodexDirectPassthrough === true ? 'direct' : 'relay');
  const sessionId =
    typeof args.sessionId === 'string' && args.sessionId.trim()
      ? args.sessionId.trim()
      : typeof args.usageLogInfo?.sessionId === 'string' && args.usageLogInfo.sessionId.trim()
        ? args.usageLogInfo.sessionId.trim()
        : undefined;
  const conversationId =
    typeof args.conversationId === 'string' && args.conversationId.trim()
      ? args.conversationId.trim()
      : typeof args.usageLogInfo?.conversationId === 'string' && args.usageLogInfo.conversationId.trim()
        ? args.usageLogInfo.conversationId.trim()
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
): Promise<void> {
  if (
    args.entryEndpoint !== '/v1/responses'
    && args.entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) {
    return;
  }

  const responseId = readResponsesConversationResponseIdForHttp(args.body);
  const finishReason = deriveFinishReason(args.body);
  const isContinuation = isToolCallContinuationResponseForHttp(args.body);
  const persisted = resolveResponsesConversationPersistInputsForHttp(args);
  const isToolCallFinish = finishReason === 'tool_calls';

  if (
    (isContinuation || isToolCallFinish)
    && shouldPersistResponsesToolCallContinuationRecordForHttp(args.entryEndpoint, args.requestContext)
    && args.body
    && typeof args.body === 'object'
    && !Array.isArray(args.body)
  ) {
    if (!responseId) {
      args.onTrace?.('record.skip_missing_response_id', {
        providerKey: args.providerKey,
      });
      return;
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
    if (args.requestContext) {
      for (const requestId of captureRequestIds) {
        await captureResponsesRequestContextForHttpProjection({
          requestId,
          payload: args.requestContext.payload,
          context: args.requestContext.context,
          sessionId: args.requestContext.sessionId,
          conversationId: args.requestContext.conversationId,
          providerKey: persisted.providerKey,
          matchedPort: args.requestContext.matchedPort,
          routingPolicyGroup: args.requestContext.routingPolicyGroup,
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

    const recordAttemptIds = resolveResponsesConversationRecordAttemptIdsForHttp({
      requestLabel: args.requestLabel,
      timingRequestIds: persisted.timingRequestIds,
      responseId,
    });
    let recordedRequestId: string | undefined;
    for (const requestId of recordAttemptIds) {
      try {
        await recordResponsesResponseForHttpProjection({
          requestId,
          response: args.body as AnyRecord,
          sessionId: persisted.sessionId ?? args.requestContext?.sessionId,
          conversationId: persisted.conversationId ?? args.requestContext?.conversationId,
          providerKey: persisted.providerKey,
          continuationOwner: persisted.continuationOwner,
          matchedPort: args.requestContext?.matchedPort,
          routingPolicyGroup: args.requestContext?.routingPolicyGroup,
        });
        recordedRequestId = requestId;
        break;
      } catch (error) {
        args.onTrace?.('record.error', {
          recordRequestId: requestId,
          responseId,
          message: error instanceof Error ? error.message : String(error ?? 'unknown'),
        });
        args.onNonBlockingError?.(`responses-conversation-record:${requestId}`, error);
      }
    }

    if (!recordedRequestId) {
      args.onTrace?.('record.skipped_no_context', {
        responseId,
        attemptedRequestIds: recordAttemptIds,
      });
      return;
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

    args.onTrace?.('record.done', { responseId, retainedRequestIds: [recordedRequestId] });
    return;
  }

  if (isContinuation || isToolCallFinish) {
    return;
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
}

export async function rebindResponsesConversationRequestIdsToResponseIdForHttp(args: {
  requestLabel: string;
  timingRequestIds?: string[];
  responseId?: string;
  onNonBlockingError?: (operation: string, error: unknown) => void;
}): Promise<void> {
  if (!args.responseId) {
    return;
  }
  const sourceIds: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || trimmed === args.responseId || sourceIds.includes(trimmed)) return;
    sourceIds.push(trimmed);
  };
  add(args.requestLabel);
  if (Array.isArray(args.timingRequestIds)) {
    for (const id of args.timingRequestIds) add(id);
  }
  for (const requestId of sourceIds) {
    await rebindResponsesConversationRequestIdForHttp(requestId, args.responseId).catch((error) => {
      args.onNonBlockingError?.(`responses-conversation-rebind:${requestId}->${args.responseId}`, error);
    });
  }
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

export async function createResponsesJsonToSseConverterForHttp() {
  return await createResponsesJsonToSseConverter();
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
  hasSsePayload: (value: unknown) => boolean;
}): Promise<Record<string, unknown> | null> {
  if (!args.body || typeof args.body !== 'object' || Array.isArray(args.body) || args.hasSsePayload(args.body)) {
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
  return projectResponsesClientPayloadForClientNative(args);
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
  hasSsePayload: (value: unknown) => boolean;
}): Promise<unknown> {
  if (args.metadata?.__routecodexDirectPassthrough === true) {
    return args.payload;
  }
  if (
    args.entryEndpoint !== '/v1/responses'
    && args.entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) {
    return args.payload;
  }
  if (!args.payload || typeof args.payload !== 'object' || Array.isArray(args.payload) || args.hasSsePayload(args.payload)) {
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
  hasSsePayload: (value: unknown) => boolean;
}): Promise<{
  normalizedPayload: Record<string, unknown>;
  sanitizedPayload: Record<string, unknown>;
  finishReason?: string;
}> {
  const normalizedPayload = ensureResponsesJsonToSseRequiredFieldsForHttp({
    payload: args.responsesPayload,
    requestContext: args.requestContext,
  }) as Record<string, unknown>;
  const sanitizedPayload = stripInternalKeysDeep(normalizedPayload);
  return {
    normalizedPayload,
    sanitizedPayload,
    finishReason: resolveResponsesClientPayloadFinishReasonForHttp(normalizedPayload),
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
  hasSsePayload: (value: unknown) => boolean;
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
    hasSsePayload: args.hasSsePayload,
  });
  return {
    clientBody,
    sanitizedBody: stripInternalKeysDeep(clientBody),
    finishReason: resolveResponsesClientPayloadFinishReasonForHttp(clientBody),
  };
}

export async function projectResponsesSseFrameForClientForHttp(args: {
  frame: string;
  eventName?: string;
  data: Record<string, unknown>;
  toolsRaw: unknown[];
  metadata?: Record<string, unknown>;
  state: {
    pendingApplyPatchArgumentDeltas: Record<string, string>;
    applyPatchCallIds: string[];
    emittedApplyPatchDoneCallIds: string[];
  };
}): Promise<{
  emit: boolean;
  frame: string;
  state: {
    pendingApplyPatchArgumentDeltas: Record<string, string>;
    applyPatchCallIds: string[];
    emittedApplyPatchDoneCallIds: string[];
  };
}> {
  return projectResponsesSseFrameForClientNative(args);
}

function readResponsesSseCallIdForHttp(data: Record<string, unknown>): string | undefined {
  const direct = data.call_id;
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }
  const item =
    data.item && typeof data.item === 'object' && !Array.isArray(data.item)
      ? data.item as Record<string, unknown>
      : undefined;
  const nested = item?.call_id;
  return typeof nested === 'string' && nested.trim() ? nested.trim() : undefined;
}

function isApplyPatchFunctionCallRecordForHttp(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return row.type === 'function_call' && row.name === 'apply_patch';
}

function shouldSuppressDuplicateApplyPatchSseFrameForHttp(args: {
  eventName: string;
  data: Record<string, unknown>;
  state?: {
    pendingApplyPatchArgumentDeltas: Record<string, string>;
    applyPatchCallIds: string[];
    emittedApplyPatchDoneCallIds: string[];
  };
}): boolean {
  const emitted = args.state?.emittedApplyPatchDoneCallIds ?? [];
  if (emitted.length === 0) {
    return false;
  }
  const callId = readResponsesSseCallIdForHttp(args.data);
  if (!callId || !emitted.includes(callId)) {
    return false;
  }
  if (
    args.eventName === 'response.function_call_arguments.delta'
    || args.eventName === 'response.function_call_arguments.done'
  ) {
    return true;
  }
  if (args.eventName === 'response.output_item.added' || args.eventName === 'response.output_item.done') {
    return isApplyPatchFunctionCallRecordForHttp(args.data.item);
  }
  return false;
}

function collectEmittedApplyPatchDoneCallIdsFromFrameForHttp(frame: string): string[] {
  const lines = frame.split('\n');
  const eventLine = lines.find((line) => line.startsWith('event:'));
  const dataIndex = lines.findIndex((line) => line.startsWith('data:'));
  if (!eventLine || dataIndex < 0) {
    return [];
  }
  const eventName = eventLine.slice('event:'.length).trim();
  if (eventName !== 'response.output_item.done') {
    return [];
  }
  const dataText = lines
    .slice(dataIndex)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!dataText || dataText === '[DONE]') {
    return [];
  }
  try {
    const parsed = JSON.parse(dataText) as Record<string, unknown>;
    const item =
      parsed.item && typeof parsed.item === 'object' && !Array.isArray(parsed.item)
        ? parsed.item as Record<string, unknown>
        : undefined;
    if (!item || item.type !== 'custom_tool_call' || item.name !== 'apply_patch') {
      return [];
    }
    const callId = item.call_id;
    return typeof callId === 'string' && callId.trim() ? [callId.trim()] : [];
  } catch {
    return [];
  }
}

async function normalizeNestedResponsesPayloadInSseFrameForHttp(args: {
  frame: string;
  eventName: string;
  requestContext?: {
    payload: AnyRecord;
    context: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    matchedPort?: number;
    routingPolicyGroup?: string;
  };
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const lines = args.frame.split('\n');
  const eventIndex = lines.findIndex((line) => line.startsWith('event:'));
  const dataIndex = lines.findIndex((line) => line.startsWith('data:'));
  if (eventIndex < 0 || dataIndex < 0) {
    return args.frame;
  }
  const dataText = lines
    .slice(dataIndex)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!dataText || dataText === '[DONE]') {
    return args.frame;
  }
  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(dataText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return args.frame;
    }
    data = parsed as Record<string, unknown>;
  } catch {
    return args.frame;
  }
  const response =
    data.response && typeof data.response === 'object' && !Array.isArray(data.response)
      ? data.response
      : undefined;
  if (!response) {
    return args.frame;
  }
  const normalizedResponse = await projectResponsesClientPayloadForClientForHttp({
    payload: response,
    toolsRaw: readResponsesClientToolsRawForHttp(args.requestContext),
    metadata: args.metadata,
  });
  const nextData = {
    ...data,
    response: normalizedResponse,
  };
  lines[eventIndex] = `event: ${args.eventName}`;
  return `${lines.slice(0, dataIndex).join('\n')}${lines.slice(0, dataIndex).length ? '\n' : ''}data: ${JSON.stringify(nextData)}\n\n`;
}

export async function normalizeResponsesSseFrameForClientForHttp(args: {
  frame: string;
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
  projectionState?: {
    pendingApplyPatchArgumentDeltas: Record<string, string>;
    applyPatchCallIds: string[];
    emittedApplyPatchDoneCallIds: string[];
  };
  requestLabel?: string;
}): Promise<string> {
  if (
    args.entryEndpoint !== '/v1/responses'
    && args.entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) {
    return args.frame;
  }
  const lines = args.frame.split('\n');
  const eventLine = lines.find((line) => line.startsWith('event:'));
  const dataIndex = lines.findIndex((line) => line.startsWith('data:'));
  if (dataIndex < 0 || !eventLine) {
    return args.frame;
  }
  const eventName = eventLine.slice('event:'.length).trim();
  const dataText = lines
    .slice(dataIndex)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!dataText || dataText === '[DONE]') {
    return args.frame;
  }
  if (!eventName.startsWith('response.')) {
    return args.frame;
  }
  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(dataText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return args.frame;
    }
    data = parsed as Record<string, unknown>;
  } catch {
    return args.frame;
  }
  if (shouldSuppressDuplicateApplyPatchSseFrameForHttp({
    eventName,
    data,
    state: args.projectionState,
  })) {
    return '';
  }
  const projected = await projectResponsesSseFrameForClientForHttp({
    frame: args.frame,
    eventName,
    data,
    toolsRaw: readResponsesClientToolsRawForHttp(args.requestContext),
    metadata: args.metadata,
    state: args.projectionState ?? {
      pendingApplyPatchArgumentDeltas: {},
      applyPatchCallIds: [],
      emittedApplyPatchDoneCallIds: [],
    },
  });
  if (args.projectionState) {
    args.projectionState.pendingApplyPatchArgumentDeltas = projected.state.pendingApplyPatchArgumentDeltas ?? {};
    args.projectionState.applyPatchCallIds = projected.state.applyPatchCallIds ?? [];
    args.projectionState.emittedApplyPatchDoneCallIds = Array.from(new Set([
      ...(args.projectionState.emittedApplyPatchDoneCallIds ?? []),
      ...(projected.state.emittedApplyPatchDoneCallIds ?? []),
    ]));
  }
  if (!projected.emit) {
    return '';
  }
  const normalizedFrame = await normalizeNestedResponsesPayloadInSseFrameForHttp({
    frame: projected.frame,
    eventName,
    requestContext: args.requestContext,
    metadata: args.metadata,
  });
  if (args.projectionState) {
    args.projectionState.emittedApplyPatchDoneCallIds = Array.from(new Set([
      ...(args.projectionState.emittedApplyPatchDoneCallIds ?? []),
      ...collectEmittedApplyPatchDoneCallIdsFromFrameForHttp(normalizedFrame),
    ]));
  }
  return normalizedFrame;
}
