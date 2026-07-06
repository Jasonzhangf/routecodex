import { evaluateResponsesHostPolicy } from '../responses-host-policy.js';
import {
  consumeResponsesPayloadSnapshotByAliasesWithNative as consumeResponsesPayloadSnapshotByAliases,
  consumeResponsesPassthroughByAliasesWithNative as consumeResponsesPassthroughByAliases,
  planResponsesPayloadFromChatCloseoutWithNative
} from '../../../native/router-hotpath/native-hub-pipeline-resp-semantics.js';
import {
  stripInternalToolingMetadata
} from '../../shared/responses-tool-utils.js';
import type { ResponsesRequestContext } from './types.js';
import {
  buildResponsesPayloadFromChatWithNative
} from '../../../native/router-hotpath/native-hub-pipeline-resp-semantics.js';

function shouldStripHostManagedFields(context?: ResponsesRequestContext): boolean {
  const result = evaluateResponsesHostPolicy(context, typeof context?.targetProtocol === 'string' ? context?.targetProtocol : undefined);
  return result.shouldStripHostManagedFields;
}

export function buildResponsesPayloadFromChat(payload: unknown, context?: ResponsesRequestContext): Record<string, unknown> | unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const stripHostManagedFields = shouldStripHostManagedFields(context);
  const closeoutPlan = planResponsesPayloadFromChatCloseoutWithNative(payload, {
    requestId: context?.requestId,
    toolsRaw: Array.isArray(context?.toolsRaw) ? context.toolsRaw : [],
    metadata: context?.metadata,
    stripHostManagedFields
  });
  const response = closeoutPlan.response as Record<string, unknown> | undefined;
  if (!response || typeof response !== 'object') return payload;

  if (closeoutPlan.kind === 'existing_responses_payload') {
    const plannedPayload = closeoutPlan.payload;
    if (plannedPayload && typeof plannedPayload === 'object' && !Array.isArray(plannedPayload)) {
      if ((plannedPayload as any).metadata) {
        stripInternalToolingMetadata((plannedPayload as any).metadata);
      }
      return plannedPayload;
    }
    return payload;
  }

  const snapshotLookupKeys = Array.isArray(closeoutPlan.snapshotLookupKeys)
    ? (closeoutPlan.snapshotLookupKeys as unknown[]).filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const snapshotPayload = snapshotLookupKeys.length ? consumeResponsesPayloadSnapshotByAliases(snapshotLookupKeys) : undefined;
  const passthroughPayload = snapshotLookupKeys.length ? consumeResponsesPassthroughByAliases(snapshotLookupKeys) : undefined;
  const sourceForRetention =
    (passthroughPayload && typeof passthroughPayload === 'object' ? passthroughPayload : undefined) ??
    (closeoutPlan.inlinePassthrough && typeof closeoutPlan.inlinePassthrough === 'object' && !Array.isArray(closeoutPlan.inlinePassthrough)
      ? (closeoutPlan.inlinePassthrough as Record<string, unknown>)
      : undefined) ??
    (snapshotPayload && typeof snapshotPayload === 'object' ? snapshotPayload : undefined) ??
    (closeoutPlan.inlineSnapshot && typeof closeoutPlan.inlineSnapshot === 'object' && !Array.isArray(closeoutPlan.inlineSnapshot)
      ? (closeoutPlan.inlineSnapshot as Record<string, unknown>)
      : undefined);

  const nativeBuilt = buildResponsesPayloadFromChatWithNative(response as Record<string, unknown>, {
    requestId: context?.requestId,
    toolsRaw: Array.isArray(context?.toolsRaw) ? context?.toolsRaw : [],
    metadata: context?.metadata,
    stripHostManagedFields,
    sourceForRetention: sourceForRetention as Record<string, unknown> | undefined
  });

  const out: any = {
    ...nativeBuilt
  };
  if ((out as any).metadata) {
    stripInternalToolingMetadata((out as any).metadata);
  }
  return out;
}

export function extractRequestIdFromResponse(response: any): string | undefined {
  if (response && typeof response === 'object' && 'metadata' in response && (response as any).metadata && typeof (response as any).metadata === 'object') {
    const meta = (response as any).metadata as Record<string, unknown>;
    if (typeof meta.requestId === 'string') return meta.requestId;
  }
  return undefined;
}
