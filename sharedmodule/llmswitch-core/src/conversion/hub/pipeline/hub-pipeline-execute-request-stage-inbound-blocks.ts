import type { StageRecorder } from "../format-adapters/index.js";
import type { JsonObject, JsonValue } from "../types/json.js";
import { isJsonObject } from "../types/json.js";
import type { AdapterContext } from "../types/chat-envelope.js";
import type { HubPipelineNodeResult, NormalizedRequest } from "./hub-pipeline.js";
import type { RequestStageHooks } from "./hub-pipeline-stage-hooks.js";
import { writeCacheEntryForRequest } from "./stages/req_inbound/req_inbound_stage3_context_capture/cache-write.js";
import { persistResponsesConversationRequestContext } from "./stages/req_inbound/req_inbound_stage3_context_capture/responses-context-snapshot.js";
import {
  buildReqInboundNodeResultWithNative,
  readResponsesResumeFromMetadataWithNative,
  resolveHubClientProtocolWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { recordHubPolicyObservation, type HubPolicyConfig } from "../policy/policy-engine.js";

export function observeClientInboundPayload(args: {
  normalized: NormalizedRequest;
  effectivePolicy: HubPolicyConfig | undefined;
  rawRequest: JsonObject;
  inboundRecorder?: StageRecorder;
}): void {
  const protocol = resolveHubClientProtocolWithNative(args.normalized.entryEndpoint);
  recordHubPolicyObservation({
    policy: args.effectivePolicy,
    providerProtocol:
      protocol === "openai-responses" ||
      protocol === "anthropic-messages" ||
      protocol === "openai-chat"
        ? protocol
        : "openai-chat",
    payload: args.rawRequest,
    phase: "client_inbound",
    stageRecorder: args.inboundRecorder,
    requestId: args.normalized.id,
  });
}

export function readResponsesResumeSnapshot(
  metadata: Record<string, unknown> | undefined,
): JsonObject | undefined {
  const raw = readResponsesResumeFromMetadataWithNative(metadata);
  return raw && isJsonObject(raw as JsonValue) ? (raw as JsonObject) : undefined;
}

export function clearResponsesResumeMetadata(
  metadata: Record<string, unknown> | undefined,
  responsesResumeFromMetadata: JsonObject | undefined,
): void {
  if (
    !responsesResumeFromMetadata ||
    !metadata ||
    !Object.prototype.hasOwnProperty.call(metadata, "responsesResume")
  ) {
    return;
  }
  delete metadata.responsesResume;
}

export async function captureInboundContextSnapshot<TContext = Record<string, unknown>>(args: {
  inboundStage2ResponsesContext: Record<string, unknown> | undefined;
  rawRequest: JsonObject;
  inboundAdapterContext: AdapterContext;
  hooks: RequestStageHooks<TContext>;
  inboundRecorder?: StageRecorder;
}): Promise<Record<string, unknown> | undefined> {
  if (args.inboundStage2ResponsesContext) {
    writeCacheEntryForRequest({
      rawRequest: args.rawRequest,
      adapterContext: args.inboundAdapterContext,
    });
    persistResponsesConversationRequestContext({
      rawRequest: args.rawRequest,
      adapterContext: args.inboundAdapterContext,
      context: args.inboundStage2ResponsesContext,
    });
    return args.inboundStage2ResponsesContext;
  }
  return args.hooks.captureContext({
    rawRequest: args.rawRequest,
    adapterContext: args.inboundAdapterContext,
    stageRecorder: args.inboundRecorder,
  });
}

export function appendInboundNodeResult(args: {
  nodeResults: HubPipelineNodeResult[];
  inboundStart: number;
  inboundEnd: number;
  standardizedMessages: number;
  standardizedTools: number;
}): void {
  args.nodeResults.push(
    buildReqInboundNodeResultWithNative({
      inboundStart: args.inboundStart,
      inboundEnd: args.inboundEnd,
      messages: args.standardizedMessages,
      tools: args.standardizedTools,
    }) as unknown as HubPipelineNodeResult,
  );
}
