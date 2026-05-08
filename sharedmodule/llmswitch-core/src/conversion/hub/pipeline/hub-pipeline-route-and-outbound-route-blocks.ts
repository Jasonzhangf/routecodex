import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";
import type { StageRecorder } from "../format-adapters/index.js";
import type {
  HubPipelineResult,
  NormalizedRequest,
} from "./hub-pipeline.js";
import {
  prepareOutboundExecutionContext,
  prepareRouteSelectionContext,
} from "./hub-pipeline-route-and-outbound-setup.js";
import { executeMeasuredRouteSelect } from "./hub-pipeline-route-select-blocks.js";

export function resolveRouteSelectionAndOutboundContext(args: {
  normalized: NormalizedRequest;
  routerEngine: VirtualRouterEngine;
  workingRequest: StandardizedRequest | ProcessedRequest;
  inboundRecorder?: StageRecorder;
  activeProcessMode: "chat" | "passthrough";
  serverToolRequired: boolean;
  routeSelectTiming?: {
    enabled?: boolean;
    requestId?: string;
  };
}): {
  routing: {
    decision?: HubPipelineResult["routingDecision"];
    diagnostics?: HubPipelineResult["routingDiagnostics"];
    target?: HubPipelineResult["target"];
  };
  workingRequest: StandardizedRequest | ProcessedRequest;
  outboundStream: boolean;
  outboundAdapterContext: Record<string, unknown>;
  outboundProtocol: NormalizedRequest["providerProtocol"];
} {
  const { metadataInput } = prepareRouteSelectionContext({
    normalized: args.normalized,
    workingRequest: args.workingRequest,
    serverToolRequired: args.serverToolRequired,
  });
  const routing = executeMeasuredRouteSelect({
    normalized: args.normalized,
    routerEngine: args.routerEngine,
    metadataInput,
    workingRequest: args.workingRequest,
    inboundRecorder: args.inboundRecorder,
    routeSelectTiming: args.routeSelectTiming,
  });
  const outboundContext = prepareOutboundExecutionContext({
    normalized: args.normalized,
    routingTarget: routing.target,
    workingRequest: args.workingRequest,
    activeProcessMode: args.activeProcessMode,
    routerEngine: args.routerEngine,
  });
  return {
    routing,
    workingRequest: outboundContext.workingRequest,
    outboundStream: outboundContext.outboundStream,
    outboundAdapterContext: outboundContext.outboundAdapterContext as Record<
      string,
      unknown
    >,
    outboundProtocol: outboundContext.outboundProtocol,
  };
}
