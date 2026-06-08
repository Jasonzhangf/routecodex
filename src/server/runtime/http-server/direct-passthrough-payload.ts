import {
  evaluateResponsesDirectRouteDecisionNative,
} from '../../../modules/llmswitch/bridge.js';
import {
  projectResponsesDirectContractDecision,
} from '../../../providers/core/runtime/responses-direct-contract-error.js';

// feature_id: responses.direct_tool_shape_contract

export function resolveRawPayloadForDirect(
  body: unknown,
  metadata?: Record<string, unknown>,
): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('provider-runtime-error: direct passthrough payload must be an object');
  }
  const payload = body as Record<string, unknown>;
  if ((metadata?.stream === true || metadata?.outboundStream === true) && payload.stream !== true) {
    payload.stream = true;
  }
  return payload;
}

export function applyMinimalDirectOverrides(
  payload: Record<string, unknown>,
  options?: {
    routeParams?: Record<string, unknown>;
  }
): Record<string, unknown> {
  const routeModel = typeof options?.routeParams?.model === 'string'
    ? options.routeParams.model.trim()
    : '';
  if (routeModel) {
    payload.model = routeModel;
  }
  return payload;
}

export function evaluateDirectRouteDecision(args: {
  payload: Record<string, unknown>;
  inboundProtocol: string;
  applyPatchMode?: string;
}): {
  providerWireValid: boolean;
  requiresHubRelay: boolean;
  reason?: string;
  hasDeclaredApplyPatchTool?: boolean;
} {
  const nativeDecision = evaluateResponsesDirectRouteDecisionNative(args);
  return {
    providerWireValid: nativeDecision.providerWireValid,
    requiresHubRelay: nativeDecision.requiresHubRelay,
    reason: nativeDecision.reason,
    hasDeclaredApplyPatchTool: nativeDecision.hasDeclaredApplyPatchTool,
  };
}

export function assertDirectRouteDecision(args: {
  payload: Record<string, unknown>;
  inboundProtocol: string;
  applyPatchMode?: string;
}): void {
  projectResponsesDirectContractDecision(evaluateDirectRouteDecision(args));
}
