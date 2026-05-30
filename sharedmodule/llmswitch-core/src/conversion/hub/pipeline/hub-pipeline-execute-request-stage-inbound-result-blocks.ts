import type { JsonObject } from "../types/json.js";
import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type {
  HubPipelineConfig,
  HubPipelineNodeResult,
  NormalizedRequest,
} from "./hub-pipeline.js";
import type { StageRecorder } from "../format-adapters/index.js";
import type { RequestStageHooks } from "./hub-pipeline-stage-hooks.js";
import { finalizeWorkingRequestForOutbound } from "./hub-pipeline-working-request-blocks.js";
import type { HubPolicyConfig } from "../policy/policy-engine.js";

export function finalizeInboundWorkingRequestResult(
  workingRequest: Record<string, unknown>,
  normalized: NormalizedRequest,
): {
  workingRequest: StandardizedRequest;
  hasImageAttachment: boolean;
  serverToolRequired: boolean;
} {
  const { workingRequest: synced, hasImageAttachment, serverToolRequired } =
    finalizeWorkingRequestForOutbound({
      request: workingRequest,
      normalized,
    });
  return {
    workingRequest: synced as StandardizedRequest,
    hasImageAttachment,
    serverToolRequired,
  };
}

export function buildRequestStageInboundResult<TContext = Record<string, unknown>>(args: {
  rawRequest: JsonObject;
  hooks: RequestStageHooks<TContext>;
  effectivePolicy: HubPolicyConfig | undefined;
  shadowCompareBaselineMode: NormalizedRequest["shadowCompare"] extends {
    baselineMode: infer T;
  }
    ? T
    : never;
  inboundRecorder?: StageRecorder;
  contextSnapshot?: Record<string, unknown>;
  standardizedRequest: StandardizedRequest;
  processedRequest?: ProcessedRequest;
  workingRequest: StandardizedRequest | ProcessedRequest;
  nodeResults: HubPipelineNodeResult[];
  hasImageAttachment: boolean;
  serverToolRequired: boolean;
}): {
  rawRequest: JsonObject;
  semanticMapper: ReturnType<RequestStageHooks<TContext>["createSemanticMapper"]>;
  effectivePolicy: HubPolicyConfig | undefined;
  shadowCompareBaselineMode: NormalizedRequest["shadowCompare"] extends {
    baselineMode: infer T;
  }
    ? T
    : never;
  inboundRecorder?: StageRecorder;
  contextSnapshot?: Record<string, unknown>;
  standardizedRequest: StandardizedRequest;
  processedRequest?: ProcessedRequest;
  workingRequest: StandardizedRequest | ProcessedRequest;
  nodeResults: HubPipelineNodeResult[];
  hasImageAttachment: boolean;
  serverToolRequired: boolean;
} {
  return {
    rawRequest: args.rawRequest,
    semanticMapper: args.hooks.createSemanticMapper(),
    effectivePolicy: args.effectivePolicy,
    shadowCompareBaselineMode: args.shadowCompareBaselineMode,
    inboundRecorder: args.inboundRecorder,
    contextSnapshot: args.contextSnapshot,
    standardizedRequest: args.standardizedRequest,
    processedRequest: args.processedRequest,
    workingRequest: args.workingRequest,
    nodeResults: args.nodeResults,
    hasImageAttachment: args.hasImageAttachment,
    serverToolRequired: args.serverToolRequired,
  };
}
