import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type {
  HubPipelineConfig,
  HubPipelineNodeResult,
  HubPipelineResult,
  NormalizedRequest,
} from "./hub-pipeline.js";
import {
  buildReqInboundSkippedNodeWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import {
  attachHubStageTopSummary,
  executeToolGovernanceOrPassthrough,
} from "./hub-pipeline-governance-blocks.js";

export function createChatProcessEntryNodeResults(): HubPipelineNodeResult[] {
  return [
    buildReqInboundSkippedNodeWithNative({
      reason: "stage=outbound",
    }) as unknown as HubPipelineNodeResult,
  ];
}

export async function executeChatProcessGovernancePhase(args: {
  normalized: NormalizedRequest;
  standardizedRequest: StandardizedRequest;
  rawPayload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  stageRecorder: unknown;
  activeProcessMode: "chat" | "passthrough";
  passthroughAudit?: Record<string, unknown>;
  nodeResults: HubPipelineNodeResult[];
}): Promise<ProcessedRequest | undefined> {
  return executeToolGovernanceOrPassthrough({
    requestId: args.normalized.id,
    entryEndpoint: args.normalized.entryEndpoint,
    standardizedRequest: args.standardizedRequest,
    rawPayload: args.rawPayload,
    metadata: args.metadata,
    stageRecorder: args.stageRecorder as any,
    activeProcessMode: args.activeProcessMode,
    passthroughAudit: args.passthroughAudit,
    nodeResults: args.nodeResults,
  });
}

export function buildChatProcessEntryPipelineResult(args: {
  normalized: NormalizedRequest;
  standardizedRequest: StandardizedRequest;
  processedRequest?: ProcessedRequest;
  outbound: {
    providerPayload?: Record<string, unknown>;
    routingDecision?: HubPipelineResult["routingDecision"];
    routingDiagnostics?: HubPipelineResult["routingDiagnostics"];
    target?: HubPipelineResult["target"];
    metadata: Record<string, unknown>;
  };
  nodeResults: HubPipelineNodeResult[];
}): HubPipelineResult {
  attachHubStageTopSummary({
    requestId: args.normalized.id,
    metadata: args.outbound.metadata,
  });

  return {
    requestId: args.normalized.id,
    providerPayload: args.outbound.providerPayload,
    standardizedRequest: args.standardizedRequest,
    processedRequest: args.processedRequest,
    routingDecision: args.outbound.routingDecision,
    routingDiagnostics: args.outbound.routingDiagnostics,
    target: args.outbound.target,
    metadata: args.outbound.metadata,
    nodeResults: args.nodeResults,
  };
}

export function resolveChatProcessEffectivePolicy(
  normalized: NormalizedRequest,
  config: HubPipelineConfig,
): HubPipelineConfig["policy"] | undefined {
  return normalized.policyOverride ?? config.policy;
}
