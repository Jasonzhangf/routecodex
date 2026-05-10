import type { StageRecorder } from "../format-adapters/index.js";
import type { JsonObject } from "../types/json.js";
import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { NormalizedRequest } from "./hub-pipeline.js";
import type { RequestStageHooks } from "./hub-pipeline-stage-hooks.js";
import { runReqOutboundStage1SemanticMap } from "./stages/req_outbound/req_outbound_stage1_semantic_map/index.js";
import { runReqOutboundStage2FormatBuild } from "./stages/req_outbound/req_outbound_stage2_format_build/index.js";
import { runReqOutboundStage3Compat } from "./stages/req_outbound/req_outbound_stage3_compat/index.js";
import { measureHubStage } from "./hub-stage-timing.js";
import { resolveRouteAwareResponsesContinuation } from "./route-aware-responses-continuation.js";
import { requireRequestStageHooks } from "./hub-pipeline-shared-guards.js";

export function prepareOutboundPayloadBuildContext<TContext = Record<string, unknown>>(args: {
  normalized: NormalizedRequest;
  hooks: RequestStageHooks<TContext>;
  semanticMapper: ReturnType<RequestStageHooks<TContext>["createSemanticMapper"]>;
  contextSnapshot?: Record<string, unknown>;
  outboundProtocol: NormalizedRequest["providerProtocol"];
}): {
  outboundHooks: RequestStageHooks<TContext>;
  outboundSemanticMapper: ReturnType<RequestStageHooks<TContext>["createSemanticMapper"]>;
  outboundContextMetadataKey: string;
  outboundContextSnapshot?: Record<string, unknown>;
} {
  const protocolSwitch = args.outboundProtocol !== args.normalized.providerProtocol;
  const outboundHooks = protocolSwitch
    ? requireRequestStageHooks<TContext>(args.outboundProtocol)
    : args.hooks;
  return {
    outboundHooks,
    outboundSemanticMapper: protocolSwitch
      ? outboundHooks.createSemanticMapper()
      : args.semanticMapper,
    outboundContextMetadataKey: protocolSwitch
      ? outboundHooks.contextMetadataKey
      : args.hooks.contextMetadataKey,
    outboundContextSnapshot: protocolSwitch
      ? undefined
      : (args.contextSnapshot as Record<string, unknown> | undefined),
  };
}

export async function buildFormattedOutboundPayload<TContext = Record<string, unknown>>(args: {
  normalized: NormalizedRequest;
  workingRequest: StandardizedRequest | ProcessedRequest;
  rawRequest: JsonObject;
  outboundProtocol: NormalizedRequest["providerProtocol"];
  outboundAdapterContext: Record<string, unknown>;
  outboundRecorder?: StageRecorder;
  outboundSemanticMapper: ReturnType<RequestStageHooks<TContext>["createSemanticMapper"]>;
  outboundContextMetadataKey: string;
  outboundContextSnapshot?: Record<string, unknown>;
}): Promise<{
  formattedPayload: JsonObject;
  outboundWorkingRequest: StandardizedRequest | ProcessedRequest;
}> {
  const routeAwareWorkingRequest = resolveRouteAwareResponsesContinuation({
    request: args.workingRequest,
    rawRequest: args.rawRequest,
    normalizedMetadata:
      args.normalized.metadata as Record<string, unknown> | undefined,
    requestId: args.normalized.id,
    entryProtocol: args.normalized.providerProtocol,
    outboundProtocol: args.outboundProtocol,
  });

  const outboundStage1 = await measureHubStage(
    args.normalized.id,
    "req_outbound.stage1_semantic_map",
    () =>
      runReqOutboundStage1SemanticMap({
        request: routeAwareWorkingRequest,
        adapterContext: args.outboundAdapterContext as any,
        semanticMapper: args.outboundSemanticMapper as any,
        contextSnapshot: args.outboundContextSnapshot,
        contextMetadataKey: args.outboundContextMetadataKey,
        stageRecorder: args.outboundRecorder,
      }),
  );

  let formattedPayload = await measureHubStage(
    args.normalized.id,
    "req_outbound.stage2_format_build",
    () =>
      runReqOutboundStage2FormatBuild({
        formatEnvelope: outboundStage1.formatEnvelope,
        stageRecorder: args.outboundRecorder,
      }),
  );

  formattedPayload = await measureHubStage(
    args.normalized.id,
    "req_outbound.stage3_compat",
    () =>
      runReqOutboundStage3Compat({
        payload: formattedPayload as JsonObject,
        adapterContext: args.outboundAdapterContext as any,
        stageRecorder: args.outboundRecorder,
      }),
  );

  return {
    formattedPayload: formattedPayload as JsonObject,
    outboundWorkingRequest: routeAwareWorkingRequest,
  };
}
