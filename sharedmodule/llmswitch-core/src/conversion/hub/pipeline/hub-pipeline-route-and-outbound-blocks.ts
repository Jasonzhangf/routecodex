import type { StageRecorder } from "../format-adapters/index.js";
import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { AdapterContext } from "../types/chat-envelope.js";
import type { HubPipelineNodeResult, NormalizedRequest } from "./hub-pipeline.js";
import {
  buildReqOutboundNodeResultWithNative,
  buildRouterMetadataInputWithNative,
  syncSessionIdentifiersToMetadataWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { replaceMutableRecord } from "./hub-pipeline-mutable-record-utils.js";
import { createHubSnapshotStageRecorder } from "./hub-pipeline-snapshot-recorder-blocks.js";

export function syncNormalizedSessionMetadata(args: {
  normalizedMetadata: Record<string, unknown> | undefined;
  sessionId?: string;
  conversationId?: string;
}): Record<string, unknown> | undefined {
  const { normalizedMetadata, sessionId, conversationId } = args;
  if (!normalizedMetadata || typeof normalizedMetadata !== "object") {
    return undefined;
  }
  const next = syncSessionIdentifiersToMetadataWithNative({
    metadata: normalizedMetadata,
    sessionId,
    conversationId,
  });
  replaceMutableRecord(normalizedMetadata, next);
  return normalizedMetadata;
}

export function readRouteRuntimeDirectives(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return metadata &&
    typeof metadata.__rt === "object" &&
    !Array.isArray(metadata.__rt)
    ? (metadata.__rt as Record<string, unknown>)
    : undefined;
}

export function buildRouteMetadataInput(args: {
  normalized: NormalizedRequest;
  requestSemantics: Record<string, unknown> | undefined;
  serverToolRequired: boolean;
  sessionId?: string;
  conversationId?: string;
  normalizedMetadata: Record<string, unknown> | undefined;
  routeRuntimeDirectives?: Record<string, unknown>;
}): Record<string, unknown> {
  const metadataInput = buildRouterMetadataInputWithNative({
    requestId: args.normalized.id,
    entryEndpoint: args.normalized.entryEndpoint,
    processMode: args.normalized.processMode,
    stream: args.normalized.stream,
    direction: args.normalized.direction,
    providerProtocol: args.normalized.providerProtocol,
    routeHint: args.normalized.routeHint,
    stage: args.normalized.stage,
    requestSemantics: args.requestSemantics,
    includeEstimatedInputTokens: true,
    serverToolRequired: args.serverToolRequired,
    sessionId: args.sessionId,
    conversationId: args.conversationId,
    metadata: args.normalizedMetadata,
  }) as Record<string, unknown>;
  if (args.routeRuntimeDirectives) {
    metadataInput.__rt = { ...args.routeRuntimeDirectives };
  }
  return metadataInput;
}

export function createOutboundSnapshotStageRecorder(args: {
  normalized: NormalizedRequest;
  outboundAdapterContext: AdapterContext;
}): StageRecorder | undefined {
  return createHubSnapshotStageRecorder({
    normalized: args.normalized,
    adapterContext: args.outboundAdapterContext,
    warningLabel: "Outbound snapshot recorder creation",
  });
}

export function appendOutboundNodeResult(args: {
  nodeResults: HubPipelineNodeResult[];
  outboundStart: number;
  outboundEnd: number;
  workingRequest: StandardizedRequest | ProcessedRequest;
}): void {
  args.nodeResults.push(
    buildReqOutboundNodeResultWithNative({
      outboundStart: args.outboundStart,
      outboundEnd: args.outboundEnd,
      messages: args.workingRequest.messages.length,
      tools: args.workingRequest.tools?.length ?? 0,
    }) as unknown as HubPipelineNodeResult,
  );
}
