import type { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";
import type {
  HubPipelineConfig,
  HubPipelineResult,
  NormalizedRequest,
} from "./hub-pipeline.js";
import type { RequestStageHooks } from "./hub-pipeline-stage-hooks.js";
import {
  executeRequestStageInbound,
} from "./hub-pipeline-execute-request-stage-inbound.js";
import {
  executeRouteAndBuildOutbound,
} from "./hub-pipeline-route-and-outbound.js";

export async function executeRequestStagePipeline<TContext = Record<string, unknown>>(args: {
  normalized: NormalizedRequest;
  hooks: RequestStageHooks<TContext>;
  routerEngine: VirtualRouterEngine;
  config: HubPipelineConfig;
}): Promise<HubPipelineResult> {
  const { normalized, hooks, routerEngine, config } = args;

  const inbound = await executeRequestStageInbound({
    normalized,
    hooks,
    config,
  });

  const outbound = await executeRouteAndBuildOutbound({
    normalized,
    hooks,
    routerEngine,
    config,
    workingRequest: inbound.workingRequest,
    nodeResults: inbound.nodeResults,
    inboundRecorder: inbound.inboundRecorder,
    activeProcessMode: inbound.activeProcessMode,
    responsesResume: inbound.responsesResume,
    serverToolRequired: inbound.serverToolRequired,
    hasImageAttachment: inbound.hasImageAttachment,
    passthroughAudit: inbound.passthroughAudit,
    rawRequest: inbound.rawRequest,
    contextSnapshot: inbound.contextSnapshot,
    semanticMapper: inbound.semanticMapper,
    effectivePolicy: inbound.effectivePolicy,
    shadowCompareBaselineMode: inbound.shadowCompareBaselineMode,
    routeSelectTiming: {
      enabled: true,
      requestId: normalized.id,
    },
  });

  return {
    requestId: normalized.id,
    providerPayload: outbound.providerPayload,
    standardizedRequest: inbound.standardizedRequest,
    processedRequest: inbound.processedRequest,
    routingDecision: outbound.routingDecision,
    routingDiagnostics: outbound.routingDiagnostics,
    target: outbound.target,
    metadata: outbound.metadata,
    nodeResults: inbound.nodeResults,
  };
}
