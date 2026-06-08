import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { ProviderProtocolError } from '../conversion/provider-protocol-error.js';
import {
  isEmptyClientResponsePayloadWithNative,
  isToolCallContinuationResponseWithNative
} from '../native/router-hotpath/native-chat-process-node-result-semantics.js';
import { extractCapturedChatSeed } from './backend-route-seed.js';

export function extractAppendUserTextFromFollowupPlan(followupPlan: unknown): string | undefined {
  if (!followupPlan || typeof followupPlan !== 'object' || Array.isArray(followupPlan)) {
    return undefined;
  }
  const injection = (followupPlan as { injection?: unknown }).injection;
  if (!injection || typeof injection !== 'object' || Array.isArray(injection)) {
    return undefined;
  }
  const ops = Array.isArray((injection as { ops?: unknown }).ops) ? ((injection as { ops: unknown[] }).ops as unknown[]) : [];
  for (const op of ops) {
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
      continue;
    }
    const record = op as Record<string, unknown>;
    if (record.op !== 'append_user_text') {
      continue;
    }
    if (typeof record.text === 'string' && record.text.trim().length > 0) {
      return record.text.trim();
    }
  }
  return undefined;
}

export function coerceFollowupPayloadStream(payload: JsonObject, stream: boolean): JsonObject {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  if (stream === false) {
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
  if (!followupBody || typeof followupBody !== 'object') {
    return args.finalChatResponse;
  }

  if (hasRequiresActionShape(followupBody)) {
    return followupBody;
  }

  if (!isEmptyClientResponsePayload(followupBody)) {
    return followupBody;
  }

  return args.finalChatResponse;
}

export function createEmptyFollowupError(args: {
  flowId?: string;
  requestId: string;
  lastError?: unknown;
  originalResponseWasEmpty?: boolean;
}): ProviderProtocolError & { status?: number; cause?: unknown } {
  const wrapped = new ProviderProtocolError(
    `[servertool] Followup returned empty response for flow ${args.flowId ?? 'unknown'}`,
    {
      code: 'SERVERTOOL_EMPTY_FOLLOWUP',
      category: 'EXTERNAL_ERROR',
      details: {
        flowId: args.flowId,
        requestId: args.requestId,
        error: args.lastError instanceof Error ? args.lastError.message : undefined,
        ...(args.originalResponseWasEmpty ? { originalResponseWasEmpty: true } : {})
      }
    }
  ) as ProviderProtocolError & { status?: number; cause?: unknown };
  wrapped.status = 502;
  wrapped.cause = args.lastError;
  return wrapped;
}

export function createMissingFollowupPayloadError(args: {
  flowId?: string;
  requestId: string;
  followupPlan: unknown;
  adapterContext: AdapterContext;
}): ProviderProtocolError & { status?: number } {
  const followupPlanRecord =
    args.followupPlan && typeof args.followupPlan === 'object' && !Array.isArray(args.followupPlan)
      ? (args.followupPlan as Record<string, unknown>)
      : undefined;
  const adapterRecord = args.adapterContext as Record<string, unknown> | null;
  const capturedEntryRequest = adapterRecord?.capturedEntryRequest;
  const capturedChatRequest = adapterRecord?.capturedChatRequest;
  const seedAvailable = Boolean(extractCapturedChatSeed(capturedEntryRequest ?? capturedChatRequest));
  const wrapped = new ProviderProtocolError('[servertool] followup payload missing for non-clientInject flow', {
    code: 'SERVERTOOL_FOLLOWUP_FAILED',
    category: 'INTERNAL_ERROR',
    details: {
      flowId: args.flowId,
      requestId: args.requestId,
      reason: 'followup_payload_missing',
      hasPayloadPlan: Boolean(followupPlanRecord && Object.prototype.hasOwnProperty.call(followupPlanRecord, 'payload')),
      hasInjectionPlan: Boolean(
        followupPlanRecord && Object.prototype.hasOwnProperty.call(followupPlanRecord, 'injection')
      ),
      hasMetadataPlan: Boolean(
        followupPlanRecord && Object.prototype.hasOwnProperty.call(followupPlanRecord, 'metadata')
      ),
      hasCapturedEntryRequest: Boolean(
        capturedEntryRequest &&
          typeof capturedEntryRequest === 'object' &&
          !Array.isArray(capturedEntryRequest)
      ),
      capturedSeedAvailable: seedAvailable
    }
  }) as ProviderProtocolError & { status?: number };
  wrapped.status = 502;
  return wrapped;
}
