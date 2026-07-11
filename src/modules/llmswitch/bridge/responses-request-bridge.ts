/**
 * /v1/responses request-side handler bridge surface.
 *
 * Single handler-facing bridge entry for request preparation and
 * request/response conversation store writes on the handler side.
 */

// feature_id: server.responses_request_handler_bridge_surface
// feature_id: hub.chat_process_responses_continuation
// canonical_builders: buildResponsesConversationPortScopeForHttp, planResponsesHandlerStreamForHttp, prepareResponsesHandlerRuntimeForHttp, buildResponsesPipelineMetadataForHttp, prepareResponsesHandlerEntryForHttp, finalizeResponsesHandlerPayloadForHttp, shouldManageResponsesConversationForHttp, buildResponsesRequestContextForHttp, finalizeResponsesPipelineResultForHttp, captureResponsesRequestContextForHttp, recordResponsesResponseForHttp, seedResponsesToolCallResponseForHttp, clearResponsesConversationByRequestIdForHttp, clearResponsesConversationOnHandlerFailureForHttp, captureResponsesInboundToolHistoryErrorsampleForHttp, readResponsesResponseIdFromHttp

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
  buildResponsesConversationPortScopeForHttpNative,
  buildResponsesResumeControlForContinuationContextForHttpNative,
  buildResponsesResumeClientErrorForHttpNative,
  buildResponsesScopeContinuationExpiredErrorForHttpNative,
  extractSessionIdentifiersFromMetadataNative,
  finalizeResponsesHandlerPayloadForHttpNative,
  materializeProviderOwnedSubmitContext,
  planResponsesHandlerStreamForHttpNative,
  planResponsesRequestBodyForHttpNative,
  planResponsesRequestContext,
  planResponsesContinuationRequestAction,
  planResponsesHandlerEntry,
  shouldManageResponsesConversationForHttpNative,
  shouldProjectResponsesResumeClientErrorForHttpNative,
} from './native-exports.js';
import { deriveFinishReason } from '../../../server/utils/finish-reason.js';
import { writeErrorsampleJson } from '../../../utils/errorsamples.js';
import { MetadataCenter } from '../../../server/runtime/http-server/metadata-center/metadata-center.js';
import { writeMetadataCenterSlot } from '../../../server/runtime/http-server/metadata-center/dualwrite-api.js';

type AnyRecord = Record<string, unknown>;
const RESPONSES_PIPELINE_METADATA_WRITER = {
  module: 'src/modules/llmswitch/bridge/responses-request-bridge.ts',
  symbol: 'buildResponsesPipelineMetadataForHttp',
  stage: 'MetaReq04RuntimeControlBound'
} as const;

const RESPONSES_PIPELINE_CONTINUATION_WRITER = {
  module: 'src/modules/llmswitch/bridge/responses-request-bridge.ts',
  symbol: 'buildResponsesPipelineMetadataForHttp',
  stage: 'MetaReq03ContinuationAttached'
} as const;

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
      plannedEntryMode: 'none' | 'submit_tool_outputs' | 'scope_materialize';
      requestBodyMetadata?: Record<string, unknown>;
      resumeMeta?: Record<string, unknown>;
      streamPlan: ResponsesHandlerStreamPlanForHttp;
    }
  | {
      kind: 'client_error';
      status: number;
      body: Record<string, unknown>;
      requestBodyMetadata?: Record<string, unknown>;
      streamPlan: ResponsesHandlerStreamPlanForHttp;
    };

export type PreparedResponsesRequestBodyForHttp = {
  requestBodyMetadata?: Record<string, unknown>;
  pipelineBody: AnyRecord;
};

export function prepareResponsesRequestBodyForHttp(
  payload: AnyRecord,
  _runtimeMetadata?: Record<string, unknown>
): PreparedResponsesRequestBodyForHttp {
  return planResponsesRequestBodyForHttpNative(payload);
}

