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
  return evaluateResponsesDirectRouteDecisionNative(input);
}
