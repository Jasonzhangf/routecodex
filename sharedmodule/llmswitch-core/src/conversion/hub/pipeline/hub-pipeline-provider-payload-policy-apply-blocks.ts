import type { JsonObject } from "../types/json.js";
import type { HubPipelineConfig, NormalizedRequest } from "./hub-pipeline.js";
import { readRuntimeMetadata } from "../../runtime-metadata.js";
import {
  applyHubProviderOutboundPolicy,
  recordHubPolicyObservation,
  type HubPolicyConfig,
} from "../policy/policy-engine.js";
import { applyProviderOutboundToolSurface } from "../tool-surface/tool-surface-engine.js";
import { applyDirectBuiltinWebSearchToolWithNative } from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";

export function buildShadowBaselineProviderPayload(args: {
  shadowCompareBaselineMode?: NormalizedRequest["shadowCompare"] extends {
    baselineMode: infer T;
  }
    ? T
    : never;
  effectivePolicy: HubPolicyConfig | undefined;
  formattedPayload: JsonObject;
  outboundProtocol: NormalizedRequest["providerProtocol"];
  compatibilityProfile?: string;
  config: HubPipelineConfig;
  requestId: string;
}): Record<string, unknown> | undefined {
  if (!args.shadowCompareBaselineMode) {
    return undefined;
  }
  const baselinePolicy: HubPolicyConfig = {
    ...(args.effectivePolicy ?? {}),
    mode: args.shadowCompareBaselineMode,
  };
  const baselineFormatted =
    typeof (globalThis as any).structuredClone === "function"
      ? ((globalThis as any).structuredClone(args.formattedPayload) as JsonObject)
      : args.formattedPayload;
  let baselinePayload = applyHubProviderOutboundPolicy({
    policy: baselinePolicy,
    providerProtocol: args.outboundProtocol,
    compatibilityProfile: args.compatibilityProfile,
    payload: baselineFormatted,
    stageRecorder: undefined,
    requestId: args.requestId,
  }) as Record<string, unknown>;
  baselinePayload = applyProviderOutboundToolSurface({
    config: args.config.toolSurface,
    providerProtocol: args.outboundProtocol,
    payload: baselinePayload as JsonObject,
    stageRecorder: undefined,
    requestId: args.requestId,
  }) as Record<string, unknown>;
  return baselinePayload;
}

export function finalizeProviderPayloadWithPolicy(args: {
  effectivePolicy: HubPolicyConfig | undefined;
  outboundProtocol: NormalizedRequest["providerProtocol"];
  compatibilityProfile?: string;
  formattedPayload: JsonObject;
  stageRecorder?: { record: (stage: string, value: unknown) => void };
  requestId: string;
  config: HubPipelineConfig;
  outboundAdapterContext: Record<string, unknown>;
}): Record<string, unknown> {
  recordHubPolicyObservation({
    policy: args.effectivePolicy,
    providerProtocol: args.outboundProtocol,
    compatibilityProfile: args.compatibilityProfile,
    payload: args.formattedPayload,
    stageRecorder: args.stageRecorder as any,
    requestId: args.requestId,
  });

  let providerPayload = applyHubProviderOutboundPolicy({
    policy: args.effectivePolicy,
    providerProtocol: args.outboundProtocol,
    compatibilityProfile: args.compatibilityProfile,
    payload: args.formattedPayload,
    stageRecorder: args.stageRecorder as any,
    requestId: args.requestId,
  }) as Record<string, unknown>;

  providerPayload = applyProviderOutboundToolSurface({
    config: args.config.toolSurface,
    providerProtocol: args.outboundProtocol,
    payload: providerPayload as JsonObject,
    stageRecorder: args.stageRecorder as any,
    requestId: args.requestId,
  }) as Record<string, unknown>;

  const rt = readRuntimeMetadata(
    args.outboundAdapterContext as unknown as Record<string, unknown>,
  ) as Record<string, unknown> | undefined;
  providerPayload = applyDirectBuiltinWebSearchToolWithNative(
    providerPayload,
    args.outboundProtocol,
    (args.outboundAdapterContext as any).routeId,
    rt,
  );

  recordHubPolicyObservation({
    policy: args.effectivePolicy,
    providerProtocol: args.outboundProtocol,
    compatibilityProfile: args.compatibilityProfile,
    payload: providerPayload as JsonObject,
    stageRecorder: args.stageRecorder as any,
    requestId: args.requestId,
  });

  return providerPayload;
}
