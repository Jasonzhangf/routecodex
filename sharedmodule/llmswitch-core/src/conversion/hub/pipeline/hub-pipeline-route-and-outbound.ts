import type { JsonObject } from "../types/json.js";
import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";
import type { StageRecorder } from "../format-adapters/index.js";
import type {
  HubPipelineConfig,
  HubPipelineNodeResult,
  HubPipelineResult,
  NormalizedRequest,
} from "./hub-pipeline.js";
import type { RequestStageHooks } from "./hub-pipeline-stage-hooks.js";
import type { HubPolicyConfig } from "../policy/policy-engine.js";
import {
} from "./hub-pipeline-route-and-outbound-metadata-blocks.js";
import {
  buildOutboundProviderPayloadBundle,
  resolveRouteSelectionAndOutboundContext,
} from "./hub-pipeline-route-and-outbound-orchestration-blocks.js";
import {
  buildRouteAndOutboundExecutionResult,
  buildRouteAndOutboundResultMetadata,
} from "./hub-pipeline-route-and-outbound-result-blocks.js";

type ShadowCompareBaselineMode =
  NormalizedRequest["shadowCompare"] extends { baselineMode: infer T }
    ? T
    : never;

export async function executeRouteAndBuildOutbound<TContext = Record<string, unknown>>(args: {
  normalized: NormalizedRequest;
  hooks: RequestStageHooks<TContext>;
  routerEngine: VirtualRouterEngine;
  config: HubPipelineConfig;
  workingRequest: StandardizedRequest | ProcessedRequest;
  nodeResults: HubPipelineNodeResult[];
  inboundRecorder?: StageRecorder;
  activeProcessMode: "chat" | "passthrough";
  serverToolRequired: boolean;
  hasImageAttachment: boolean;
  passthroughAudit?: Record<string, unknown>;
  rawRequest: JsonObject;
  contextSnapshot?: Record<string, unknown>;
  semanticMapper: ReturnType<RequestStageHooks<TContext>["createSemanticMapper"]>;
  effectivePolicy?: HubPolicyConfig;
  shadowCompareBaselineMode?: ShadowCompareBaselineMode;
  routeSelectTiming?: {
    enabled?: boolean;
    requestId?: string;
  };
}): Promise<{
  providerPayload?: Record<string, unknown>;
  metadata: Record<string, unknown>;
  routingDecision?: HubPipelineResult["routingDecision"];
  routingDiagnostics?: HubPipelineResult["routingDiagnostics"];
  target?: HubPipelineResult["target"];
  workingRequest: StandardizedRequest | ProcessedRequest;
}> {
  const {
    normalized,
    hooks,
    routerEngine,
    config,
    nodeResults,
    inboundRecorder,
    activeProcessMode,
    serverToolRequired,
    hasImageAttachment,
    passthroughAudit,
    rawRequest,
    contextSnapshot,
    semanticMapper,
    effectivePolicy,
    shadowCompareBaselineMode,
    routeSelectTiming,
  } = args;
  let { workingRequest } = args;
  const routeContext = resolveRouteSelectionAndOutboundContext({
    normalized,
    routerEngine,
    workingRequest,
    activeProcessMode,
    serverToolRequired,
    inboundRecorder,
    routeSelectTiming,
  });
  workingRequest = routeContext.workingRequest;

  const { providerPayload, shadowBaselineProviderPayload } =
    await buildOutboundProviderPayloadBundle({
      normalized,
      hooks,
      config,
      workingRequest,
      rawRequest,
      contextSnapshot,
      activeProcessMode,
      passthroughAudit,
      outboundProtocol: routeContext.outboundProtocol,
      outboundAdapterContext: routeContext.outboundAdapterContext,
      outboundStream: routeContext.outboundStream,
      semanticMapper,
      effectivePolicy,
      shadowCompareBaselineMode,
      nodeResults,
    });
  const metadata = buildRouteAndOutboundResultMetadata({
    normalized,
    workingRequest,
    activeProcessMode,
    outboundProtocol: routeContext.outboundProtocol,
    target: routeContext.routing.target,
    outboundStream: routeContext.outboundStream,
    passthroughAudit,
    shadowCompareBaselineMode,
    effectivePolicyMode: effectivePolicy?.mode ?? "off",
    shadowBaselineProviderPayload,
    hasImageAttachment,
  });

  return buildRouteAndOutboundExecutionResult({
    providerPayload,
    metadata,
    routingDecision: routeContext.routing.decision,
    routingDiagnostics: routeContext.routing.diagnostics,
    target: routeContext.routing.target,
    workingRequest,
  });
}
