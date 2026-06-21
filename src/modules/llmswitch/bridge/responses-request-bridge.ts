/**
 * /v1/responses request-side handler bridge surface.
 *
 * Single handler-facing bridge entry for request preparation and
 * request/response conversation store writes on the handler side.
 */

// feature_id: server.responses_request_handler_bridge_surface
// canonical_builders: buildResponsesConversationPortScopeForHttp, planResponsesHandlerStreamForHttp, prepareResponsesHandlerRuntimeForHttp, buildResponsesPipelineMetadataForHttp, prepareResponsesHandlerEntryForHttp, finalizeResponsesHandlerPayloadForHttp, shouldManageResponsesConversationForHttp, buildResponsesRequestContextForHttp, captureResponsesPipelineRequestContextForHttp, finalizeResponsesPipelineResultForHttp, attachResponsesRequestContextToResultForHttp, captureResponsesRequestContextForHttp, recordResponsesResponseForHttp, seedResponsesToolCallResponseForHttp, clearResponsesConversationByRequestIdForHttp, clearResponsesConversationOnHandlerFailureForHttp, captureResponsesInboundToolHistoryErrorsampleForHttp, readResponsesSessionIdFromHttp, readResponsesConversationIdFromHttp, shouldPersistResponsesConversationForHttp, readResponsesResponseIdFromHttp

import type { AnyRecord } from './module-loader.js';
import { applySystemPromptOverride } from '../../../utils/system-prompt-loader.js';
import {
  captureResponsesRequestContextForRequest,
  clearResponsesConversationByRequestId,
  finalizeResponsesConversationRequestRetention,
  lookupResponsesContinuationByResponseId,
  materializeLatestResponsesContinuationByScope,
  recordResponsesResponseForRequest,
  resumeResponsesConversation,
} from './runtime-integrations.js';
import {
  captureReqInboundResponsesContextSnapshot,
  planResponsesHandlerEntry,
} from './native-exports.js';
import { deriveFinishReason } from '../../../server/utils/finish-reason.js';
import { writeErrorsampleJson } from '../../../utils/errorsamples.js';
import { MetadataCenter } from '../../../server/runtime/http-server/metadata-center/metadata-center.js';
import { readRuntimeControlProjection } from '../../../server/runtime/http-server/metadata-center/request-truth-readers.js';

export type ResponsesRequestContextForHttp = {
  payload: AnyRecord;
  context: {
    input: unknown[];
    toolsRaw?: unknown[];
  };
  sessionId?: string;
  conversationId?: string;
  matchedPort?: number;
  routingPolicyGroup?: string;
};

export type PrepareResponsesHandlerEntryForHttpArgs = {
  payload: AnyRecord;
  entryEndpoint: string;
  responseIdFromPath?: string;
  requestId: string;
  sessionId?: string;
  conversationId?: string;
  matchedPort?: number;
  routingPolicyGroup?: string;
};

export type ResponsesConversationPortScopeForHttp = {
  matchedPort?: number;
  routingPolicyGroup?: string;
};

export type ResponsesHandlerStreamPlanForHttp = {
  originalStream: boolean;
  outboundStream: boolean;
  inboundStream: boolean;
  acceptsSse: boolean;
  requestStartMeta: Record<string, unknown>;
};

export type PrepareResponsesHandlerRuntimeForHttpArgs = {
  payload: AnyRecord;
  entryEndpoint: string;
  responseIdFromPath?: string;
  requestId: string;
  requestMetadata?: Record<string, unknown>;
  portScope?: ResponsesConversationPortScopeForHttp;
  forceStream?: boolean;
  acceptsSse: boolean;
  requestTimeoutMs?: number;
};

export type PrepareResponsesHandlerRuntimeForHttpResult =
  | {
      kind: 'ok';
      payload: AnyRecord;
      requestContext: ResponsesRequestContextForHttp;
      pipelineEntryEndpoint: string;
      isSubmitToolOutputs: boolean;
      resumeMeta?: Record<string, unknown>;
      streamPlan: ResponsesHandlerStreamPlanForHttp;
    }
  | {
      kind: 'client_error';
      status: number;
      body: Record<string, unknown>;
      streamPlan: ResponsesHandlerStreamPlanForHttp;
    };

export type PreparedResponsesRequestBodyForHttp = {
  requestBodyMetadata?: Record<string, unknown>;
  pipelineBody: AnyRecord;
};

