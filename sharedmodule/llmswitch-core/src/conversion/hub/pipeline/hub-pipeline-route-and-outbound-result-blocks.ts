import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type {
  HubPipelineResult,
  NormalizedRequest,
} from "./hub-pipeline.js";
import type { HubPolicyMode } from "../policy/policy-engine.js";
import {
  buildValidatedCapturedChatRequest,
  finalizeRouteAndOutboundMetadata,
} from "./hub-pipeline-route-and-outbound-metadata-blocks.js";

type ShadowCompareBaselineMode =
  NormalizedRequest["shadowCompare"] extends { baselineMode: infer T }
    ? T
    : never;

export function buildRouteAndOutboundResultMetadata(args: {
  normalized: NormalizedRequest;
  capturedWorkingRequest: StandardizedRequest | ProcessedRequest;
  activeProcessMode: "chat" | "passthrough";
  outboundProtocol: NormalizedRequest["providerProtocol"];
  target: HubPipelineResult["target"];
  outboundStream: boolean;
  passthroughAudit?: Record<string, unknown>;
  shadowCompareBaselineMode?: ShadowCompareBaselineMode;
  effectivePolicyMode?: HubPolicyMode;
  shadowBaselineProviderPayload?: Record<string, unknown>;
  hasImageAttachment: boolean;
}): Record<string, unknown> {
  const capturedChatRequest = buildValidatedCapturedChatRequest({
    normalized: args.normalized,
    workingRequest: args.capturedWorkingRequest,
    activeProcessMode: args.activeProcessMode,
  });
  return finalizeRouteAndOutboundMetadata({
    normalized: args.normalized,
    outboundProtocol: args.outboundProtocol,
    target: args.target,
    outboundStream: args.outboundStream,
    capturedChatRequest,
    passthroughAudit: args.passthroughAudit,
    shadowCompareBaselineMode: args.shadowCompareBaselineMode,
    effectivePolicyMode: args.effectivePolicyMode,
    shadowBaselineProviderPayload: args.shadowBaselineProviderPayload,
    hasImageAttachment: args.hasImageAttachment,
  });
}

export function buildRouteAndOutboundExecutionResult(args: {
  providerPayload?: Record<string, unknown>;
  metadata: Record<string, unknown>;
  routingDecision?: HubPipelineResult["routingDecision"];
  routingDiagnostics?: HubPipelineResult["routingDiagnostics"];
  target?: HubPipelineResult["target"];
  workingRequest: StandardizedRequest | ProcessedRequest;
}): {
  providerPayload?: Record<string, unknown>;
  metadata: Record<string, unknown>;
  routingDecision?: HubPipelineResult["routingDecision"];
  routingDiagnostics?: HubPipelineResult["routingDiagnostics"];
  target?: HubPipelineResult["target"];
  workingRequest: StandardizedRequest | ProcessedRequest;
} {
  return {
    providerPayload: args.providerPayload,
    metadata: args.metadata,
    routingDecision: args.routingDecision,
    routingDiagnostics: args.routingDiagnostics,
    target: args.target,
    workingRequest: args.workingRequest,
  };
}
