import type { StageRecorder } from "../format-adapters/index.js";
import type { JsonObject } from "../types/json.js";
import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { HubPipelineConfig, HubPipelineNodeResult, NormalizedRequest } from "./hub-pipeline.js";
import type { RequestStageHooks } from "./hub-pipeline-stage-hooks.js";
import {
  resolveActiveProcessModeAndAudit,
  sanitizeStandardizedRequestMessages,
} from "./hub-pipeline-chat-process-request-utils.js";
import { propagateApplyPatchToolModeToRequestMetadata } from "./hub-pipeline-request-metadata-blocks.js";
import type { AdapterContext } from "../types/chat-envelope.js";
import type { HubPolicyConfig } from "../policy/policy-engine.js";
import { runInboundSemanticPipeline } from "./hub-pipeline-execute-request-stage-inbound-semantic-blocks.js";
import {
  prepareInboundGovernanceContext,
  runInboundGovernancePipeline,
} from "./hub-pipeline-execute-request-stage-inbound-governance-blocks.js";

export async function executeInboundSemanticStages<TContext = Record<string, unknown>>(args: {
  normalized: NormalizedRequest;
  hooks: RequestStageHooks<TContext>;
  semanticMapper: ReturnType<RequestStageHooks<TContext>["createSemanticMapper"]>;
  rawRequest: JsonObject;
  effectivePolicy: HubPolicyConfig | undefined;
  inboundAdapterContext: AdapterContext;
  inboundRecorder?: StageRecorder;
}): Promise<{
  contextSnapshot?: Record<string, unknown>;
  standardizedRequest: StandardizedRequest;
  activeProcessMode: "chat" | "passthrough";
  passthroughAudit?: Record<string, unknown>;
}> {
  const { contextSnapshot, standardizedRequestBase } =
    await runInboundSemanticPipeline({
      normalized: args.normalized,
      hooks: args.hooks,
      semanticMapper: args.semanticMapper,
      rawRequest: args.rawRequest,
      effectivePolicy: args.effectivePolicy,
      inboundAdapterContext: args.inboundAdapterContext,
      inboundRecorder: args.inboundRecorder,
    });

  const standardizedRequest = sanitizeStandardizedRequestMessages(
    standardizedRequestBase as unknown as StandardizedRequest,
  );
  propagateApplyPatchToolModeToRequestMetadata(
    args.normalized.metadata as Record<string, unknown> | undefined,
    standardizedRequest,
  );

  const { activeProcessMode, passthroughAudit } =
    resolveActiveProcessModeAndAudit({
      normalized: args.normalized,
      requestMessages: standardizedRequest.messages,
      rawPayload: args.rawRequest,
    });

  return {
    contextSnapshot: contextSnapshot as Record<string, unknown> | undefined,
    standardizedRequest,
    activeProcessMode,
    passthroughAudit,
  };
}

export async function executeInboundGovernanceStage(args: {
  normalized: NormalizedRequest;
  config: HubPipelineConfig;
  standardizedRequest: StandardizedRequest;
  rawRequest: JsonObject;
  inboundRecorder?: StageRecorder;
  inboundStart: number;
  activeProcessMode: "chat" | "passthrough";
  passthroughAudit?: Record<string, unknown>;
}): Promise<{
  processedRequest?: ProcessedRequest;
  nodeResults: HubPipelineNodeResult[];
}> {
  const { nodeResults, metadata } = prepareInboundGovernanceContext({
    normalized: args.normalized,
    config: args.config,
    standardizedRequest: args.standardizedRequest,
    inboundStart: args.inboundStart,
    activeProcessMode: args.activeProcessMode,
  });

  const processedRequest = await runInboundGovernancePipeline({
    normalized: args.normalized,
    standardizedRequest: args.standardizedRequest,
    rawRequest: args.rawRequest,
    inboundRecorder: args.inboundRecorder,
    activeProcessMode: args.activeProcessMode,
    passthroughAudit: args.passthroughAudit,
    nodeResults,
    metadata,
  });

  return {
    processedRequest,
    nodeResults,
  };
}
