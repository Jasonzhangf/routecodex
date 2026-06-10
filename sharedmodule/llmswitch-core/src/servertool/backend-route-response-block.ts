import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  ProviderProtocolError,
  type ProviderErrorCategory,
  type ProviderProtocolErrorCode
} from '../conversion/provider-protocol-error.js';
import {
  isEmptyClientResponsePayloadWithNative,
  isToolCallContinuationResponseWithNative
} from '../native/router-hotpath/native-chat-process-node-result-semantics.js';
import {
  planEmptyFollowupErrorWithNative,
  planFollowupAppendUserTextWithNative,
  planFollowupPayloadStreamWithNative,
  planMissingFollowupPayloadErrorWithNative,
  planPreferredFinalResponseWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';

export function extractAppendUserTextFromFollowupPlan(followupPlan: unknown): string | undefined {
  return planFollowupAppendUserTextWithNative(followupPlan).text ?? undefined;
}

export function coerceFollowupPayloadStream(payload: JsonObject, stream: boolean): JsonObject {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  const plan = planFollowupPayloadStreamWithNative(stream);
  if (plan.stream === false) {
    (payload as Record<string, unknown>).stream = false;
  }
  return payload;
}

export function isEmptyClientResponsePayload(payload: JsonObject): boolean {
  return isEmptyClientResponsePayloadWithNative(payload);
}

export function hasRequiresActionShape(payload: JsonObject): boolean {
  return isToolCallContinuationResponseWithNative(payload);
}

export function choosePreferredFinalChatResponse(args: {
  followupBody?: JsonObject;
  finalChatResponse: JsonObject;
}): JsonObject {
  const followupBody = args.followupBody;
  const plan = planPreferredFinalResponseWithNative({
    hasFollowupBody: Boolean(followupBody && typeof followupBody === 'object'),
    hasRequiresActionShape: Boolean(followupBody && hasRequiresActionShape(followupBody)),
    isEmptyClientResponsePayload: Boolean(followupBody && isEmptyClientResponsePayload(followupBody))
  });
  return plan.source === 'followup_body' && followupBody ? followupBody : args.finalChatResponse;
}

export function createEmptyFollowupError(args: {
  flowId?: string;
  requestId: string;
  lastError?: unknown;
  originalResponseWasEmpty?: boolean;
}): ProviderProtocolError & { status?: number; cause?: unknown } {
  const plan = planEmptyFollowupErrorWithNative({
    flowId: args.flowId,
    requestId: args.requestId,
    lastErrorMessage: args.lastError instanceof Error ? args.lastError.message : undefined,
    originalResponseWasEmpty: args.originalResponseWasEmpty === true
  });
  const wrapped = buildProviderProtocolErrorFromPlan(plan) as ProviderProtocolError & { status?: number; cause?: unknown };
  wrapped.cause = args.lastError;
  return wrapped;
}

export function createMissingFollowupPayloadError(args: {
  flowId?: string;
  requestId: string;
  followupPlan: unknown;
  adapterContext: AdapterContext;
}): ProviderProtocolError & { status?: number } {
  return buildProviderProtocolErrorFromPlan(planMissingFollowupPayloadErrorWithNative({
    flowId: args.flowId,
    requestId: args.requestId,
    followupPlan: args.followupPlan,
    adapterContext: args.adapterContext
  }));
}

function buildProviderProtocolErrorFromPlan(plan: {
  message: string;
  code: string;
  category: string;
  status: number;
  details: Record<string, unknown>;
}): ProviderProtocolError & { status?: number } {
  const wrapped = new ProviderProtocolError(plan.message, {
    code: plan.code as ProviderProtocolErrorCode,
    category: plan.category as ProviderErrorCategory,
    details: plan.details
  }) as ProviderProtocolError & { status?: number };
  wrapped.status = plan.status;
  return wrapped;
}