export function buildResponsesPipelineMetadataForHttp(args: {
  streamPlan: ResponsesHandlerStreamPlanForHttp;
  clientRequestId?: string;
  clientHeaders?: Record<string, unknown>;
  clientConnectionState?: unknown;
  resumeMeta?: Record<string, unknown>;
  requestContext: ResponsesRequestContextForHttp;
}): Record<string, unknown> {
  const responsesResume = args.resumeMeta
    ? buildResponsesResumeControlForContinuationContextForHttpNative(args.resumeMeta)
    : undefined;
  const metadata: Record<string, unknown> = {
    clientRequestId: args.clientRequestId,
    clientStream: args.streamPlan.acceptsSse || undefined,
    clientHeaders: args.clientHeaders,
    clientConnectionState: args.clientConnectionState,
    ...(responsesResume ? { responsesResume } : {}),
  };
  MetadataCenter.attach(metadata);
  writeMetadataCenterSlot({
    target: metadata,
    family: 'runtime_control',
    key: 'streamIntent',
    value: args.streamPlan.inboundStream || args.streamPlan.outboundStream ? 'stream' : 'non_stream',
    writer: RESPONSES_PIPELINE_METADATA_WRITER,
    reason: 'responses handler stream intent'
  });
  writeMetadataCenterSlot({
    target: metadata,
    family: 'runtime_control',
    key: 'providerProtocol',
    value: 'openai-responses',
    writer: RESPONSES_PIPELINE_METADATA_WRITER,
    reason: 'responses handler provider protocol'
  });
  writeMetadataCenterSlot({
    target: metadata,
    family: 'runtime_control',
    key: 'clientAbort',
    value: readClientAbortSignalForHttp(args.clientConnectionState)?.aborted === true,
    writer: RESPONSES_PIPELINE_METADATA_WRITER,
    reason: 'responses handler client abort state'
  });
  if (args.resumeMeta) {
    if (responsesResume) {
      writeMetadataCenterSlot({
        target: metadata,
        family: 'continuation_context',
        key: 'responsesResume',
        value: responsesResume,
        writer: RESPONSES_PIPELINE_CONTINUATION_WRITER
      });
    }
    if (
      responsesResume?.continuationOwner === 'direct'
      && typeof responsesResume.providerKey === 'string'
      && responsesResume.providerKey.trim()
    ) {
      writeMetadataCenterSlot({
        target: metadata,
        family: 'runtime_control',
        key: 'retryProviderKey',
        value: responsesResume.providerKey.trim(),
        writer: RESPONSES_PIPELINE_METADATA_WRITER,
        reason: 'direct responses continuation provider pin'
      });
    }
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
  return buildResponsesConversationPortScopeForHttpNative(portContext);
}

export function planResponsesHandlerStreamForHttp(args: {
  payload: AnyRecord;
  forceStream?: boolean;
  acceptsSse: boolean;
  requestTimeoutMs?: number;
}): ResponsesHandlerStreamPlanForHttp {
  return planResponsesHandlerStreamForHttpNative(args);
}

function readResponsesSessionIdFromHttp(metadata: Record<string, unknown> | undefined): string | undefined {
  return extractSessionIdentifiersFromMetadataNative(metadata).sessionId;
}

function readResponsesConversationIdFromHttp(metadata: Record<string, unknown> | undefined): string | undefined {
  return extractSessionIdentifiersFromMetadataNative(metadata).conversationId;
}

function readClientAbortSignalForHttp(clientConnectionState: unknown): AbortSignal | undefined {
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

function readResponsesResponseIdFromHttp(body: unknown): string | undefined {
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

function finalizeResponsesHandlerPayloadForHttp(args: {
  payload: AnyRecord;
  entryEndpoint: string;
  isSubmitToolOutputs: boolean;
  outboundStream: boolean;
}): AnyRecord {
  const payload = finalizeResponsesHandlerPayloadForHttpNative(args);
  if (!args.isSubmitToolOutputs && args.entryEndpoint === '/v1/responses') {
    applySystemPromptOverride(args.entryEndpoint, payload);
  }
  return payload;
}

function shouldManageResponsesConversationForHttp(entryEndpoint?: string): boolean {
  return shouldManageResponsesConversationForHttpNative(entryEndpoint);
}

function buildResponsesScopeContinuationExpiredErrorForHttp(): {
  error: {
    message: string;
    type: 'invalid_request_error';
    code: 'responses_continuation_expired';
  };
} {
  return buildResponsesScopeContinuationExpiredErrorForHttpNative();
}

function buildResponsesResumeClientErrorForHttp(args: {
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
  return buildResponsesResumeClientErrorForHttpNative(args);
}

function shouldProjectResponsesResumeClientErrorForHttp(args: {
  origin?: string;
}): boolean {
  return shouldProjectResponsesResumeClientErrorForHttpNative(args.origin);
}

async function buildCapturedRelayResumeRequestContextForHttp(args: {
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
  const captured = await captureReqInboundResponsesContextSnapshot({
    rawRequest: args.payload,
    requestId: args.requestId,
    toolCallIdStyle: args.payload.toolCallIdStyle ?? payloadMetadata?.toolCallIdStyle,
  });
  const capturedInput = Array.isArray(captured.input) ? captured.input : [];
  const capturedToolsRaw = Array.isArray(captured.toolsRaw) ? captured.toolsRaw : [];
  const normalizedPayload: AnyRecord = {
    ...args.payload,
    input: capturedInput,
  };
  if (capturedToolsRaw.length) {
    normalizedPayload.tools = capturedToolsRaw;
  }
  return {
    payload: normalizedPayload,
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

export async function buildResponsesRequestContextForHttp(args: {
  payload: AnyRecord;
  requestId?: string;
  metadata?: Record<string, unknown>;
  resumeMeta?: Record<string, unknown>;
  matchedPort?: number;
  routingPolicyGroup?: string;
}): Promise<ResponsesRequestContextForHttp> {
  const payloadMetadata =
    args.payload.metadata && typeof args.payload.metadata === 'object' && !Array.isArray(args.payload.metadata)
      ? (args.payload.metadata as Record<string, unknown>)
      : undefined;
  const contextPlan = await planResponsesRequestContext({
    payload: args.payload,
    ...(args.resumeMeta ? { resumeMeta: args.resumeMeta } : {}),
  });
  const planKind = typeof contextPlan.kind === 'string' ? contextPlan.kind : '';
  if (planKind === 'context') {
    const plannedPayload = contextPlan.payload;
    const plannedContext = contextPlan.context;
    if (!plannedPayload || typeof plannedPayload !== 'object' || Array.isArray(plannedPayload)) {
      throw new Error('Responses request context planner returned invalid payload');
    }
    if (!plannedContext || typeof plannedContext !== 'object' || Array.isArray(plannedContext)) {
      throw new Error('Responses request context planner returned invalid context');
    }
    const plannedInputValue = (plannedContext as Record<string, unknown>).input;
    if (!Array.isArray(plannedInputValue)) {
      throw new Error('Responses request context planner returned invalid context input');
    }
    const plannedInput: unknown[] = plannedInputValue;
    return {
      payload: plannedPayload as AnyRecord,
      context: {
        input: plannedInput,
      },
      sessionId: readResponsesSessionIdFromHttp(args.metadata),
      conversationId: readResponsesConversationIdFromHttp(args.metadata),
      ...(typeof args.matchedPort === 'number' ? { matchedPort: args.matchedPort } : {}),
      ...(args.routingPolicyGroup ? { routingPolicyGroup: args.routingPolicyGroup } : {}),
    };
  }
  if (planKind === 'error') {
    throw new Error(
      typeof contextPlan.message === 'string'
        ? contextPlan.message
        : 'Responses request context planning failed'
    );
  }
  if (planKind !== 'capture_request') {
    throw new Error(`Responses request context planner returned unsupported kind: ${String(planKind || 'unknown')}`);
  }
  const payloadForPersistence = contextPlan.payload;
  if (!payloadForPersistence || typeof payloadForPersistence !== 'object' || Array.isArray(payloadForPersistence)) {
    throw new Error('Responses request context planner returned invalid capture payload');
  }
  const captured = await captureReqInboundResponsesContextSnapshot({
    rawRequest: payloadForPersistence as AnyRecord,
    requestId: args.requestId,
    toolCallIdStyle: (payloadForPersistence as AnyRecord).toolCallIdStyle ?? payloadMetadata?.toolCallIdStyle,
  });
  const capturedInput = Array.isArray(captured.input) ? captured.input : [];
  const capturedToolsRaw = Array.isArray(captured.toolsRaw) ? captured.toolsRaw : [];
  const normalizedPayload: AnyRecord = {
    ...(payloadForPersistence as AnyRecord),
    input: capturedInput,
  };
  if (capturedToolsRaw.length) {
    normalizedPayload.tools = capturedToolsRaw;
  }
  return {
    payload: normalizedPayload,
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

  const responseId = plannedEntry.responseId || args.responseIdFromPath;
  const previousResponseId =
    typeof payload.previous_response_id === 'string' && payload.previous_response_id.trim()
      ? payload.previous_response_id.trim()
      : undefined;
  const continuationLookupId = isSubmitToolOutputs ? responseId : previousResponseId;
  const continuation = continuationLookupId
    ? await lookupResponsesContinuationByResponseId(continuationLookupId, {
        entryKind: 'responses',
        matchedPort: args.matchedPort,
        routingPolicyGroup: args.routingPolicyGroup,
      })
    : undefined;
  const continuationAction = await planResponsesContinuationRequestAction({
    plannedEntryMode: plannedEntry.mode,
    entryEndpoint: args.entryEndpoint,
    ...(responseId ? { responseId } : {}),
    ...(previousResponseId ? { previousResponseId } : {}),
    continuation: continuation || null,
  });

  switch (continuationAction.action) {
    case 'client_error': {
      throw Object.assign(
        new Error(
          typeof continuationAction.message === 'string'
            ? continuationAction.message
            : 'Unable to prepare Responses continuation request'
        ),
        {
          status: typeof continuationAction.status === 'number' ? continuationAction.status : 400,
          code: typeof continuationAction.code === 'string' ? continuationAction.code : 'bad_request',
          origin: typeof continuationAction.origin === 'string' ? continuationAction.origin : 'client',
        }
      );
    }
    case 'direct_submit': {
      const plannedResponseId =
        typeof continuationAction.responseId === 'string' && continuationAction.responseId.trim()
          ? continuationAction.responseId.trim()
          : responseId;
      if (plannedResponseId && (typeof payload.previous_response_id !== 'string' || !payload.previous_response_id.trim())) {
        payload.previous_response_id = plannedResponseId;
      }
      if (continuationAction.materializeProviderOwnedSubmitContext === true && (!Array.isArray(payload.input) || payload.input.length === 0)) {
        const materialized = await materializeProviderOwnedSubmitContext({ payload });
        if (materialized?.payload.input) {
          payload.input = materialized.payload.input;
        }
      }
      resumeMeta =
        continuationAction.resumeMeta && typeof continuationAction.resumeMeta === 'object' && !Array.isArray(continuationAction.resumeMeta)
          ? (continuationAction.resumeMeta as Record<string, unknown>)
          : undefined;
      pipelineEntryEndpoint =
        typeof continuationAction.pipelineEntryEndpoint === 'string'
          ? continuationAction.pipelineEntryEndpoint
          : args.entryEndpoint;
      return {
        kind: 'ok',
        payload,
        pipelineEntryEndpoint,
        plannedEntryMode: plannedEntry.mode,
        isSubmitToolOutputs,
        resumeMeta,
      };
    }
    case 'relay_submit': {
      const plannedResponseId =
        typeof continuationAction.responseId === 'string' && continuationAction.responseId.trim()
          ? continuationAction.responseId.trim()
          : responseId;
      if (!plannedResponseId) {
        throw Object.assign(new Error('response_id is required for submit_tool_outputs'), {
          status: 400,
          code: 'bad_request',
          origin: 'client',
        });
      }
      const resumeResult = await resumeResponsesConversation(plannedResponseId, payload, {
        requestId: args.requestId,
        entryKind: 'responses',
        matchedPort: args.matchedPort,
        routingPolicyGroup: args.routingPolicyGroup,
      });
      pipelineEntryEndpoint =
        typeof continuationAction.pipelineEntryEndpoint === 'string'
          ? continuationAction.pipelineEntryEndpoint
          : '/v1/responses';
      return {
        kind: 'ok',
        payload: (resumeResult.payload ?? {}) as AnyRecord,
        pipelineEntryEndpoint,
        plannedEntryMode: plannedEntry.mode,
        isSubmitToolOutputs,
        resumeMeta: resumeResult.meta,
      };
    }
    case 'relay_scope_materialize':
    case 'scope_materialize': {
      const materialized = await materializeLatestResponsesContinuationByScope({
        payload,
        requestId: args.requestId,
        sessionId: args.sessionId,
        conversationId: args.conversationId,
        entryKind: 'responses',
        ...(continuationAction.continuationOwner === 'relay' ? { continuationOwner: 'relay' as const } : {}),
        matchedPort: args.matchedPort,
        routingPolicyGroup: args.routingPolicyGroup,
      });
      if (!materialized) {
        return { kind: 'scope_continuation_expired' };
      }
      return {
        kind: 'ok',
        payload: (materialized.payload ?? {}) as AnyRecord,
        pipelineEntryEndpoint:
          typeof continuationAction.pipelineEntryEndpoint === 'string'
            ? continuationAction.pipelineEntryEndpoint
            : pipelineEntryEndpoint,
        plannedEntryMode: plannedEntry.mode,
        isSubmitToolOutputs,
        resumeMeta: materialized.meta,
      };
    }
    case 'attach_resume_meta': {
      resumeMeta =
        continuationAction.resumeMeta && typeof continuationAction.resumeMeta === 'object' && !Array.isArray(continuationAction.resumeMeta)
          ? (continuationAction.resumeMeta as Record<string, unknown>)
          : undefined;
      break;
    }
    case 'none':
      break;
    default: {
      throw new Error(
        `[responses] unsupported continuation request action: ${String(continuationAction.action ?? 'unknown')}`
      );
    }
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
  const requestBodyMetadata = planResponsesRequestBodyForHttpNative(args.payload).requestBodyMetadata;
  const requestMetadata = {
    ...(requestBodyMetadata ?? {}),
    ...(args.requestMetadata ?? {}),
  };
  const streamPlan = planResponsesHandlerStreamForHttp({
    payload: args.payload,
    forceStream: args.forceStream,
    acceptsSse: args.acceptsSse,
    requestTimeoutMs: args.requestTimeoutMs,
  });
  const sessionId = readResponsesSessionIdFromHttp(requestMetadata);
  const conversationId = readResponsesConversationIdFromHttp(requestMetadata);
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
        requestBodyMetadata,
        streamPlan,
      };
    }
    const payload = finalizeResponsesHandlerPayloadForHttp({
      payload: preparedEntry.payload,
      entryEndpoint: args.entryEndpoint,
      isSubmitToolOutputs: preparedEntry.isSubmitToolOutputs,
      outboundStream: streamPlan.outboundStream,
    });
    const requestContext = await buildResponsesRequestContextForHttp({
      payload,
      requestId: args.requestId,
      metadata: requestMetadata,
      resumeMeta: preparedEntry.resumeMeta,
      matchedPort: args.portScope?.matchedPort,
      routingPolicyGroup: args.portScope?.routingPolicyGroup,
    });
    return {
      kind: 'ok',
      payload: requestContext.payload,
      requestContext,
      pipelineEntryEndpoint: preparedEntry.pipelineEntryEndpoint,
      isSubmitToolOutputs: preparedEntry.isSubmitToolOutputs,
      plannedEntryMode: preparedEntry.plannedEntryMode,
      requestBodyMetadata,
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
      requestBodyMetadata,
      streamPlan,
    };
  }
}

async function captureResponsesRequestContextForHttp(args: {
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

async function recordResponsesResponseForHttp(args: {
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

async function seedResponsesToolCallResponseForHttp(args: {
  requestId?: string;
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
  const requestId = typeof args.requestId === 'string' && args.requestId.trim()
    ? args.requestId.trim()
    : undefined;
  if (!requestId) {
    throw new Error('Responses tool-call persistence requires request id');
  }
  await captureResponsesRequestContextForHttp({
    requestId,
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
      requestId,
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
  requestId?: string;
  body: unknown;
  resultMetadata: Record<string, unknown> | undefined;
  requestContext: ResponsesRequestContextForHttp;
  providerKey?: string;
  routeHint?: string;
  continuationOwner?: 'direct' | 'relay';
}): Promise<Record<string, unknown> | undefined> {
  const nextMetadata = args.resultMetadata;
  if (!shouldManageResponsesConversationForHttp(args.entryEndpoint)) {
    return nextMetadata;
  }
  if (args.continuationOwner === 'direct') {
    return nextMetadata;
  }
  await seedResponsesToolCallResponseForHttp({
    requestId: args.requestId,
    body: args.body,
    requestContext: args.requestContext,
    providerKey: args.providerKey,
    ...(typeof args.routeHint === 'string' ? { routeHint: args.routeHint } : {})
  });
  return nextMetadata;
}

async function clearResponsesConversationByRequestIdForHttp(
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
