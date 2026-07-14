/**
 * /v1/responses request-side handler bridge surface.
 *
 * Single handler-facing bridge entry for request preparation and
 * request-side conversation store lookups on the handler side.
 */

// feature_id: server.responses_request_handler_bridge_surface
// feature_id: hub.chat_process_responses_continuation
// canonical_builders: buildResponsesConversationPortScopeForHttp, planResponsesHandlerStreamForHttp, prepareResponsesHandlerRuntimeForHttp, buildResponsesPipelineMetadataForHttp, prepareResponsesHandlerEntryForHttp, finalizeResponsesHandlerPayloadForHttp, shouldManageResponsesConversationForHttp, buildResponsesRequestContextForHttp, clearResponsesConversationByRequestIdForHttp, clearResponsesConversationOnHandlerFailureForHttp, captureResponsesInboundToolHistoryErrorsampleForHttp

import { getSystemPromptOverride } from '../../../utils/system-prompt-loader.js';
import {
  clearResponsesConversationByRequestId,
  lookupResponsesContinuationByResponseId,
  materializeLatestResponsesContinuationByScope,
  resumeResponsesConversation,
} from './runtime-integrations.js';
import {
  captureReqInboundResponsesContextSnapshotJson,
  buildResponsesConversationPortScopeForHttpNative,
  buildResponsesPipelineMetadataForHttpNative,
  buildResponsesScopeContinuationExpiredErrorForHttpNative,
  extractSessionIdentifiersFromMetadataNative,
  finalizeResponsesHandlerPayloadForHttpNative,
  materializeProviderOwnedSubmitContext,
  planResponsesInboundToolHistoryErrorsampleForHttpNative,
  planResponsesResumeErrorForHttpNative,
  planResponsesHandlerStreamForHttpNative,
  planResponsesRequestBodyForHttpNative,
  planResponsesRequestContext,
  planResponsesContinuationRequestAction,
  planResponsesHandlerEntry,
  shouldManageResponsesConversationForHttpNative,
} from './responses-request-handler-host.js';
import { writeErrorsampleJson } from '../../../utils/errorsamples.js';
import { MetadataCenter } from '../../../server/runtime/http-server/metadata-center/metadata-center.js';
import { writeMetadataCenterSlot } from '../../../server/runtime/http-server/metadata-center/dualwrite-api.js';

type AnyRecord = Record<string, unknown>;

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

