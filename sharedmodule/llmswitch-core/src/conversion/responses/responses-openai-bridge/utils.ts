import type { BridgeInputItem } from '../../bridge-message-utils.js';
import type { JsonObject } from '../../hub/types/json.js';
import type { ResponsesRequestContext } from '../responses-openai-bridge.js';
import {
  buildSlimResponsesBridgeContextWithNative,
  extractResponsesMetadataExtraFieldsWithNative,
  mergeRetainedResponsesRequestParametersWithNative,
  pickResponsesBridgeDecisionMetadataWithNative,
  pickResponsesRequestParametersWithNative,
  pickResponsesToolPassthroughFieldsWithNative,
  sanitizeCapturedResponsesInputWithNative,
  stripResponsesToolControlFieldsWithNative,
  unwrapResponsesDataWithNative
} from '../../../native/router-hotpath/native-hub-bridge-action-semantics.js';

export function collectResponsesRequestParameters(
  payload: Record<string, unknown> | undefined,
  options?: {
    streamHint?: boolean | undefined;
  }
): Record<string, unknown> | undefined {
  return pickResponsesRequestParametersWithNative({
    payload,
    streamHint: options?.streamHint
  });
}

export function pickResponsesToolPassthroughFields(
  value: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  return pickResponsesToolPassthroughFieldsWithNative({ value });
}

export function buildSlimResponsesBridgeContext(
  context: ResponsesRequestContext | undefined
): Record<string, unknown> | undefined {
  return buildSlimResponsesBridgeContextWithNative(context as Record<string, unknown> | undefined);
}

export function buildSlimBridgeDecisionMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  return pickResponsesBridgeDecisionMetadataWithNative(metadata);
}

export function sanitizeCapturedResponsesInput(
  input: BridgeInputItem[] | undefined
): BridgeInputItem[] | undefined {
  if (!Array.isArray(input) || input.length === 0) {
    return input;
  }
  return sanitizeCapturedResponsesInputWithNative({ input }).input as BridgeInputItem[];
}

export function extractMetadataExtraFields(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  return extractResponsesMetadataExtraFieldsWithNative(metadata);
}

export function stripToolControlFieldsFromContextMetadata(
  metadata: JsonObject | undefined
): JsonObject | undefined {
  return stripResponsesToolControlFieldsWithNative({
    value: metadata,
    nestedExtraFields: true
  }) as JsonObject | undefined;
}

export function stripToolControlFieldsFromParameterObject(
  value: JsonObject | undefined
): JsonObject | undefined {
  return stripResponsesToolControlFieldsWithNative({
    value,
    nestedExtraFields: false
  }) as JsonObject | undefined;
}

export function mergeRetainedResponsesRequestParameters(
  request: Record<string, unknown>,
  retainedParameters: Record<string, unknown> | undefined
): Record<string, unknown> {
  return mergeRetainedResponsesRequestParametersWithNative({
    request,
    retainedParameters
  });
}

export function unwrapData(value: Record<string, unknown>): Record<string, unknown> {
  return unwrapResponsesDataWithNative({ value });
}
