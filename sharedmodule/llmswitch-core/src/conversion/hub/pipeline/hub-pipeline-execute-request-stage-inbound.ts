import type { StageRecorder } from "../format-adapters/index.js";
import type { JsonObject } from "../types/json.js";
import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { HubPipelineConfig, HubPipelineNodeResult, NormalizedRequest } from "./hub-pipeline.js";
import type { RequestStageHooks } from "./hub-pipeline-stage-hooks.js";
import { type HubPolicyConfig } from "../policy/policy-engine.js";
import {
  applyInboundRuntimeHints,
  prepareInboundExecutionContext,
} from "./hub-pipeline-execute-request-stage-inbound-setup.js";
import { requireJsonObjectPayload } from "./hub-pipeline-shared-guards.js";
import {
  executeInboundGovernanceStage,
  executeInboundSemanticStages,
} from "./hub-pipeline-execute-request-stage-inbound-orchestration-blocks.js";
import {
  buildRequestStageInboundResult,
  finalizeInboundWorkingRequestResult,
} from "./hub-pipeline-execute-request-stage-inbound-result-blocks.js";

export interface RequestStageInboundResult<TContext = Record<string, unknown>> {
  rawRequest: JsonObject;
  semanticMapper: ReturnType<RequestStageHooks<TContext>["createSemanticMapper"]>;
  effectivePolicy: HubPolicyConfig | undefined;
  shadowCompareBaselineMode: NormalizedRequest["shadowCompare"] extends { baselineMode: infer T }
    ? T
    : never;
  inboundRecorder?: StageRecorder;
  contextSnapshot?: Record<string, unknown>;
  standardizedRequest: StandardizedRequest;
  processedRequest?: ProcessedRequest;
  workingRequest: StandardizedRequest | ProcessedRequest;
  activeProcessMode: "chat" | "passthrough";
  passthroughAudit?: Record<string, unknown>;
  nodeResults: HubPipelineNodeResult[];
  hasImageAttachment: boolean;
  serverToolRequired: boolean;
}

export async function executeRequestStageInbound<TContext = Record<string, unknown>>(args: {
  normalized: NormalizedRequest;
  hooks: RequestStageHooks<TContext>;
  config: HubPipelineConfig;
}): Promise<RequestStageInboundResult<TContext>> {
  const { normalized, hooks, config } = args;
  const rawRequest = requireJsonObjectPayload(normalized);

  applyInboundRuntimeHints(normalized, rawRequest);
  const {
    effectivePolicy,
    shadowCompareBaselineMode,
    inboundAdapterContext,
    inboundRecorder,
    inboundStart,
  } = prepareInboundExecutionContext({
    normalized,
    config,
  });

  const {
    contextSnapshot,
    standardizedRequest,
    activeProcessMode,
    passthroughAudit,
  } = await executeInboundSemanticStages({
    normalized,
    hooks,
    semanticMapper: hooks.createSemanticMapper(),
    rawRequest,
    effectivePolicy,
    inboundAdapterContext,
    inboundRecorder,
  });
  const { processedRequest, nodeResults } = await executeInboundGovernanceStage({
    normalized,
    config,
    standardizedRequest,
    rawRequest,
    inboundRecorder,
    inboundStart,
    activeProcessMode,
    passthroughAudit,
  });

  const {
    workingRequest,
    hasImageAttachment,
    serverToolRequired,
  } = finalizeInboundWorkingRequestResult(
    (processedRequest ?? standardizedRequest) as unknown as Record<
      string,
      unknown
    >,
    normalized,
  );

  return buildRequestStageInboundResult({
    rawRequest,
    hooks,
    effectivePolicy,
    shadowCompareBaselineMode,
    inboundRecorder,
    contextSnapshot: contextSnapshot as Record<string, unknown> | undefined,
    standardizedRequest,
    processedRequest,
    workingRequest,
    activeProcessMode,
    passthroughAudit,
    nodeResults,
    hasImageAttachment,
    serverToolRequired,
  });
}
