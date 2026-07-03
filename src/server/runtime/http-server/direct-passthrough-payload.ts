// feature_id: responses.direct_tool_shape_contract

import { evaluateResponsesDirectRouteDecisionNative } from '../../../modules/llmswitch/bridge.js';

export function requireDirectPassthroughPayloadObject(
  body: unknown,
): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('provider-runtime-error: direct passthrough payload must be an object');
  }
  return body as Record<string, unknown>;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function buildDirectRouteDecisionMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object') {
    return {};
  }
  const snapshot = metadata.metadataCenterSnapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return {};
  }
  const runtimeControl = (snapshot as Record<string, unknown>).runtimeControl;
  if (!runtimeControl || typeof runtimeControl !== 'object' || Array.isArray(runtimeControl)) {
    return {};
  }
  const runtimeControlRecord = runtimeControl as Record<string, unknown>;
  const stopMessage = runtimeControlRecord.stopMessage;
  const stopMessageRecord =
    stopMessage && typeof stopMessage === 'object' && !Array.isArray(stopMessage)
      ? stopMessage as Record<string, unknown>
      : undefined;
  const stopMessageEnabled =
    readBoolean(runtimeControlRecord.stopMessageEnabled)
    ?? readBoolean(stopMessageRecord?.enabled);
  const stopMessageExcludeDirect =
    readBoolean(runtimeControlRecord.stopMessageExcludeDirect)
    ?? readBoolean(stopMessageRecord?.excludeDirect);
  const directRuntimeControl: Record<string, unknown> = {
    ...(typeof stopMessageEnabled === 'boolean' ? { stopMessageEnabled } : {}),
    ...(typeof stopMessageExcludeDirect === 'boolean' ? { stopMessageExcludeDirect } : {}),
  };
  return Object.keys(directRuntimeControl).length > 0
    ? { metadataCenterSnapshot: { runtimeControl: directRuntimeControl } }
    : {};
}

export function evaluateDirectRouteDecision(input: {
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  inboundProtocol: string;
  applyPatchMode?: string;
}): {
  providerWireValid: boolean;
  requiresHubRelay: boolean;
  reason?: string;
  hasDeclaredApplyPatchTool?: boolean;
} {
  return evaluateResponsesDirectRouteDecisionNative({
    payload: input.payload,
    metadata: buildDirectRouteDecisionMetadata(input.metadata),
    inboundProtocol: input.inboundProtocol,
    applyPatchMode: input.applyPatchMode,
  });
}
