import type { StageRecorder } from "../format-adapters/index.js";
import type { JsonObject } from "../types/json.js";
import type { RequestStageHooks } from "./hub-pipeline-stage-hooks.js";
import type { NormalizedRequest } from "./hub-pipeline.js";
import { runReqInboundStage1FormatParse } from "./stages/req_inbound/req_inbound_stage1_format_parse/index.js";
import { runReqInboundStage2SemanticMap } from "./stages/req_inbound/req_inbound_stage2_semantic_map/index.js";
import { measureHubStage } from "./hub-stage-timing.js";
import {
  captureInboundContextSnapshot,
  clearResponsesResumeMetadata,
  observeClientInboundPayload,
  readResponsesResumeSnapshot,
} from "./hub-pipeline-execute-request-stage-inbound-blocks.js";
import type { AdapterContext } from "../types/chat-envelope.js";
import type { HubPolicyConfig } from "../policy/policy-engine.js";

export async function runInboundSemanticPipeline<TContext = Record<string, unknown>>(args: {
  normalized: NormalizedRequest;
  hooks: RequestStageHooks<TContext>;
  semanticMapper: ReturnType<RequestStageHooks<TContext>["createSemanticMapper"]>;
  rawRequest: JsonObject;
  effectivePolicy: HubPolicyConfig | undefined;
  inboundAdapterContext: AdapterContext;
  inboundRecorder?: StageRecorder;
}): Promise<{
  contextSnapshot?: Record<string, unknown>;
  standardizedRequestBase: Record<string, unknown>;
}> {
  observeClientInboundPayload({
    normalized: args.normalized,
    effectivePolicy: args.effectivePolicy,
    rawRequest: args.rawRequest,
    inboundRecorder: args.inboundRecorder,
  });

  const formatEnvelope = await measureHubStage(
    args.normalized.id,
    "req_inbound.stage1_format_parse",
    () =>
      runReqInboundStage1FormatParse({
        rawRequest: args.rawRequest,
        adapterContext: args.inboundAdapterContext,
        stageRecorder: args.inboundRecorder,
      }),
  );

  const responsesResumeFromMetadata = readResponsesResumeSnapshot(
    args.normalized.metadata as Record<string, unknown> | undefined,
  );

  const inboundStage2 = await measureHubStage(
    args.normalized.id,
    "req_inbound.stage2_semantic_map",
    () =>
      runReqInboundStage2SemanticMap({
        adapterContext: args.inboundAdapterContext,
        formatEnvelope,
        semanticMapper: args.semanticMapper,
        ...(responsesResumeFromMetadata
          ? { responsesResume: responsesResumeFromMetadata }
          : {}),
        stageRecorder: args.inboundRecorder,
      }),
  );

  clearResponsesResumeMetadata(
    args.normalized.metadata as Record<string, unknown> | undefined,
    responsesResumeFromMetadata,
  );

  const contextSnapshot = await measureHubStage(
    args.normalized.id,
    "req_inbound.stage3_context_capture",
    () =>
      captureInboundContextSnapshot({
        inboundStage2ResponsesContext:
          inboundStage2.responsesContext as Record<string, unknown> | undefined,
        rawRequest: args.rawRequest,
        inboundAdapterContext: args.inboundAdapterContext,
        hooks: args.hooks,
        inboundRecorder: args.inboundRecorder,
      }),
  );

  return {
    contextSnapshot: contextSnapshot as Record<string, unknown> | undefined,
    standardizedRequestBase: inboundStage2.standardizedRequest as unknown as Record<
      string,
      unknown
    >,
  };
}
