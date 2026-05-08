import type { StageRecorder } from "../format-adapters/index.js";
import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";
import type { RouterMetadataInput } from "../../../router/virtual-router/types.js";
import type { HubPipelineResult, NormalizedRequest } from "./hub-pipeline.js";
import { runReqProcessStage2RouteSelect } from "./stages/req_process/req_process_stage2_route_select/index.js";
import { logHubStageTiming } from "./hub-stage-timing.js";

export function executeMeasuredRouteSelect(args: {
  normalized: NormalizedRequest;
  routerEngine: VirtualRouterEngine;
  workingRequest: StandardizedRequest | ProcessedRequest;
  metadataInput: RouterMetadataInput;
  inboundRecorder?: StageRecorder;
  routeSelectTiming?: {
    enabled?: boolean;
    requestId?: string;
  };
}): {
  decision?: HubPipelineResult["routingDecision"];
  diagnostics?: HubPipelineResult["routingDiagnostics"];
  target?: HubPipelineResult["target"];
} {
  if (args.routeSelectTiming?.enabled) {
    logHubStageTiming(
      args.routeSelectTiming.requestId ?? args.normalized.id,
      "req_process.stage2_route_select",
      "start",
    );
  }
  const routing = runReqProcessStage2RouteSelect({
    routerEngine: args.routerEngine,
    request: args.workingRequest,
    metadataInput: args.metadataInput as any,
    normalizedMetadata: args.normalized.metadata,
    stageRecorder: args.inboundRecorder,
  });
  if (args.routeSelectTiming?.enabled) {
    logHubStageTiming(
      args.routeSelectTiming.requestId ?? args.normalized.id,
      "req_process.stage2_route_select",
      "completed",
    );
  }
  return routing;
}
