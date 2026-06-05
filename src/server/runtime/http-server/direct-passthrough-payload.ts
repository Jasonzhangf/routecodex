import {
  applyResponsesDirectRouteParamsOverrideNative,
  evaluateResponsesDirectRouteDecisionNative,
  resolveResponsesDirectPayloadNative,
} from '../../../modules/llmswitch/bridge.js';
import {
  projectResponsesDirectContractDecision,
} from '../../../providers/core/runtime/responses-direct-contract-error.js';

// feature_id: responses.direct_tool_shape_contract

export function resolveRawPayloadForDirect(
  body: unknown,
  metadata?: Record<string, unknown>,
): Record<string, unknown> {
  return resolveResponsesDirectPayloadNative({
    body,
    rawRequestBody:
      metadata?.__raw_request_body && typeof metadata.__raw_request_body === 'object' && !Array.isArray(metadata.__raw_request_body)
        ? metadata.__raw_request_body as Record<string, unknown>
        : undefined,
    bodyStream:
      !!body && typeof body === 'object' && !Array.isArray(body) && (body as Record<string, unknown>).stream === true,
    metadataStream: metadata?.stream === true,
    outboundStream: metadata?.outboundStream === true,
  });
}

export function applyMinimalDirectOverrides(
  payload: Record<string, unknown>,
  options?: {
    routeParams?: Record<string, unknown>;
  }
): Record<string, unknown> {
  return applyResponsesDirectRouteParamsOverrideNative({
    payload,
    routeParams: options?.routeParams,
  });
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
  // canonical Rust entrypoint: evaluate_responses_direct_route_decision_json
  return evaluateResponsesDirectRouteDecisionNative(args);
}

export function assertDirectRouteDecision(args: {
  payload: Record<string, unknown>;
  inboundProtocol: string;
  applyPatchMode?: string;
}): void {
  projectResponsesDirectContractDecision(evaluateDirectRouteDecision(args));
}
