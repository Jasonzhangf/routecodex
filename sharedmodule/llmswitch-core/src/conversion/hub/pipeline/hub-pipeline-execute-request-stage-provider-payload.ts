import type { StageRecorder } from "../format-adapters/index.js";
import type { JsonObject } from "../types/json.js";
import { jsonClone } from "../types/json.js";
import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { HubPipelineConfig, NormalizedRequest } from "./hub-pipeline.js";
import type { RequestStageHooks } from "./hub-pipeline-stage-hooks.js";
import { REQUEST_STAGE_HOOKS } from "./hub-pipeline-stage-hooks.js";
import { runReqOutboundStage1SemanticMap } from "./stages/req_outbound/req_outbound_stage1_semantic_map/index.js";
import { runReqOutboundStage2FormatBuild } from "./stages/req_outbound/req_outbound_stage2_format_build/index.js";
import { runReqOutboundStage3Compat } from "./stages/req_outbound/req_outbound_stage3_compat/index.js";
import {
  applyDirectBuiltinWebSearchToolWithNative,
  attachPassthroughProviderInputAuditWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { readRuntimeMetadata } from "../../runtime-metadata.js";
import {
  applyHubProviderOutboundPolicy,
  recordHubPolicyObservation,
  type HubPolicyConfig,
} from "../policy/policy-engine.js";
import { applyProviderOutboundToolSurface } from "../tool-surface/tool-surface-engine.js";
import { measureHubStage } from "./hub-stage-timing.js";

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

  let providerPayload: Record<string, unknown>;
  let shadowBaselineProviderPayload: Record<string, unknown> | undefined;

  if (activeProcessMode === "passthrough") {
    providerPayload = jsonClone(rawRequest as any) as Record<string, unknown>;
    if (typeof outboundStream === "boolean") {
      providerPayload.stream = outboundStream;
    }
    if (passthroughAudit) {
      const next = attachPassthroughProviderInputAuditWithNative(
        passthroughAudit,
        providerPayload,
        outboundProtocol,
      );
      for (const key of Object.keys(passthroughAudit)) {
        delete passthroughAudit[key];
      }
      Object.assign(passthroughAudit, next);
    }
    return {
      providerPayload,
      shadowBaselineProviderPayload,
    };
  }

  const protocolSwitch = outboundProtocol !== normalized.providerProtocol;
  const outboundHooks = protocolSwitch
    ? REQUEST_STAGE_HOOKS[outboundProtocol]
    : hooks;
  if (!outboundHooks) {
    throw new Error(
      `[HubPipeline] Unsupported provider protocol for hub pipeline: ${outboundProtocol}`,
    );
  }

  const outboundSemanticMapper = protocolSwitch
    ? outboundHooks.createSemanticMapper()
    : semanticMapper;
  const outboundContextMetadataKey = protocolSwitch
    ? outboundHooks.contextMetadataKey
    : hooks.contextMetadataKey;
  const outboundContextSnapshot = protocolSwitch
    ? undefined
    : (contextSnapshot as Record<string, unknown> | undefined);

  const outboundStage1 = await measureHubStage(
    normalized.id,
    "req_outbound.stage1_semantic_map",
    () =>
      runReqOutboundStage1SemanticMap({
        request: workingRequest,
        adapterContext: outboundAdapterContext as any,
        semanticMapper: outboundSemanticMapper as any,
        contextSnapshot: outboundContextSnapshot,
        contextMetadataKey: outboundContextMetadataKey,
        stageRecorder: outboundRecorder,
      }),
  );

  let formattedPayload = await measureHubStage(
    normalized.id,
    "req_outbound.stage2_format_build",
    () =>
      runReqOutboundStage2FormatBuild({
        formatEnvelope: outboundStage1.formatEnvelope,
        stageRecorder: outboundRecorder,
      }),
  );

  formattedPayload = await measureHubStage(
    normalized.id,
    "req_outbound.stage3_compat",
    () =>
      runReqOutboundStage3Compat({
        payload: formattedPayload as JsonObject,
        adapterContext: outboundAdapterContext as any,
        stageRecorder: outboundRecorder,
      }),
  );

  if (shadowCompareBaselineMode) {
    const baselinePolicy: HubPolicyConfig = {
      ...(effectivePolicy ?? {}),
      mode: shadowCompareBaselineMode,
    };
    // Compute a baseline provider payload in the *same execution*, without recording
    // snapshots/diffs and without re-running the full pipeline. This avoids side effects
    // (conversation store, followup captures, etc.) that a second execute() would trigger.
    const baselineFormatted =
      typeof (globalThis as any).structuredClone === "function"
        ? ((globalThis as any).structuredClone(
            formattedPayload,
          ) as JsonObject)
        : (jsonClone(formattedPayload as any) as JsonObject);
    let baselinePayload = applyHubProviderOutboundPolicy({
      policy: baselinePolicy,
      providerProtocol: outboundProtocol,
      compatibilityProfile:
        typeof (outboundAdapterContext as any).compatibilityProfile === "string"
          ? (outboundAdapterContext as any).compatibilityProfile
          : undefined,
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
    shadowBaselineProviderPayload = baselinePayload;
  }

  // Phase 0/1: observe provider outbound payload violations before any enforcement rewrites.
  // This provides black-box visibility into what the pipeline would have sent upstream.
  recordHubPolicyObservation({
    policy: effectivePolicy,
    providerProtocol: outboundProtocol,
    compatibilityProfile:
      typeof (outboundAdapterContext as any).compatibilityProfile === "string"
        ? (outboundAdapterContext as any).compatibilityProfile
        : undefined,
    payload: formattedPayload as JsonObject,
    stageRecorder: outboundRecorder,
    requestId: normalized.id,
  });

  providerPayload = applyHubProviderOutboundPolicy({
    policy: effectivePolicy,
    providerProtocol: outboundProtocol,
    compatibilityProfile:
      typeof (outboundAdapterContext as any).compatibilityProfile === "string"
        ? (outboundAdapterContext as any).compatibilityProfile
        : undefined,
    payload: formattedPayload as JsonObject,
    stageRecorder: outboundRecorder,
    requestId: normalized.id,
  }) as Record<string, unknown>;

  providerPayload = applyProviderOutboundToolSurface({
    config: config.toolSurface,
    providerProtocol: outboundProtocol,
    payload: providerPayload as JsonObject,
    stageRecorder: outboundRecorder,
    requestId: normalized.id,
  }) as Record<string, unknown>;

  const rt = readRuntimeMetadata(
    outboundAdapterContext as unknown as Record<string, unknown>,
  ) as Record<string, unknown> | undefined;
  providerPayload = applyDirectBuiltinWebSearchToolWithNative(
    providerPayload,
    outboundProtocol,
    (outboundAdapterContext as any).routeId,
    rt,
  );

  recordHubPolicyObservation({
    policy: effectivePolicy,
    providerProtocol: outboundProtocol,
    compatibilityProfile:
      typeof (outboundAdapterContext as any).compatibilityProfile === "string"
        ? (outboundAdapterContext as any).compatibilityProfile
        : undefined,
    payload: providerPayload as JsonObject,
    stageRecorder: outboundRecorder,
    requestId: normalized.id,
  });

  if (passthroughAudit) {
    const next = attachPassthroughProviderInputAuditWithNative(
      passthroughAudit,
      providerPayload,
      outboundProtocol,
    );
    for (const key of Object.keys(passthroughAudit)) {
      delete passthroughAudit[key];
    }
    Object.assign(passthroughAudit, next);
  }

  return {
    providerPayload,
    shadowBaselineProviderPayload,
  };
}
