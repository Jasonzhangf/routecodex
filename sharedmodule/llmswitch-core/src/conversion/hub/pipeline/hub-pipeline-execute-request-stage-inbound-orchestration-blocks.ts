import type { StageRecorder } from "../format-adapters/index.js";
import type { JsonObject } from "../types/json.js";
import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { HubPipelineConfig, HubPipelineNodeResult, NormalizedRequest } from "./hub-pipeline.js";
import type { RequestStageHooks } from "./hub-pipeline-stage-hooks.js";
import {
  sanitizeStandardizedRequestMessages,
} from "./hub-pipeline-chat-process-request-utils.js";
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

  return {
    contextSnapshot: contextSnapshot as Record<string, unknown> | undefined,
    standardizedRequest,
  };
}

export async function executeInboundGovernanceStage(args: {
  normalized: NormalizedRequest;
  config: HubPipelineConfig;
  standardizedRequest: StandardizedRequest;
  rawRequest: JsonObject;
  inboundRecorder?: StageRecorder;
  inboundStart: number;
  }): Promise<{
  processedRequest?: ProcessedRequest;
  nodeResults: HubPipelineNodeResult[];
}> {
  const { nodeResults, metadata } = prepareInboundGovernanceContext({
    normalized: args.normalized,
    config: args.config,
    standardizedRequest: args.standardizedRequest,
    inboundStart: args.inboundStart,
  });

  const processedRequest = await runInboundGovernancePipeline({
    normalized: args.normalized,
    standardizedRequest: args.standardizedRequest,
    rawRequest: args.rawRequest,
    inboundRecorder: args.inboundRecorder,
    nodeResults,
    metadata,
  });

  return {
    processedRequest,
    nodeResults,
  };
}
