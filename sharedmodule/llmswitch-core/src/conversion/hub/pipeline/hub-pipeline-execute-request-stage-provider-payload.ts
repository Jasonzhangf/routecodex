import type { StageRecorder } from "../format-adapters/index.js";
import type { JsonObject } from "../types/json.js";
import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { HubPipelineConfig, NormalizedRequest } from "./hub-pipeline.js";
import type { RequestStageHooks } from "./hub-pipeline-stage-hooks.js";
import { type HubPolicyConfig } from "../policy/policy-engine.js";
import { resolveCompatibilityProfile } from "./hub-pipeline-provider-payload-policy-blocks.js";
import {
  buildFormattedOutboundPayload,
  prepareOutboundPayloadBuildContext,
} from "./hub-pipeline-provider-payload-orchestration-blocks.js";
import { buildFinalProviderPayloadBundle } from "./hub-pipeline-provider-payload-finalize-blocks.js";
import {
  buildProviderPayloadStageResult,
  resolvePassthroughProviderPayload,
} from "./hub-pipeline-provider-payload-result-blocks.js";

export async function buildRequestStageProviderPayload<TContext = Record<string, unknown>>(args: {
  normalized: NormalizedRequest;
  hooks: RequestStageHooks<TContext>;
  config: HubPipelineConfig;
  workingRequest: StandardizedRequest | ProcessedRequest;
  rawRequest: JsonObject;
  contextSnapshot?: Record<string, unknown>;
  activeProcessMode: "chat" | "passthrough";
  passthroughAudit?: Record<string, unknown>;
  outboundProtocol: NormalizedRequest["providerProtocol"];
  outboundAdapterContext: Record<string, unknown>;
  outboundStream: boolean;
  outboundRecorder?: StageRecorder;
  semanticMapper: ReturnType<RequestStageHooks<TContext>["createSemanticMapper"]>;
  effectivePolicy: HubPolicyConfig | undefined;
  shadowCompareBaselineMode?: NormalizedRequest["shadowCompare"] extends { baselineMode: infer T }
    ? T
    : never;
}): Promise<{
  providerPayload: Record<string, unknown>;
  shadowBaselineProviderPayload?: Record<string, unknown>;
}> {
  const {
    normalized,
    hooks,
    config,
    workingRequest,
    rawRequest,
    contextSnapshot,
    activeProcessMode,
    passthroughAudit,
    outboundProtocol,
    outboundAdapterContext,
    outboundStream,
    outboundRecorder,
    semanticMapper,
    effectivePolicy,
    shadowCompareBaselineMode,
  } = args;

  if (activeProcessMode === "passthrough") {
    return resolvePassthroughProviderPayload({
      rawRequest,
      outboundStream,
      passthroughAudit,
      outboundProtocol,
    });
  }

  const {
    outboundSemanticMapper,
    outboundContextMetadataKey,
    outboundContextSnapshot,
  } = prepareOutboundPayloadBuildContext({
    normalized,
    hooks,
    semanticMapper,
    contextSnapshot,
    outboundProtocol,
  });
  const compatibilityProfile = resolveCompatibilityProfile(outboundAdapterContext);

  const formattedPayload = await buildFormattedOutboundPayload({
    normalized,
    workingRequest,
    rawRequest,
    outboundProtocol,
    outboundAdapterContext,
    outboundRecorder,
    outboundSemanticMapper,
    outboundContextMetadataKey,
    outboundContextSnapshot,
  });

  const {
    providerPayload,
    shadowBaselineProviderPayload,
  } = buildFinalProviderPayloadBundle({
    normalized,
    formattedPayload: formattedPayload as JsonObject,
    effectivePolicy,
    outboundProtocol,
    compatibilityProfile,
    config,
    outboundAdapterContext,
    rawRequest,
    passthroughAudit,
    outboundRecorder,
    shadowCompareBaselineMode,
  });

  return buildProviderPayloadStageResult({
    providerPayload,
    shadowBaselineProviderPayload,
  });
}
