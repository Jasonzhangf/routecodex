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
import { stripInternalToolingMetadataWithNative } from "../../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js";

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

  providerPayload = stripUnsupportedBuiltinWebSearchToolsForProtocol(
    providerPayload,
    args.outboundProtocol,
  );

  if (providerPayload.metadata && typeof providerPayload.metadata === 'object' && !Array.isArray(providerPayload.metadata)) {
    const strippedMetadata = stripInternalToolingMetadataWithNative(providerPayload.metadata);
    if (!strippedMetadata || Object.keys(strippedMetadata).length === 0) {
      delete providerPayload.metadata;
    } else {
      providerPayload.metadata = strippedMetadata;
    }
  }

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

function stripUnsupportedBuiltinWebSearchToolsForProtocol(
  payload: Record<string, unknown>,
  outboundProtocol: string,
): Record<string, unknown> {
  if (outboundProtocol === 'anthropic-messages') {
    return payload;
  }
  const tools = Array.isArray(payload.tools) ? payload.tools : null;
  if (!tools) {
    return payload;
  }
  const filtered = tools.filter((tool) => {
    const type = String((tool as any)?.type || '').trim().toLowerCase();
    return type !== 'web_search' && type !== 'web_search_preview';
  });
  if (filtered.length === tools.length) {
    return payload;
  }
  if (filtered.length === 0 && requiresDeclaredTools(payload.tool_choice)) {
    return payload;
  }
  return {
    ...payload,
    tools: filtered,
  };
}

function requiresDeclaredTools(toolChoice: unknown): boolean {
  if (typeof toolChoice === 'string') {
    const normalized = toolChoice.trim().toLowerCase();
    return normalized === 'auto' || normalized === 'required';
  }
  if (!toolChoice || typeof toolChoice !== 'object') {
    return false;
  }
  const type = String((toolChoice as any).type || '').trim().toLowerCase();
  if (type === 'auto' || type === 'required' || type === 'function') {
    return true;
  }
  return false;
}
