// feature_id: responses.direct_tool_shape_contract
import { evaluateResponsesDirectRouteDecisionNative } from '../../../modules/llmswitch/bridge/native-exports.js';

export function evaluateDirectRouteDecision(
  payload: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
  inboundProtocol: string,
): {
  providerWireValid: boolean;
  requiresHubRelay: boolean;
  reason?: string;
  hasDeclaredApplyPatchTool?: boolean;
} {
  return evaluateResponsesDirectRouteDecisionNative({
    payload,
    metadata: metadata ?? {},
    inboundProtocol,
    applyPatchMode: 'client',
  });
}

export function requireDirectPassthroughPayloadObject(
  body: unknown,
): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('provider-runtime-error: direct passthrough payload must be an object');
  }
  return body as Record<string, unknown>;
}

export function findResponsesDirectFunctionCallOutputContentViolation(
  payload: Record<string, unknown>,
): string | undefined {
  const decision = evaluateDirectRouteDecision(payload, undefined, 'openai-responses');
  return decision.providerWireValid ? undefined : decision.reason;
}
