/**
 * /v1/responses response-side handler bridge surface.
 *
 * Single projection-facing bridge entry for responses SSE/JSON projection and
 * continuation lifecycle writes on the response path.
 */

// feature_id: server.responses_response_handler_bridge_surface
// canonical_builders: updateResponsesContractProbeFromSseChunkForHttp, inspectResponsesTerminalStateFromSseChunkForHttp, summarizeResponsesSseFrameForLogForHttp, resolveResponsesProviderProtocolHintFromSseFrameForHttp, buildResponsesTerminalSseFramesFromProbeForHttp, isToolCallContinuationResponseForHttp, rebindResponsesConversationRequestIdForHttp, clearResponsesConversationByRequestIdForHttpProjection, recordResponsesResponseForHttpProjection, finalizeResponsesConversationRequestRetentionForHttp, createResponsesJsonToSseConverterForHttp, normalizeResponsesJsonBodyForHttp, buildResponsesPayloadFromChatForHttp, projectResponsesClientPayloadForClientForHttp, projectResponsesSseFrameForClientForHttp

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
import { deriveFinishReason } from '../../../server/utils/finish-reason.js';

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

type ResponsesRequestContextForHttp = {
  payload: AnyRecord;
  context: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  matchedPort?: number;
  routingPolicyGroup?: string;
};

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

