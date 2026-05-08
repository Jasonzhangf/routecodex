import {
  normalizeHubEndpointWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import type {
  NormalizedRequest,
  ProviderProtocol,
} from "./hub-pipeline.js";
import { resolveProviderProtocolOrThrow } from "./hub-pipeline-normalize-request-blocks.js";

export type HubNormalizedRouteShape = {
  entryEndpoint: string;
  providerProtocol: ProviderProtocol;
  processMode: NormalizedRequest["processMode"];
  direction: NormalizedRequest["direction"];
  stage: NormalizedRequest["stage"];
  stream: boolean;
  routeHint?: string;
};

export function resolveNormalizedRouteShape(args: {
  orchestrationMetadata: Record<string, unknown>;
  base: HubNormalizedRouteShape;
}): HubNormalizedRouteShape {
  const normalizedEntryEndpoint =
    typeof args.orchestrationMetadata.entryEndpoint === "string" &&
    args.orchestrationMetadata.entryEndpoint.trim().length > 0
      ? normalizeHubEndpointWithNative(args.orchestrationMetadata.entryEndpoint)
      : args.base.entryEndpoint;
  const normalizedProviderProtocol = resolveProviderProtocolOrThrow(
    args.orchestrationMetadata.providerProtocol,
  );
  const normalizedProcessMode: NormalizedRequest["processMode"] =
    args.orchestrationMetadata.processMode === "passthrough"
      ? "passthrough"
      : "chat";
  const normalizedDirection: NormalizedRequest["direction"] =
    args.orchestrationMetadata.direction === "response"
      ? "response"
      : "request";
  const normalizedStage: NormalizedRequest["stage"] =
    args.orchestrationMetadata.stage === "outbound" ? "outbound" : "inbound";
  const normalizedStream = Boolean(
    typeof args.orchestrationMetadata.stream === "boolean"
      ? args.orchestrationMetadata.stream
      : args.base.stream,
  );
  const normalizedRouteHint =
    typeof args.orchestrationMetadata.routeHint === "string" &&
    args.orchestrationMetadata.routeHint.trim().length > 0
      ? args.orchestrationMetadata.routeHint.trim()
      : args.base.routeHint;
  return {
    entryEndpoint: normalizedEntryEndpoint,
    providerProtocol: normalizedProviderProtocol,
    processMode: normalizedProcessMode,
    direction: normalizedDirection,
    stage: normalizedStage,
    stream: normalizedStream,
    ...(normalizedRouteHint ? { routeHint: normalizedRouteHint } : {}),
  };
}

export function buildNormalizedMetadataRecord(args: {
  metadataRecord: Record<string, unknown>;
  orchestrationMetadata: Record<string, unknown>;
  routeShape: HubNormalizedRouteShape;
}): Record<string, unknown> {
  return {
    ...args.metadataRecord,
    entryEndpoint: args.routeShape.entryEndpoint,
    providerProtocol: args.routeShape.providerProtocol,
    processMode: args.routeShape.processMode,
    direction: args.routeShape.direction,
    stage: args.routeShape.stage,
    stream: args.routeShape.stream,
    ...(args.routeShape.routeHint ? { routeHint: args.routeShape.routeHint } : {}),
    ...args.orchestrationMetadata,
  };
}