function buildStoplessInstructionsFromRuntimeMetadata(
  metadata: Record<string, unknown> | undefined
): string | undefined {
  const stopless = readRuntimeControlProjection(metadata).stopless;
  if (!stopless || stopless.active !== true) {
    return undefined;
  }
  const parts: string[] = [];
  if (typeof stopless.repeatCount === 'number') {
    if (typeof stopless.maxRepeats === 'number') {
      parts.push(`上一轮执行结果：repeatCount=${stopless.repeatCount}/${stopless.maxRepeats}。`);
    } else {
      parts.push(`上一轮执行结果：repeatCount=${stopless.repeatCount}。`);
    }
  }
  const schemaFeedback =
    stopless.schemaFeedback && typeof stopless.schemaFeedback === 'object' && !Array.isArray(stopless.schemaFeedback)
      ? stopless.schemaFeedback
      : undefined;
  const reasonCode =
    schemaFeedback && typeof schemaFeedback.reasonCode === 'string'
      ? schemaFeedback.reasonCode.trim()
      : '';
  const missingFields = Array.isArray(schemaFeedback?.missingFields)
    ? schemaFeedback?.missingFields.map((value) => String(value).trim()).filter(Boolean)
    : [];
  if (reasonCode) {
    parts.push(`reasonCode=${reasonCode}。`);
  }
  if (missingFields.length > 0) {
    parts.push(`missingFields=${missingFields.join(', ')}。`);
  }
  if (typeof stopless.continuationPrompt === 'string' && stopless.continuationPrompt.trim()) {
    parts.push(stopless.continuationPrompt.trim());
  }
  if (reasonCode === 'stop_schema_missing') {
    parts.push('如果任务已经完成，就按要求补齐收尾 schema；如果任务还没完成，不要停，继续执行当前任务。');
    parts.push('stopreason 取值：0=finished，1=blocked，2=continue_needed。');
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join('\n');
}

export function prepareResponsesRequestBodyForHttp(
  payload: AnyRecord,
  runtimeMetadata?: Record<string, unknown>
): PreparedResponsesRequestBodyForHttp {
  const requestBodyMetadata = readRequestBodyMetadataForHttp(payload);
  const pipelineBody = stripRequestBodyMetadataForPipelineForHttp(payload);
  const stoplessInstructions = buildStoplessInstructionsFromRuntimeMetadata(runtimeMetadata);
  if (
    stoplessInstructions
    && typeof pipelineBody.instructions !== 'string'
    && Array.isArray(pipelineBody.input)
  ) {
    pipelineBody.instructions = stoplessInstructions;
  }
  return {
    requestBodyMetadata,
    pipelineBody,
  };
}

export function buildResponsesPipelineMetadataForHttp(args: {
  streamPlan: ResponsesHandlerStreamPlanForHttp;
  clientRequestId?: string;
  clientHeaders?: Record<string, unknown>;
  clientConnectionState?: unknown;
  resumeMeta?: Record<string, unknown>;
  requestContext: ResponsesRequestContextForHttp;
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    clientRequestId: args.clientRequestId,
    clientStream: args.streamPlan.acceptsSse || undefined,
    providerProtocol: 'openai-responses',
    clientHeaders: args.clientHeaders,
    clientConnectionState: args.clientConnectionState,
    ...(args.resumeMeta ? { responsesResume: args.resumeMeta } : {}),
  };
  const center = MetadataCenter.attach(metadata);
  const resumeSessionId =
    typeof args.resumeMeta?.sessionId === 'string' && args.resumeMeta.sessionId.trim()
      ? args.resumeMeta.sessionId.trim()
      : typeof args.requestContext.sessionId === 'string' && args.requestContext.sessionId.trim()
        ? args.requestContext.sessionId.trim()
        : undefined;
  const resumeConversationId =
    typeof args.resumeMeta?.conversationId === 'string' && args.resumeMeta.conversationId.trim()
      ? args.resumeMeta.conversationId.trim()
      : typeof args.requestContext.conversationId === 'string' && args.requestContext.conversationId.trim()
        ? args.requestContext.conversationId.trim()
        : undefined;
  if (resumeSessionId) {
    center.writeRequestTruth(
      'sessionId',
      resumeSessionId,
      {
        module: 'src/modules/llmswitch/bridge/responses-request-bridge.ts',
        symbol: 'buildResponsesPipelineMetadataForHttp',
        stage: 'MetaReq02RequestTruthBound'
      },
      'responses relay resumed session scope'
    );
  }
  if (resumeConversationId) {
    center.writeRequestTruth(
      'conversationId',
      resumeConversationId,
      {
        module: 'src/modules/llmswitch/bridge/responses-request-bridge.ts',
        symbol: 'buildResponsesPipelineMetadataForHttp',
        stage: 'MetaReq02RequestTruthBound'
      },
      'responses relay resumed conversation scope'
    );
  }
  center.writeContinuationContext(
    'responsesRequestContext',
    args.requestContext,
    {
      module: 'src/modules/llmswitch/bridge/responses-request-bridge.ts',
      symbol: 'buildResponsesPipelineMetadataForHttp',
      stage: 'MetaReq03ContinuationAttached'
    }
  );
  center.writeRuntimeControl(
    'streamIntent',
    args.streamPlan.inboundStream || args.streamPlan.outboundStream ? 'stream' : 'non_stream',
    {
      module: 'src/modules/llmswitch/bridge/responses-request-bridge.ts',
      symbol: 'buildResponsesPipelineMetadataForHttp',
      stage: 'MetaReq04RuntimeControlBound'
    },
    'responses handler stream intent'
  );
  center.writeRuntimeControl(
    'clientAbort',
    readClientAbortSignalForHttp(args.clientConnectionState)?.aborted === true,
    {
      module: 'src/modules/llmswitch/bridge/responses-request-bridge.ts',
      symbol: 'buildResponsesPipelineMetadataForHttp',
      stage: 'MetaReq04RuntimeControlBound'
    },
    'responses handler client abort state'
  );
  if (args.resumeMeta) {
    if (typeof args.resumeMeta.routeHint === 'string' && args.resumeMeta.routeHint.trim()) {
      center.writeRuntimeControl(
        'routeHint',
        args.resumeMeta.routeHint.trim(),
        {
          module: 'src/modules/llmswitch/bridge/responses-request-bridge.ts',
          symbol: 'buildResponsesPipelineMetadataForHttp',
          stage: 'MetaReq04RuntimeControlBound'
        },
        'responses relay resumed route hint'
      );
    }
    const continuationOwner =
      typeof args.resumeMeta.continuationOwner === 'string'
        ? args.resumeMeta.continuationOwner.trim()
        : undefined;
    if (
      continuationOwner !== 'relay'
      && typeof args.resumeMeta.providerKey === 'string'
      && args.resumeMeta.providerKey.trim()
    ) {
      center.writeRuntimeControl(
        'retryProviderKey',
        args.resumeMeta.providerKey.trim(),
        {
          module: 'src/modules/llmswitch/bridge/responses-request-bridge.ts',
          symbol: 'buildResponsesPipelineMetadataForHttp',
          stage: 'MetaReq04RuntimeControlBound'
        },
        'responses relay resumed provider pin'
      );
    }
    center.writeContinuationContext(
      'responsesResume',
      args.resumeMeta,
      {
        module: 'src/modules/llmswitch/bridge/responses-request-bridge.ts',
        symbol: 'buildResponsesPipelineMetadataForHttp',
        stage: 'MetaReq03ContinuationAttached'
      }
    );
  }
  return metadata;
}

export function buildResponsesConversationPortScopeForHttp(
  portContext: {
    matchedPort?: unknown;
    localPort?: unknown;
    routingPolicyGroup?: unknown;
  } | null | undefined
): ResponsesConversationPortScopeForHttp {
  const matchedPort = typeof portContext?.matchedPort === 'number'
    ? portContext.matchedPort
    : typeof portContext?.localPort === 'number'
      ? portContext.localPort
      : undefined;
  const routingPolicyGroup = typeof portContext?.routingPolicyGroup === 'string' && portContext.routingPolicyGroup.trim()
    ? portContext.routingPolicyGroup.trim()
    : undefined;
  return {
    ...(typeof matchedPort === 'number' ? { matchedPort } : {}),
    ...(routingPolicyGroup ? { routingPolicyGroup } : {}),
  };
}

export function planResponsesHandlerStreamForHttp(args: {
  payload: AnyRecord;
  forceStream?: boolean;
  acceptsSse: boolean;
  requestTimeoutMs?: number;
}): ResponsesHandlerStreamPlanForHttp {
  const hasExplicitStream = typeof args.payload?.stream === 'boolean';
  const originalStream = args.payload?.stream === true;
  const outboundStream = typeof args.forceStream === 'boolean'
    ? args.forceStream
    : (hasExplicitStream ? originalStream : true);
  const inboundStream = outboundStream;
  return {
    originalStream,
    outboundStream,
    inboundStream,
    acceptsSse: args.acceptsSse,
    requestStartMeta: {
      inboundStream,
      outboundStream,
      clientAcceptsSse: args.acceptsSse,
      originalStream,
      type: args.payload?.type,
      timeoutMs: args.requestTimeoutMs
    }
  };
}

export function readResponsesSessionIdFromHttp(metadata: Record<string, unknown> | undefined): string | undefined {
  const clientHeaders =
    metadata?.clientHeaders && typeof metadata.clientHeaders === 'object' && !Array.isArray(metadata.clientHeaders)
      ? (metadata.clientHeaders as Record<string, unknown>)
      : undefined;
  const candidates = [
    metadata?.session_id,
    metadata?.sessionId,
    clientHeaders?.session_id,
    clientHeaders?.sessionId,
    clientHeaders?.['session-id'],
    clientHeaders?.['x-session-id']
  ];
  for (const candidate of candidates) {
    const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

export function readResponsesConversationIdFromHttp(metadata: Record<string, unknown> | undefined): string | undefined {
  const clientHeaders =
    metadata?.clientHeaders && typeof metadata.clientHeaders === 'object' && !Array.isArray(metadata.clientHeaders)
      ? (metadata.clientHeaders as Record<string, unknown>)
      : undefined;
  const candidates = [
    metadata?.conversation_id,
    metadata?.conversationId,
    clientHeaders?.conversation_id,
    clientHeaders?.conversationId,
    clientHeaders?.['conversation-id'],
    clientHeaders?.['x-conversation-id']
  ];
  for (const candidate of candidates) {
    const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

export function readRequestBodyMetadataForHttp(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const raw = (payload as Record<string, unknown>).metadata;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  try {
    return JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  } catch {
    return { ...(raw as Record<string, unknown>) };
  }
}

export function stripRequestBodyMetadataForPipelineForHttp<T>(payload: T): T {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'metadata')) {
    return payload;
  }
  const { metadata: _metadata, ...withoutMetadata } = record;
  return withoutMetadata as T;
}

export function readClientAbortSignalForHttp(clientConnectionState: unknown): AbortSignal | undefined {
  if (!clientConnectionState || typeof clientConnectionState !== 'object') {
    return undefined;
  }
  const abortSignalSymbol = Reflect.ownKeys(clientConnectionState as object).find(
    (key) => typeof key === 'symbol' && key.description === 'routecodex.clientConnectionAbortSignal'
  );
  if (!abortSignalSymbol) {
    return undefined;
  }
  const signal = Reflect.get(clientConnectionState as object, abortSignalSymbol);
  if (signal && typeof signal === 'object' && 'aborted' in (signal as object)) {
    return signal as AbortSignal;
  }
  return undefined;
}

export function shouldPersistResponsesConversationForHttp(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const record = payload as Record<string, unknown>;
  if (record.store === true) {
    return true;
  }
  const previousResponseId =
    typeof record.previous_response_id === 'string' && record.previous_response_id.trim()
      ? record.previous_response_id.trim()
      : '';
  const toolOutputs = Array.isArray(record.tool_outputs) ? record.tool_outputs : [];
  return Boolean(previousResponseId && toolOutputs.length > 0);
}

export function readResponsesResponseIdFromHttp(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const nested = record.response && typeof record.response === 'object' && !Array.isArray(record.response)
    ? (record.response as Record<string, unknown>)
    : undefined;
  for (const candidate of [record.id, record.response_id, nested?.id]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

export type PrepareResponsesHandlerEntryForHttpResult =
  | {
      kind: 'ok';
      payload: AnyRecord;
      pipelineEntryEndpoint: string;
      plannedEntryMode: 'none' | 'submit_tool_outputs' | 'scope_materialize';
      isSubmitToolOutputs: boolean;
      resumeMeta?: Record<string, unknown>;
    }
  | {
      kind: 'scope_continuation_expired';
    };

export function finalizeResponsesHandlerPayloadForHttp(args: {
  payload: AnyRecord;
  entryEndpoint: string;
  isSubmitToolOutputs: boolean;
  outboundStream: boolean;
}): AnyRecord {
  const payload = args.payload;
  if (!args.isSubmitToolOutputs && args.outboundStream && payload.stream !== true) {
    payload.stream = true;
  }
  if (!args.isSubmitToolOutputs && args.entryEndpoint === '/v1/responses') {
    applySystemPromptOverride(args.entryEndpoint, payload);
  }
  return payload;
}

export function shouldManageResponsesConversationForHttp(entryEndpoint?: string): boolean {
  return entryEndpoint === '/v1/responses' || entryEndpoint === '/v1/responses.submit_tool_outputs';
}

export function buildResponsesScopeContinuationExpiredErrorForHttp(): {
  error: {
    message: string;
    type: 'invalid_request_error';
    code: 'responses_continuation_expired';
  };
} {
  return {
    error: {
      message: 'Responses continuation expired or not found for local scope materialization',
      type: 'invalid_request_error',
      code: 'responses_continuation_expired',
    },
  };
}

export function buildResponsesResumeClientErrorForHttp(args: {
  status?: number;
  code?: string;
  origin?: string;
  message?: string;
}): {
  status: number;
  body: {
    error: {
      message: string;
      type: 'invalid_request_error';
      code: string;
      origin: string;
    };
  };
} {
  return {
    status: typeof args.status === 'number' ? args.status : 422,
    body: {
      error: {
        message:
          typeof args.message === 'string' && args.message.trim()
            ? args.message
            : 'Unable to resume Responses conversation',
        type: 'invalid_request_error',
        code:
          typeof args.code === 'string' && args.code.trim()
            ? args.code
            : 'responses_resume_failed',
        origin:
          typeof args.origin === 'string' && args.origin.trim()
            ? args.origin
            : 'client',
      },
    },
  };
}

export function shouldProjectResponsesResumeClientErrorForHttp(args: {
  origin?: string;
}): boolean {
  return typeof args.origin === 'string' && args.origin.trim() === 'client';
}

function isProviderOwnedSubmitToolOutputsResumePayload(payload: AnyRecord): boolean {
  const responseId =
    typeof payload.response_id === 'string' && payload.response_id.trim()
      ? payload.response_id.trim()
      : undefined;
  const toolOutputs = Array.isArray(payload.tool_outputs) ? payload.tool_outputs : [];
  const hasChatHistory =
    (Array.isArray(payload.input) && payload.input.length > 0)
    || (Array.isArray(payload.messages) && payload.messages.length > 0);
  return Boolean(responseId && toolOutputs.length > 0 && !hasChatHistory);
}

export async function buildResponsesRequestContextForHttp(args: {
  payload: AnyRecord;
  requestId?: string;
  metadata?: Record<string, unknown>;
  matchedPort?: number;
  routingPolicyGroup?: string;
}): Promise<ResponsesRequestContextForHttp> {
  const payloadMetadata =
    args.payload.metadata && typeof args.payload.metadata === 'object' && !Array.isArray(args.payload.metadata)
      ? (args.payload.metadata as Record<string, unknown>)
      : undefined;
  const payloadForPersistence = stripRequestBodyMetadataForPipelineForHttp(args.payload);
  if (isProviderOwnedSubmitToolOutputsResumePayload(payloadForPersistence)) {
    return {
      payload: payloadForPersistence,
      context: {
        input: [],
      },
      sessionId: readResponsesSessionIdFromHttp(args.metadata),
      conversationId: readResponsesConversationIdFromHttp(args.metadata),
      ...(typeof args.matchedPort === 'number' ? { matchedPort: args.matchedPort } : {}),
      ...(args.routingPolicyGroup ? { routingPolicyGroup: args.routingPolicyGroup } : {}),
    };
  }
  const captured = await captureReqInboundResponsesContextSnapshot({
    rawRequest: args.payload,
    requestId: args.requestId,
    toolCallIdStyle: args.payload.toolCallIdStyle ?? payloadMetadata?.toolCallIdStyle,
  });
  const capturedInput = Array.isArray(captured.input) ? captured.input : [];
  const capturedToolsRaw = Array.isArray(captured.toolsRaw) ? captured.toolsRaw : undefined;
  return {
    payload: payloadForPersistence,
    context: {
      input: capturedInput,
      toolsRaw: capturedToolsRaw,
    },
    sessionId: readResponsesSessionIdFromHttp(args.metadata),
    conversationId: readResponsesConversationIdFromHttp(args.metadata),
    ...(typeof args.matchedPort === 'number' ? { matchedPort: args.matchedPort } : {}),
    ...(args.routingPolicyGroup ? { routingPolicyGroup: args.routingPolicyGroup } : {}),
  };
}

export async function prepareResponsesHandlerEntryForHttp(
  args: PrepareResponsesHandlerEntryForHttpArgs
): Promise<PrepareResponsesHandlerEntryForHttpResult> {
  const plannedEntry = await planResponsesHandlerEntry(
    args.payload,
    args.entryEndpoint,
    args.responseIdFromPath
  );
  const payload = (plannedEntry.payload ?? {}) as AnyRecord;
  const isSubmitToolOutputs = plannedEntry.mode === 'submit_tool_outputs';
  let resumeMeta: Record<string, unknown> | undefined;
  let pipelineEntryEndpoint = args.entryEndpoint;

  if (args.responseIdFromPath && !payload.response_id) {
    payload.response_id = args.responseIdFromPath;
  }

  if (isSubmitToolOutputs) {
    const responseId = plannedEntry.responseId || args.responseIdFromPath;
    if (!responseId) {
      throw Object.assign(
        new Error('response_id is required for submit_tool_outputs'),
        {
          status: 400,
          code: 'bad_request',
          origin: 'client',
        }
      );
    }
    const continuation = await lookupResponsesContinuationByResponseId(responseId, {
      entryKind: 'responses',
      matchedPort: args.matchedPort,
      routingPolicyGroup: args.routingPolicyGroup,
    });
    if (continuation?.continuationOwner === 'direct') {
      resumeMeta = {
        responseId,
        restored: false,
        continuationOwner: 'direct',
        ...(continuation.providerKey ? { providerKey: continuation.providerKey } : {}),
      };
      pipelineEntryEndpoint = args.entryEndpoint;
      return {
        kind: 'ok',
        payload,
        pipelineEntryEndpoint,
        plannedEntryMode: plannedEntry.mode,
        isSubmitToolOutputs,
        resumeMeta,
      };
    }
    const resumeResult = await resumeResponsesConversation(responseId, payload, {
      requestId: args.requestId,
      entryKind: 'responses',
      matchedPort: args.matchedPort,
      routingPolicyGroup: args.routingPolicyGroup,
    });
    // Relay-owned continuation is already materialized into a normal
    // /v1/responses payload; keep it on the mainline instead of letting
    // downstream provider/runtime layers reinterpret it as upstream-native
    // submit_tool_outputs.
    pipelineEntryEndpoint = '/v1/responses';
    return {
      kind: 'ok',
      payload: (resumeResult.payload ?? {}) as AnyRecord,
      pipelineEntryEndpoint,
      plannedEntryMode: plannedEntry.mode,
      isSubmitToolOutputs,
      resumeMeta: resumeResult.meta,
    };
  }

  const previousResponseId =
    typeof payload.previous_response_id === 'string' && payload.previous_response_id.trim()
      ? payload.previous_response_id.trim()
      : undefined;
  if (args.entryEndpoint === '/v1/responses' && previousResponseId) {
    const continuation = await lookupResponsesContinuationByResponseId(previousResponseId, {
      entryKind: 'responses',
      matchedPort: args.matchedPort,
      routingPolicyGroup: args.routingPolicyGroup,
    });
    if (continuation?.continuationOwner === 'relay' && plannedEntry.mode === 'scope_materialize') {
      const materialized = await materializeLatestResponsesContinuationByScope({
        payload,
        requestId: args.requestId,
        sessionId: args.sessionId,
        conversationId: args.conversationId,
        entryKind: 'responses',
        continuationOwner: 'relay',
        matchedPort: args.matchedPort,
        routingPolicyGroup: args.routingPolicyGroup,
      });
      if (!materialized) {
        return { kind: 'scope_continuation_expired' };
      }
      return {
        kind: 'ok',
        payload: (materialized.payload ?? {}) as AnyRecord,
        pipelineEntryEndpoint,
        plannedEntryMode: plannedEntry.mode,
        isSubmitToolOutputs,
        resumeMeta: materialized.meta,
      };
    }
    if (continuation?.continuationOwner === 'direct' || continuation?.continuationOwner === 'relay') {
      resumeMeta = {
        responseId: previousResponseId,
        restored: false,
        continuationOwner: continuation.continuationOwner,
        ...(continuation.providerKey ? { providerKey: continuation.providerKey } : {}),
        ...(continuation.requestId ? { previousRequestId: continuation.requestId } : {}),
      };
    }
  }

  if (plannedEntry.mode === 'scope_materialize') {
    const materialized = await materializeLatestResponsesContinuationByScope({
      payload,
      requestId: args.requestId,
      sessionId: args.sessionId,
      conversationId: args.conversationId,
      entryKind: 'responses',
      matchedPort: args.matchedPort,
      routingPolicyGroup: args.routingPolicyGroup,
    });
    if (!materialized) {
      return { kind: 'scope_continuation_expired' };
    }
    return {
      kind: 'ok',
      payload: (materialized.payload ?? {}) as AnyRecord,
      pipelineEntryEndpoint,
      plannedEntryMode: plannedEntry.mode,
      isSubmitToolOutputs,
      resumeMeta: materialized.meta,
    };
  }

  return {
    kind: 'ok',
    payload,
    pipelineEntryEndpoint,
    plannedEntryMode: plannedEntry.mode,
    isSubmitToolOutputs,
    resumeMeta,
  };
}

export async function prepareResponsesHandlerRuntimeForHttp(
  args: PrepareResponsesHandlerRuntimeForHttpArgs
): Promise<PrepareResponsesHandlerRuntimeForHttpResult> {
  const streamPlan = planResponsesHandlerStreamForHttp({
    payload: args.payload,
    forceStream: args.forceStream,
    acceptsSse: args.acceptsSse,
    requestTimeoutMs: args.requestTimeoutMs,
  });
  const requestBodyMetadata = readRequestBodyMetadataForHttp(args.payload);
  const effectiveRequestMetadata = {
    ...(requestBodyMetadata ?? {}),
    ...(args.requestMetadata ?? {})
  };
  const sessionId = readResponsesSessionIdFromHttp(effectiveRequestMetadata);
  const conversationId = readResponsesConversationIdFromHttp(effectiveRequestMetadata);
  try {
    const preparedEntry = await prepareResponsesHandlerEntryForHttp({
      payload: args.payload,
      entryEndpoint: args.entryEndpoint,
      responseIdFromPath: args.responseIdFromPath,
      requestId: args.requestId,
      sessionId,
      conversationId,
      matchedPort: args.portScope?.matchedPort,
      routingPolicyGroup: args.portScope?.routingPolicyGroup,
    });
    if (preparedEntry.kind === 'scope_continuation_expired') {
      const clientError = buildResponsesScopeContinuationExpiredErrorForHttp();
      return {
        kind: 'client_error',
        status: 400,
        body: clientError as unknown as Record<string, unknown>,
        streamPlan,
      };
    }
    const payload = finalizeResponsesHandlerPayloadForHttp({
      payload: preparedEntry.payload,
      entryEndpoint: args.entryEndpoint,
      isSubmitToolOutputs: preparedEntry.isSubmitToolOutputs,
      outboundStream: streamPlan.outboundStream,
    });
    return {
      kind: 'ok',
      payload,
      requestContext: await buildResponsesRequestContextForHttp({
        payload,
        requestId: args.requestId,
        metadata: effectiveRequestMetadata,
        matchedPort: args.portScope?.matchedPort,
        routingPolicyGroup: args.portScope?.routingPolicyGroup,
      }),
      pipelineEntryEndpoint: preparedEntry.pipelineEntryEndpoint,
      isSubmitToolOutputs: preparedEntry.isSubmitToolOutputs,
      resumeMeta: preparedEntry.resumeMeta,
      streamPlan,
    };
  } catch (error: unknown) {
    const structured = error as { status?: number; code?: string; origin?: string };
    const origin = typeof structured?.origin === 'string' ? structured.origin : undefined;
    if (!shouldProjectResponsesResumeClientErrorForHttp({ origin })) {
      throw error;
    }
    const status = typeof structured?.status === 'number' ? structured.status : undefined;
    const code = typeof structured?.code === 'string' ? structured.code : 'responses_resume_failed';
    const message = error instanceof Error ? error.message : 'Unable to resume Responses conversation';
    const clientError = buildResponsesResumeClientErrorForHttp({
      status,
      code,
      origin,
      message,
    });
    return {
      kind: 'client_error',
      status: clientError.status,
      body: clientError.body as unknown as Record<string, unknown>,
      streamPlan,
    };
  }
}

export async function captureResponsesRequestContextForHttp(args: {
  requestId: string;
  payload: AnyRecord;
  context: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  providerKey?: string;
  entryKind?: 'responses' | 'chat' | 'messages';
  matchedPort?: number;
  routingPolicyGroup?: string;
}): Promise<void> {
  await captureResponsesRequestContextForRequest({
    ...args,
    entryKind: args.entryKind ?? 'responses',
  });
}

export async function captureResponsesPipelineRequestContextForHttp(args: {
  entryEndpoint?: string;
  requestId: string;
  requestContext: ResponsesRequestContextForHttp;
  providerKey?: string;
}): Promise<void> {
  if (!shouldManageResponsesConversationForHttp(args.entryEndpoint)) {
    return;
  }
  await captureResponsesRequestContextForHttp({
    requestId: args.requestId,
    ...args.requestContext,
    providerKey: args.providerKey,
  });
}

export function attachResponsesRequestContextToResultForHttp(args: {
  entryEndpoint?: string;
  resultMetadata: Record<string, unknown> | undefined;
  requestContext: ResponsesRequestContextForHttp;
}): Record<string, unknown> | undefined {
  if (!shouldManageResponsesConversationForHttp(args.entryEndpoint)) {
    return args.resultMetadata;
  }
  const nextMetadata = {
    ...(args.resultMetadata || {}),
  };
  const center = MetadataCenter.attach(nextMetadata);
  center.writeContinuationContext(
    'responsesRequestContext',
    args.requestContext,
    {
      module: 'src/modules/llmswitch/bridge/responses-request-bridge.ts',
      symbol: 'attachResponsesRequestContextToResultForHttp',
      stage: 'HubRespChatProcess03Governed'
    }
  );
  return nextMetadata;
}

export async function recordResponsesResponseForHttp(args: {
  requestId: string;
  response: AnyRecord;
  providerKey?: string;
  matchedPort?: number;
  routingPolicyGroup?: string;
  sessionId?: string;
  conversationId?: string;
  entryKind?: 'responses' | 'chat' | 'messages';
  routeHint?: string;
}): Promise<void> {
  await recordResponsesResponseForRequest({
    ...args,
    entryKind: args.entryKind ?? 'responses',
  });
}

export async function seedResponsesToolCallResponseForHttp(args: {
  body: unknown;
  requestContext?: {
    payload?: Record<string, unknown>;
    context?: Record<string, unknown>;
    sessionId?: string;
    conversationId?: string;
    matchedPort?: number;
    routingPolicyGroup?: string;
  };
  providerKey?: string;
  routeHint?: string;
}): Promise<void> {
  const responseId = readResponsesResponseIdFromHttp(args.body);
  const finishReason = deriveFinishReason(args.body);
  if (!responseId || finishReason !== 'tool_calls') {
    return;
  }
  const requestContext = args.requestContext;
  if (!requestContext?.payload || !requestContext?.context) {
    return;
  }
  await captureResponsesRequestContextForHttp({
    requestId: responseId,
    payload: requestContext.payload,
    context: requestContext.context,
    sessionId: requestContext.sessionId,
    conversationId: requestContext.conversationId,
    matchedPort: requestContext.matchedPort,
    routingPolicyGroup: requestContext.routingPolicyGroup,
    providerKey: args.providerKey
  });
  if (args.body && typeof args.body === 'object' && !Array.isArray(args.body)) {
    await recordResponsesResponseForHttp({
      requestId: responseId,
      response: args.body as Record<string, unknown>,
      providerKey: args.providerKey,
      matchedPort: requestContext.matchedPort,
      routingPolicyGroup: requestContext.routingPolicyGroup,
      sessionId: requestContext.sessionId,
      conversationId: requestContext.conversationId,
      ...(typeof args.routeHint === 'string' ? { routeHint: args.routeHint } : {})
    });
  }
}

export async function finalizeResponsesPipelineResultForHttp(args: {
  entryEndpoint?: string;
  body: unknown;
  resultMetadata: Record<string, unknown> | undefined;
  requestContext: ResponsesRequestContextForHttp;
  providerKey?: string;
  routeHint?: string;
}): Promise<Record<string, unknown> | undefined> {
  const nextMetadata = attachResponsesRequestContextToResultForHttp({
    entryEndpoint: args.entryEndpoint,
    resultMetadata: args.resultMetadata,
    requestContext: args.requestContext,
  });
  if (!shouldManageResponsesConversationForHttp(args.entryEndpoint)) {
    return nextMetadata;
  }
  const continuationContext = MetadataCenter.read(nextMetadata)?.readContinuationContext();
  await seedResponsesToolCallResponseForHttp({
    body: args.body,
    requestContext: continuationContext?.responsesRequestContext as {
      payload?: Record<string, unknown>;
      context?: Record<string, unknown>;
      sessionId?: string;
      conversationId?: string;
      matchedPort?: number;
      routingPolicyGroup?: string;
    } | undefined,
    providerKey: args.providerKey,
    ...(typeof args.routeHint === 'string' ? { routeHint: args.routeHint } : {})
  });
  return nextMetadata;
}

export async function clearResponsesConversationByRequestIdForHttp(
  requestId?: string
): Promise<void> {
  await clearResponsesConversationByRequestId(requestId);
}

export async function clearResponsesConversationOnHandlerFailureForHttp(args: {
  requestId?: string;
  stage: 'timeout' | 'timeout_started' | 'error';
}): Promise<void> {
  if (!args.requestId || !args.requestId.trim()) {
    return;
  }
  await clearResponsesConversationByRequestIdForHttp(args.requestId);
}

export async function captureResponsesInboundToolHistoryErrorsampleForHttp(args: {
  requestId: string;
  entryEndpoint: string;
  body: unknown;
  error: unknown;
}): Promise<void> {
  const errorRecord = args.error && typeof args.error === 'object'
    ? (args.error as Record<string, unknown>)
    : undefined;
  const code = typeof errorRecord?.code === 'string' ? errorRecord.code : '';
  if (code !== 'MALFORMED_REQUEST') {
    return;
  }
  const message = args.error instanceof Error ? args.error.message : String(args.error ?? '');
  const details = errorRecord && typeof errorRecord.details === 'object'
    ? (errorRecord.details as Record<string, unknown>)
    : undefined;
  if (
    !message.includes('Tool history contract violated')
    && !Boolean(details?.toolHistoryContractViolation)
  ) {
    return;
  }
  await writeErrorsampleJson({
    group: 'payload-contract-error',
    kind: 'responses.inbound_tool_history_contract',
    payload: {
      kind: 'responses.inbound_tool_history_contract',
      timestamp: new Date().toISOString(),
      requestId: args.requestId,
      entryEndpoint: args.entryEndpoint,
      body: args.body,
      error:
        args.error && typeof args.error === 'object'
          ? {
              name: (args.error as { name?: unknown }).name,
              message: (args.error as { message?: unknown }).message,
              code: (args.error as { code?: unknown }).code,
              details: (args.error as { details?: unknown }).details
            }
          : { message: String(args.error ?? 'unknown_error') }
    }
  });
}

export async function finalizeResponsesConversationRequestRetentionForHttp(
  requestId?: string,
  options?: { keepForSubmitToolOutputs?: boolean }
): Promise<void> {
  await finalizeResponsesConversationRequestRetention(requestId, options);
}
