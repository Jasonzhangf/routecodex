import type { JsonObject } from "../types/json.js";
import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";
import type { HubPipelineConfig, HubPipelineNodeResult, HubPipelineResult, NormalizedRequest } from "./hub-pipeline.js";
import {
  buildReqInboundSkippedNodeWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import {
} from "./hub-pipeline-chat-process-request-utils.js";
import { executeRouteAndBuildOutbound } from "./hub-pipeline-route-and-outbound.js";
import {
  assertNoMappableSemanticsInMetadata,
} from "./hub-pipeline-chat-process-entry-blocks.js";
import {
  attachHubStageTopSummary,
  executeToolGovernanceOrPassthrough,
} from "./hub-pipeline-governance-blocks.js";
import {
  coerceChatProcessEntryPayload,
  prepareChatProcessEntryExecutionContext,
} from "./hub-pipeline-execute-chat-process-entry-setup.js";
import { finalizeWorkingRequestForOutbound } from "./hub-pipeline-working-request-blocks.js";
import { requireRequestStageHooks } from "./hub-pipeline-shared-guards.js";

export async function executeChatProcessEntryPipeline(args: {
  normalized: NormalizedRequest;
  routerEngine: VirtualRouterEngine;
  config: HubPipelineConfig;
}): Promise<HubPipelineResult> {
  const { normalized, routerEngine, config } = args;
const hooks = requireRequestStageHooks(normalized.providerProtocol);

const nodeResults: HubPipelineNodeResult[] = [];
nodeResults.push(
  buildReqInboundSkippedNodeWithNative({
    reason: "stage=outbound",
  }) as unknown as HubPipelineNodeResult,
);

const {
  rawPayloadInput,
  rawPayload,
  standardizedRequestBase,
} = coerceChatProcessEntryPayload(normalized);

const {
  metaBase,
  standardizedRequest,
  activeProcessMode,
  passthroughAudit,
  stageRecorder,
} = prepareChatProcessEntryExecutionContext({
  normalized,
  config,
  standardizedRequestBase,
  rawPayload,
});

let processedRequest: ProcessedRequest | undefined;
if (activeProcessMode !== "passthrough") {
  assertNoMappableSemanticsInMetadata(metaBase);
}
processedRequest = await executeToolGovernanceOrPassthrough({
  requestId: normalized.id,
  entryEndpoint: normalized.entryEndpoint,
  standardizedRequest,
  rawPayload,
  metadata: metaBase,
  stageRecorder,
  activeProcessMode,
  passthroughAudit,
  nodeResults,
});

const { workingRequest, hasImageAttachment, serverToolRequired } =
  finalizeWorkingRequestForOutbound({
    request: (processedRequest ?? standardizedRequest) as unknown as Record<
      string,
      unknown
    >,
    normalized,
  });

const outbound = await executeRouteAndBuildOutbound({
  normalized,
  hooks,
  routerEngine,
  config,
  workingRequest,
  nodeResults,
  inboundRecorder: stageRecorder,
  activeProcessMode,
  serverToolRequired,
  hasImageAttachment,
  passthroughAudit,
  rawRequest: rawPayloadInput,
  contextSnapshot: undefined,
  semanticMapper: hooks.createSemanticMapper(),
  effectivePolicy: normalized.policyOverride ?? config.policy,
  shadowCompareBaselineMode: undefined,
  routeSelectTiming: {
    enabled: false,
  },
});

attachHubStageTopSummary({
  requestId: normalized.id,
  metadata: outbound.metadata,
});

return {
  requestId: normalized.id,
  providerPayload: outbound.providerPayload,
  standardizedRequest,
  processedRequest,
  routingDecision: outbound.routingDecision,
  routingDiagnostics: outbound.routingDiagnostics,
  target: outbound.target,
  metadata: outbound.metadata,
  nodeResults,
};
  
}
