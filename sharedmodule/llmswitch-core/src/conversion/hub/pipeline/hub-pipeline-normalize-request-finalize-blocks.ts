import {
  normalizeHubEndpointWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import type {
  HubPipelineRequest,
  HubShadowCompareRequestConfig,
  NormalizedRequest,
  ProviderProtocol,
} from "./hub-pipeline.js";
import type { HubPolicyConfig } from "../policy/policy-engine.js";
import type { StageRecorder } from "../format-adapters/index.js";
import { resolveProviderProtocolOrThrow } from "./hub-pipeline-normalize-request-blocks.js";
import {
  buildNormalizedMetadataRecord,
  resolveNormalizedRouteShape,
  type HubNormalizedRouteShape,
} from "./hub-pipeline-normalize-request-shape-blocks.js";
import {
  buildNativeOrchestrationMetadataInput,
  buildNormalizedRequestResult,
} from "./hub-pipeline-normalize-request-result-blocks.js";

export function buildPreOrchestrationRequestShape(args: {
  request: HubPipelineRequest;
  endpoint: string;
  metadataRecord: Record<string, unknown>;
}): {
  entryEndpoint: string;
  providerProtocol: ProviderProtocol;
  processMode: NormalizedRequest["processMode"];
  direction: NormalizedRequest["direction"];
  stage: NormalizedRequest["stage"];
  stream: boolean;
  routeHint?: string;
} {
  const { request, endpoint, metadataRecord } = args;
  const entryEndpoint =
    typeof metadataRecord.entryEndpoint === "string"
      ? normalizeHubEndpointWithNative(metadataRecord.entryEndpoint)
      : endpoint;
  const providerProtocol = resolveProviderProtocolOrThrow(
    metadataRecord.providerProtocol,
  );
  const processMode =
    metadataRecord.processMode === "passthrough" ? "passthrough" : "chat";
  const direction =
    metadataRecord.direction === "response" ? "response" : "request";
  const stage = metadataRecord.stage === "outbound" ? "outbound" : "inbound";
  const stream = Boolean(
    metadataRecord.stream ||
      (request.payload &&
        typeof request.payload === "object" &&
        (request.payload as Record<string, unknown>).stream),
  );
  const routeHint =
    typeof metadataRecord.routeHint === "string"
      ? metadataRecord.routeHint
      : undefined;
  return {
    entryEndpoint,
    providerProtocol,
    processMode,
    direction,
    stage,
    stream,
    ...(routeHint ? { routeHint } : {}),
  };
}

export function finalizeNormalizedRequest(args: {
  id: string;
  endpoint: string;
  payload: Record<string, unknown>;
  metadataRecord: Record<string, unknown>;
  orchestrationMetadata: Record<string, unknown>;
  base: HubNormalizedRouteShape;
  extracted: {
    policyOverride?: HubPolicyConfig;
    shadowCompare?: HubShadowCompareRequestConfig;
    disableSnapshots: boolean;
    hubEntryMode?: NormalizedRequest["hubEntryMode"];
    externalStageRecorder?: StageRecorder;
  };
}): NormalizedRequest {
  const routeShape = resolveNormalizedRouteShape({
    orchestrationMetadata: args.orchestrationMetadata,
    base: args.base,
  });
  const normalizedMetadata = buildNormalizedMetadataRecord({
    metadataRecord: args.metadataRecord,
    orchestrationMetadata: args.orchestrationMetadata,
    routeShape,
  });

  return buildNormalizedRequestResult({
    id: args.id,
    endpoint: args.endpoint,
    routeShape,
    payload: args.payload,
    metadata: normalizedMetadata,
    policyOverride: args.extracted.policyOverride,
    shadowCompare: args.extracted.shadowCompare,
    disableSnapshots: args.extracted.disableSnapshots,
    hubEntryMode: args.extracted.hubEntryMode,
    externalStageRecorder: args.extracted.externalStageRecorder,
  });
}

export { buildNativeOrchestrationMetadataInput };
