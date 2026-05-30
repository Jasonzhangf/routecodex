import type { StageRecorder } from "../format-adapters/index.js";
import type { JsonObject } from "../types/json.js";
import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { HubPipelineConfig, NormalizedRequest } from "./hub-pipeline.js";
import type { RequestStageHooks } from "./hub-pipeline-stage-hooks.js";
import { type HubPolicyConfig } from "../policy/policy-engine.js";
import { jsonClone } from "../types/json.js";
import {
  applyDirectBuiltinWebSearchToolWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { replaceMutableRecord } from "./hub-pipeline-mutable-record-utils.js";
import { recordOutboundToolParityObservation } from "./hub-pipeline-provider-payload-observation.js";
import { readRuntimeMetadata } from "../../runtime-metadata.js";
import {
  applyHubProviderOutboundPolicy,
  recordHubPolicyObservation,
} from "../policy/policy-engine.js";
import { applyProviderOutboundToolSurface } from "../tool-surface/tool-surface-engine.js";
import { runReqOutboundStage1SemanticMap } from "./stages/req_outbound/req_outbound_stage1_semantic_map/index.js";
import { runReqOutboundStage2FormatBuild } from "./stages/req_outbound/req_outbound_stage2_format_build/index.js";
import { runReqOutboundStage3Compat } from "./stages/req_outbound/req_outbound_stage3_compat/index.js";
import { measureHubStage } from "./hub-stage-timing.js";
import { resolveRouteAwareResponsesContinuation } from "./route-aware-responses-continuation.js";
import { requireRequestStageHooks } from "./hub-pipeline-shared-guards.js";

function requiresDeclaredTools(toolChoice: unknown): boolean {
  if (typeof toolChoice === 'string') {
    const normalized = toolChoice.trim().toLowerCase();
    return normalized === 'auto' || normalized === 'required';
  }
  if (!toolChoice || typeof toolChoice !== 'object' || Array.isArray(toolChoice)) {
    return false;
  }
  const type = String((toolChoice as Record<string, unknown>).type || '').trim().toLowerCase();
  return type === 'auto' || type === 'required' || type === 'function';
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
    const type = String((tool as Record<string, unknown> | undefined)?.type || '').trim().toLowerCase();
    return type !== 'web_search' && type !== 'web_search_preview' && type !== 'web_search_20250305';
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

export function finalizeProviderPayloadWithPolicy(args: {
  effectivePolicy: HubPolicyConfig | undefined;
  outboundProtocol: NormalizedRequest["providerProtocol"];
  compatibilityProfile?: string;
  formattedPayload: JsonObject;
  stageRecorder?: StageRecorder;
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
  const rt = readRuntimeMetadata(args.outboundAdapterContext as unknown as Record<string, unknown>) as Record<string, unknown> | undefined;
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


export async function buildRequestStageProviderPayload<TContext = Record<string, unknown>>(args: {
  normalized: NormalizedRequest;
  hooks: RequestStageHooks<TContext>;
  config: HubPipelineConfig;
  workingRequest: StandardizedRequest | ProcessedRequest;
  rawRequest: JsonObject;
  contextSnapshot?: Record<string, unknown>;
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
  outboundWorkingRequest: StandardizedRequest | ProcessedRequest;
}> {
  const {
    normalized,
    hooks,
    config,
    workingRequest,
    rawRequest,
    contextSnapshot,
    outboundProtocol,
    outboundAdapterContext,
    outboundStream,
    outboundRecorder,
    semanticMapper,
    effectivePolicy,
    shadowCompareBaselineMode,
  } = args;

const outboundHooks = outboundProtocol !== normalized.providerProtocol
    ? requireRequestStageHooks<TContext>(outboundProtocol)
    : hooks;
  const outboundSemanticMapper = outboundProtocol !== normalized.providerProtocol
    ? outboundHooks.createSemanticMapper()
    : semanticMapper;
  const outboundContextMetadataKey = outboundProtocol !== normalized.providerProtocol
    ? outboundHooks.contextMetadataKey
    : hooks.contextMetadataKey;
  const outboundContextSnapshot = outboundProtocol !== normalized.providerProtocol
    ? undefined
    : (contextSnapshot as Record<string, unknown> | undefined);
  const compatibilityProfile = typeof outboundAdapterContext.compatibilityProfile === "string"
    ? outboundAdapterContext.compatibilityProfile
    : undefined;

  const routeAwareWorkingRequest = resolveRouteAwareResponsesContinuation({
    request: workingRequest,
    rawRequest,
    normalizedMetadata: normalized.metadata as Record<string, unknown> | undefined,
    requestId: normalized.id,
    entryProtocol: normalized.providerProtocol,
    outboundProtocol,
    outboundProviderKey: typeof outboundAdapterContext.providerKey === 'string' ? outboundAdapterContext.providerKey : undefined,
  });
  const outboundStage1 = await measureHubStage(normalized.id, "req_outbound.stage1_semantic_map", () => runReqOutboundStage1SemanticMap({
    request: routeAwareWorkingRequest,
    adapterContext: outboundAdapterContext as any,
    semanticMapper: outboundSemanticMapper as any,
    contextSnapshot: outboundContextSnapshot,
    contextMetadataKey: outboundContextMetadataKey,
    stageRecorder: outboundRecorder,
  }));
  let formattedPayload = await measureHubStage(normalized.id, "req_outbound.stage2_format_build", () => runReqOutboundStage2FormatBuild({ formatEnvelope: outboundStage1.formatEnvelope, stageRecorder: outboundRecorder }));
  formattedPayload = await measureHubStage(normalized.id, "req_outbound.stage3_compat", () => runReqOutboundStage3Compat({ payload: formattedPayload as JsonObject, adapterContext: outboundAdapterContext as any, stageRecorder: outboundRecorder }));
  const outboundWorkingRequest = routeAwareWorkingRequest;

  const shadowBaselineProviderPayload = shadowCompareBaselineMode
    ? (() => {
        const baselinePolicy: HubPolicyConfig = {
          ...(effectivePolicy ?? {}),
          mode: shadowCompareBaselineMode,
        };
        const baselineFormatted =
          typeof (globalThis as any).structuredClone === "function"
            ? ((globalThis as any).structuredClone(formattedPayload as JsonObject) as JsonObject)
            : (formattedPayload as JsonObject);
        let baselinePayload = applyHubProviderOutboundPolicy({
          policy: baselinePolicy,
          providerProtocol: outboundProtocol,
          compatibilityProfile,
          payload: baselineFormatted,
          stageRecorder: undefined,
          requestId: normalized.id,
        }) as Record<string, unknown>;
        baselinePayload = applyProviderOutboundToolSurface({
          config: config.toolSurface,
          providerProtocol: outboundProtocol,
          payload: baselinePayload as JsonObject,
          stageRecorder: undefined,
          requestId: normalized.id,
        }) as Record<string, unknown>;
        return baselinePayload;
      })()
    : undefined;

  const providerPayload = finalizeProviderPayloadWithPolicy({
    effectivePolicy,
    outboundProtocol,
    compatibilityProfile,
    formattedPayload: formattedPayload as JsonObject,
    stageRecorder: outboundRecorder,
    requestId: normalized.id,
    config,
    outboundAdapterContext,
  });

  recordOutboundToolParityObservation({
    rawRequest,
    providerPayload,
    providerProtocol: outboundProtocol,
    compatibilityProfile,
    requestId: normalized.id,
    stageRecorder: outboundRecorder,
  });

  return {
    providerPayload,
    shadowBaselineProviderPayload,
    outboundWorkingRequest,
  };
}
