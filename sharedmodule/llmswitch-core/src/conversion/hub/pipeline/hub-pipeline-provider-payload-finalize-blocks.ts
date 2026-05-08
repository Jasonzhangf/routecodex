import type { StageRecorder } from "../format-adapters/index.js";
import type { JsonObject } from "../types/json.js";
import type { HubPipelineConfig, NormalizedRequest } from "./hub-pipeline.js";
import type { HubPolicyConfig } from "../policy/policy-engine.js";
import { recordOutboundToolParityObservation } from "./hub-pipeline-provider-payload-observation.js";
import { syncPassthroughAudit } from "./hub-pipeline-provider-payload-policy-blocks.js";
import {
  buildShadowBaselineProviderPayload,
  finalizeProviderPayloadWithPolicy,
} from "./hub-pipeline-provider-payload-policy-apply-blocks.js";

export function buildFinalProviderPayloadBundle(args: {
  normalized: NormalizedRequest;
  formattedPayload: JsonObject;
  effectivePolicy: HubPolicyConfig | undefined;
  outboundProtocol: NormalizedRequest["providerProtocol"];
  compatibilityProfile?: string;
  config: HubPipelineConfig;
  outboundAdapterContext: Record<string, unknown>;
  rawRequest: JsonObject;
  passthroughAudit?: Record<string, unknown>;
  outboundRecorder?: StageRecorder;
  shadowCompareBaselineMode?: NormalizedRequest["shadowCompare"] extends {
    baselineMode: infer T;
  }
    ? T
    : never;
}): {
  providerPayload: Record<string, unknown>;
  shadowBaselineProviderPayload?: Record<string, unknown>;
} {
  const shadowBaselineProviderPayload = args.shadowCompareBaselineMode
    ? buildShadowBaselineProviderPayload({
        shadowCompareBaselineMode: args.shadowCompareBaselineMode,
        effectivePolicy: args.effectivePolicy,
        formattedPayload: args.formattedPayload,
        outboundProtocol: args.outboundProtocol,
        compatibilityProfile: args.compatibilityProfile,
        config: args.config,
        requestId: args.normalized.id,
      })
    : undefined;

  const providerPayload = finalizeProviderPayloadWithPolicy({
    effectivePolicy: args.effectivePolicy,
    outboundProtocol: args.outboundProtocol,
    compatibilityProfile: args.compatibilityProfile,
    formattedPayload: args.formattedPayload,
    stageRecorder: args.outboundRecorder as any,
    requestId: args.normalized.id,
    config: args.config,
    outboundAdapterContext: args.outboundAdapterContext,
  });

  recordOutboundToolParityObservation({
    rawRequest: args.rawRequest,
    providerPayload,
    providerProtocol: args.outboundProtocol,
    compatibilityProfile: args.compatibilityProfile,
    requestId: args.normalized.id,
    stageRecorder: args.outboundRecorder,
  });

  syncPassthroughAudit(
    args.passthroughAudit,
    providerPayload,
    args.outboundProtocol,
  );

  return {
    providerPayload,
    shadowBaselineProviderPayload,
  };
}
