import type { JsonObject } from "../types/json.js";
import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";
import type { HubPipelineConfig, HubPipelineNodeResult, HubPipelineResult, NormalizedRequest } from "./hub-pipeline.js";
import { executeRouteAndBuildOutbound } from "./hub-pipeline-route-and-outbound.js";
import {
  assertNoMappableSemanticsInMetadata,
} from "./hub-pipeline-chat-process-entry-blocks.js";
import {
} from "./hub-pipeline-governance-blocks.js";
import {
  coerceChatProcessEntryPayload,
  prepareChatProcessEntryExecutionContext,
} from "./hub-pipeline-execute-chat-process-entry-setup.js";
import { finalizeWorkingRequestForOutbound } from "./hub-pipeline-working-request-blocks.js";
import { requireRequestStageHooks } from "./hub-pipeline-shared-guards.js";
import {
  buildChatProcessEntryPipelineResult,
  createChatProcessEntryNodeResults,
  executeChatProcessGovernancePhase,
  resolveChatProcessEffectivePolicy,
} from "./hub-pipeline-execute-chat-process-entry-orchestration-blocks.js";

export async function executeChatProcessEntryPipeline(args: {
  normalized: NormalizedRequest;
  routerEngine: VirtualRouterEngine;
  config: HubPipelineConfig;
}): Promise<HubPipelineResult> {
  const { normalized, routerEngine, config } = args;
  const hooks = requireRequestStageHooks(normalized.providerProtocol);
  const nodeResults: HubPipelineNodeResult[] = createChatProcessEntryNodeResults();
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

  if (activeProcessMode !== "passthrough") {
    assertNoMappableSemanticsInMetadata(metaBase);
  }

  const processedRequest: ProcessedRequest | undefined =
    await executeChatProcessGovernancePhase({
      normalized,
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
    effectivePolicy: resolveChatProcessEffectivePolicy(normalized, config),
    shadowCompareBaselineMode: undefined,
    routeSelectTiming: {
      enabled: false,
    },
  });

  return buildChatProcessEntryPipelineResult({
    normalized,
    standardizedRequest,
    processedRequest,
    outbound,
    nodeResults,
  });
}