type PrepareResponsesHandlerEntryForHttpArgs = {
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

type ResponsesHandlerStreamPlanForHttp = {
  originalStream: boolean;
  outboundStream: boolean;
  inboundStream: boolean;
  acceptsSse: boolean;
  requestStartMeta: Record<string, unknown>;
};

type PrepareResponsesHandlerRuntimeForHttpArgs = {
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

type PrepareResponsesHandlerRuntimeForHttpResult =
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

type PreparedResponsesRequestBodyForHttp = {
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
  const plan = buildResponsesPipelineMetadataForHttpNative({
    streamPlan: args.streamPlan,
    ...(typeof args.clientRequestId === 'string' ? { clientRequestId: args.clientRequestId } : {}),
    ...(args.clientHeaders ? { clientHeaders: args.clientHeaders } : {}),
    clientAbort: readClientAbortSignalForHttp(args.clientConnectionState)?.aborted === true,
    ...(args.resumeMeta ? { resumeMeta: args.resumeMeta } : {}),
  });
  const metadata: Record<string, unknown> = {
    ...plan.metadata,
    clientConnectionState: args.clientConnectionState,
  };
  MetadataCenter.attach(metadata);
  for (const write of plan.metadataCenterWrites) {
    writeMetadataCenterSlot({
      target: metadata,
      family: write.family,
      key: write.key,
      value: write.value,
      writer: write.writer,
      ...(typeof write.reason === 'string' ? { reason: write.reason } : {})
    });
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

type PrepareResponsesHandlerEntryForHttpResult =
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
    }
  | {
      kind: 'client_error';
      status: number;
      body: {
        error: {
          message: string;
          type: 'invalid_request_error';
          code: string;
          origin: 'client';
        };
      };
    };

function finalizeResponsesHandlerPayloadForHttp(args: {
  payload: AnyRecord;
  entryEndpoint: string;
  isSubmitToolOutputs: boolean;
  outboundStream: boolean;
}): AnyRecord {
  const systemPromptOverride = args.entryEndpoint === '/v1/responses'
    ? getSystemPromptOverride()
    : null;
  return finalizeResponsesHandlerPayloadForHttpNative({
    payload: args.payload,
    isSubmitToolOutputs: args.isSubmitToolOutputs,
    outboundStream: args.outboundStream,
    systemPromptOverride,
  });
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

function serializeResponsesResumeErrorForHttp(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') {
    return { message: String(error ?? '') };
  }
  const source = error as Record<string, unknown>;
  return {
    name: source.name,
    message: source.message,
    status: source.status,
    code: source.code,
    origin: source.origin,
    details: source.details,
  };
}

function planResponsesResumeErrorForHttp(error: unknown): ReturnType<typeof planResponsesResumeErrorForHttpNative> {
  return planResponsesResumeErrorForHttpNative(serializeResponsesResumeErrorForHttp(error));
}

function planResponsesInboundToolHistoryErrorsampleForHttp(args: {
  requestId: string;
  entryEndpoint: string;
  body: unknown;
  error: unknown;
}): {
  action: 'none' | 'write_errorsample';
  write?: {
    group: string;
    kind: string;
    payload: Record<string, unknown>;
  };
} {
  return planResponsesInboundToolHistoryErrorsampleForHttpNative(args);
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
  const captured = captureReqInboundResponsesContextSnapshotJson({
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
  let continuationPlan = await planResponsesContinuationRequestAction({
    plannedEntry,
    entryEndpoint: args.entryEndpoint,
    requestId: args.requestId,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    ...(typeof args.matchedPort === 'number' ? { matchedPort: args.matchedPort } : {}),
    ...(args.routingPolicyGroup ? { routingPolicyGroup: args.routingPolicyGroup } : {}),
  });

  while (continuationPlan.action === 'execute_effect') {
    let effectResult: unknown;
    switch (continuationPlan.effect.operation) {
      case 'lookup_continuation':
        effectResult = await lookupResponsesContinuationByResponseId(
          continuationPlan.effect.args.responseId,
          continuationPlan.effect.args.options
        );
        break;
      case 'materialize_provider_owned_submit':
        effectResult = await materializeProviderOwnedSubmitContext({
          payload: continuationPlan.effect.args.payload,
        });
        break;
      case 'resume_relay':
        effectResult = await resumeResponsesConversation(
          continuationPlan.effect.args.responseId,
          continuationPlan.effect.args.payload,
          continuationPlan.effect.args.options
        );
        break;
      case 'materialize_scope':
        effectResult = await materializeLatestResponsesContinuationByScope(
          continuationPlan.effect.args
        );
        break;
    }
    continuationPlan = await planResponsesContinuationRequestAction({
      effectResult: {
        operation: continuationPlan.effect.operation,
        result: effectResult,
        resultPlanInput: continuationPlan.resultPlanInput,
      },
    });
  }

  return continuationPlan.result;
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
    if (preparedEntry.kind === 'client_error') {
      return {
        kind: 'client_error',
        status: preparedEntry.status,
        body: preparedEntry.body,
        requestBodyMetadata,
        streamPlan,
      };
    }
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
    const errorPlan = planResponsesResumeErrorForHttp(error);
    if (errorPlan.action === 'rethrow') {
      throw error;
    }
    if (errorPlan.action !== 'client_error' || errorPlan.status === undefined || !errorPlan.body) {
      throw new Error('[responses] invalid resume error plan');
    }
    return {
      kind: 'client_error',
      status: errorPlan.status,
      body: errorPlan.body as unknown as Record<string, unknown>,
      requestBodyMetadata,
      streamPlan,
    };
  }
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
  const error = args.error && typeof args.error === 'object'
    ? {
        name: (args.error as { name?: unknown }).name,
        message: (args.error as { message?: unknown }).message,
        code: (args.error as { code?: unknown }).code,
        details: (args.error as { details?: unknown }).details,
      }
    : { message: String(args.error ?? 'unknown_error') };
  const plan = planResponsesInboundToolHistoryErrorsampleForHttp({
    requestId: args.requestId,
    entryEndpoint: args.entryEndpoint,
    body: args.body,
    error,
  });
  if (plan.action !== 'write_errorsample' || !plan.write) {
    return;
  }
  await writeErrorsampleJson({
    group: plan.write.group,
    kind: plan.write.kind,
    payload: {
      ...plan.write.payload,
      timestamp: new Date().toISOString(),
    },
  });
}
