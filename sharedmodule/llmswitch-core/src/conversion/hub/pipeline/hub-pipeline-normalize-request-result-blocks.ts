import type {
  HubPolicyConfig,
} from "../policy/policy-engine.js";
import type { StageRecorder } from "../format-adapters/index.js";
import type {
  HubShadowCompareRequestConfig,
  NormalizedRequest,
  ProviderProtocol,
} from "./hub-pipeline.js";
import type { HubNormalizedRouteShape } from "./hub-pipeline-normalize-request-shape-blocks.js";

export function buildNativeOrchestrationMetadataInput(args: {
  metadataRecord: Record<string, unknown>;
  entryEndpoint: string;
  providerProtocol: ProviderProtocol;
  processMode: NormalizedRequest["processMode"];
  direction: NormalizedRequest["direction"];
  stage: NormalizedRequest["stage"];
  stream: boolean;
  routeHint?: string;
}): Record<string, unknown> {
  return {
    ...args.metadataRecord,
    entryEndpoint: args.entryEndpoint,
    providerProtocol: args.providerProtocol,
    processMode: args.processMode,
    direction: args.direction,
    stage: args.stage,
    stream: args.stream,
    ...(args.routeHint ? { routeHint: args.routeHint } : {}),
  };
}

export function buildNormalizedRequestResult(args: {
  id: string;
  endpoint: string;
  routeShape: HubNormalizedRouteShape;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  policyOverride?: HubPolicyConfig;
  shadowCompare?: HubShadowCompareRequestConfig;
  disableSnapshots: boolean;
  hubEntryMode?: NormalizedRequest["hubEntryMode"];
  externalStageRecorder?: StageRecorder;
}): NormalizedRequest {
  return {
    id: args.id,
    endpoint: args.endpoint,
    entryEndpoint: args.routeShape.entryEndpoint,
    providerProtocol: args.routeShape.providerProtocol,
    payload: args.payload,
    metadata: args.metadata,
    policyOverride: args.policyOverride,
    shadowCompare: args.shadowCompare,
    disableSnapshots: args.disableSnapshots,
    ...(args.externalStageRecorder
      ? { externalStageRecorder: args.externalStageRecorder }
      : {}),
    processMode: args.routeShape.processMode,
    direction: args.routeShape.direction,
    stage: args.routeShape.stage,
    stream: args.routeShape.stream,
    routeHint: args.routeShape.routeHint,
    ...(args.hubEntryMode ? { hubEntryMode: args.hubEntryMode } : {}),
  };
}