export function isToolCallContinuationResponseForHttp(body: unknown): boolean {
  return isToolCallContinuationResponseNative(body);
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

function shouldPersistResponsesToolCallContinuationRecordForHttp(
  entryEndpoint: string | undefined,
  requestContext?: ResponsesRequestContextForHttp,
): boolean {
  if (entryEndpoint === '/v1/responses.submit_tool_outputs') {
    return true;
  }
  return entryEndpoint === '/v1/responses' && Boolean(requestContext);
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

  if (
    isContinuation
    && shouldPersistResponsesToolCallContinuationRecordForHttp(args.entryEndpoint, args.requestContext)
    && args.requestContext
    && args.body
    && typeof args.body === 'object'
    && !Array.isArray(args.body)
  ) {
    args.onTrace?.('capture.start', {
      responseId,
      providerKey: args.providerKey,
    });
    const requestIds = resolveResponsesConversationRecordRequestIdsForHttp({
      requestLabel: args.requestLabel,
      timingRequestIds: persisted.timingRequestIds,
      responseId,
    });
    for (const requestId of requestIds) {
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

    for (const requestId of requestIds) {
      await recordResponsesResponseForHttpProjection({
        requestId,
        response: args.body as AnyRecord,
        sessionId: persisted.sessionId ?? args.requestContext.sessionId,
        conversationId: persisted.conversationId ?? args.requestContext.conversationId,
        providerKey: persisted.providerKey,
        continuationOwner: persisted.continuationOwner,
        matchedPort: args.requestContext.matchedPort,
        routingPolicyGroup: args.requestContext.routingPolicyGroup,
      }).catch((error) => {
        args.onTrace?.('record.error', {
          recordRequestId: requestId,
          responseId,
          message: error instanceof Error ? error.message : String(error ?? 'unknown'),
        });
        args.onNonBlockingError?.(`responses-conversation-record:${requestId}`, error);
      });
    }

    for (const requestId of requestIds) {
      await finalizeResponsesConversationRequestRetentionForHttp(requestId, {
        keepForSubmitToolOutputs: true,
      }).catch((error) => {
        args.onTrace?.('record.finalize_error', {
          retainRequestId: requestId,
          responseId,
          message: error instanceof Error ? error.message : String(error ?? 'unknown'),
        });
        args.onNonBlockingError?.(`responses-conversation-finalize:${requestId}`, error);
      });
    }

    args.onTrace?.('record.done', { responseId, retainedRequestIds: requestIds });
    return;
  }

  if (isContinuation || finishReason === 'tool_calls') {
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

export function normalizeResponsesJsonBodyForHttp(args: {
  body: unknown;
  entryEndpoint?: string;
  requestLabel?: string;
  resolveBridge?: typeof requireResponsesHandlerCoreDist;
}): unknown {
  if (args.entryEndpoint !== '/v1/responses') {
    return args.body;
  }
  if (!args.body || typeof args.body !== 'object' || Array.isArray(args.body)) {
    return args.body;
  }
  if ((args.body as Record<string, unknown>).object !== 'chat.completion') {
    return args.body;
  }
  const mod = (args.resolveBridge ?? requireResponsesHandlerCoreDist)<{
    buildResponsesPayloadFromChat?: (payload: unknown, context?: Record<string, unknown>) => unknown
  }>('conversion/responses/responses-openai-bridge');
  if (typeof mod.buildResponsesPayloadFromChat !== 'function') {
    throw new Error('[handler-response] buildResponsesPayloadFromChat not available');
  }
  return mod.buildResponsesPayloadFromChat(args.body, {
    requestId: args.requestLabel
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

export function buildResponsesPayloadFromChatForHttp(
  payload: unknown,
  context?: Record<string, unknown>
): unknown {
  const mod = requireResponsesHandlerCoreDist<{
    buildResponsesPayloadFromChat?: (payload: unknown, context?: Record<string, unknown>) => unknown;
  }>('conversion/responses/responses-openai-bridge');
  if (typeof mod.buildResponsesPayloadFromChat !== 'function') {
    throw new Error('[handler-response] buildResponsesPayloadFromChat not available');
  }
  return mod.buildResponsesPayloadFromChat(payload, context);
}

export async function projectResponsesClientPayloadForClientForHttp(args: {
  payload: unknown;
  toolsRaw: unknown[];
  metadata?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const mod = await importResponsesHandlerCoreDist<{
    projectResponsesClientPayloadForClientWithNative?: (
      payload: unknown,
      toolsRaw: unknown[],
      metadata?: Record<string, unknown>
    ) => Record<string, unknown>;
  }>('native/router-hotpath/native-hub-pipeline-resp-semantics');
  if (typeof mod.projectResponsesClientPayloadForClientWithNative !== 'function') {
    throw new Error('[handler-response] projectResponsesClientPayloadForClientWithNative not available');
  }
  return mod.projectResponsesClientPayloadForClientWithNative(
    args.payload,
    args.toolsRaw,
    args.metadata
  );
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
  if (!(args.payload as Record<string, unknown>).required_action) {
    return args.payload;
  }
  return await projectResponsesClientPayloadForClientForHttp({
    payload: args.payload,
    toolsRaw: readResponsesClientToolsRawForHttp(args.requestContext),
    metadata: args.metadata,
  });
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
  const mod = await importResponsesHandlerCoreDist<{
    projectResponsesSseFrameForClientWithNative?: (input: {
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
    }) => {
      emit: boolean;
      frame: string;
      state: {
        pendingApplyPatchArgumentDeltas: Record<string, string>;
        applyPatchCallIds: string[];
        emittedApplyPatchDoneCallIds: string[];
      };
    };
  }>('native/router-hotpath/native-hub-pipeline-resp-semantics');
  if (typeof mod.projectResponsesSseFrameForClientWithNative !== 'function') {
    throw new Error('[handler-response] projectResponsesSseFrameForClientWithNative not available');
  }
  return mod.projectResponsesSseFrameForClientWithNative(args);
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
  if (args.metadata?.__routecodexDirectPassthrough === true) {
    return args.frame;
  }
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
  if (eventName !== 'response.required_action' && !dataText.includes('"required_action"')) {
    return args.frame;
  }
  if (eventName === 'response.required_action') {
    return buildResponsesTerminalSseFramesFromProbeForHttp(data, args.requestLabel ?? 'unknown').join('');
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
    args.projectionState.emittedApplyPatchDoneCallIds = projected.state.emittedApplyPatchDoneCallIds ?? [];
  }
  return projected.emit ? projected.frame : '';
}
