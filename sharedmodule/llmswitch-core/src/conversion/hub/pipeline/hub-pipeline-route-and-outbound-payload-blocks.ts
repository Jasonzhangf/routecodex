import type { JsonObject } from "../types/json.js";
import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { StageRecorder } from "../format-adapters/index.js";
import type {
  HubPipelineConfig,
  HubPipelineNodeResult,
  NormalizedRequest,
} from "./hub-pipeline.js";
import type { RequestStageHooks } from "./hub-pipeline-stage-hooks.js";
import type { HubPolicyConfig } from "../policy/policy-engine.js";
import { buildRequestStageProviderPayload } from "./hub-pipeline-execute-request-stage-provider-payload.js";
import {
  appendOutboundNodeResult,
  createOutboundSnapshotStageRecorder,
} from "./hub-pipeline-route-and-outbound-blocks.js";

type ShadowCompareBaselineMode =
  NormalizedRequest["shadowCompare"] extends { baselineMode: infer T }
    ? T
    : never;

export async function buildOutboundProviderPayloadBundle<TContext = Record<string, unknown>>(args: {
  normalized: NormalizedRequest;
  hooks: RequestStageHooks<TContext>;
  config: HubPipelineConfig;
  workingRequest: StandardizedRequest | ProcessedRequest;
  nodeResults: HubPipelineNodeResult[];
  rawRequest: JsonObject;
  contextSnapshot?: Record<string, unknown>;
  activeProcessMode: "chat" | "passthrough";
  passthroughAudit?: Record<string, unknown>;
  outboundProtocol: NormalizedRequest["providerProtocol"];
  outboundAdapterContext: Record<string, unknown>;
  outboundStream: boolean;
  semanticMapper: ReturnType<RequestStageHooks<TContext>["createSemanticMapper"]>;
  effectivePolicy?: HubPolicyConfig;
  shadowCompareBaselineMode?: ShadowCompareBaselineMode;
}): Promise<{
  providerPayload?: Record<string, unknown>;
  shadowBaselineProviderPayload?: Record<string, unknown>;
  outboundWorkingRequest: StandardizedRequest | ProcessedRequest;
}> {
  const outboundRecorder = createOutboundSnapshotStageRecorder({
    normalized: args.normalized,
    outboundAdapterContext: args.outboundAdapterContext as any,
  });
  const outboundStart = Date.now();
  const { providerPayload, shadowBaselineProviderPayload, outboundWorkingRequest } =
    await buildRequestStageProviderPayload({
      normalized: args.normalized,
      hooks: args.hooks,
      config: args.config,
      workingRequest: args.workingRequest,
      rawRequest: args.rawRequest,
      contextSnapshot: args.contextSnapshot,
      activeProcessMode: args.activeProcessMode,
      passthroughAudit: args.passthroughAudit,
      outboundProtocol: args.outboundProtocol,
      outboundAdapterContext: args.outboundAdapterContext,
      outboundStream: args.outboundStream,
      outboundRecorder,
      semanticMapper: args.semanticMapper,
      effectivePolicy: args.effectivePolicy,
      shadowCompareBaselineMode: args.shadowCompareBaselineMode,
    });
  const outboundEnd = Date.now();
  appendOutboundNodeResult({
    nodeResults: args.nodeResults,
    outboundStart,
    outboundEnd,
    workingRequest: args.workingRequest,
  });
  return {
    providerPayload,
    shadowBaselineProviderPayload,
    outboundWorkingRequest,
  };
}
