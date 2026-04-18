import type { JsonObject } from "../types/json.js";
import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";
import type { HubPipelineConfig, HubPipelineNodeResult, HubPipelineResult, NormalizedRequest } from "./hub-pipeline.js";
import { shouldRecordSnapshots } from "../../snapshot-utils.js";
import { ensureRuntimeMetadata } from "../../runtime-metadata.js";
import { REQUEST_STAGE_HOOKS } from "./hub-pipeline-stage-hooks.js";
import {
  buildReqInboundSkippedNodeWithNative,
  coerceStandardizedRequestFromPayloadWithNative,
  findMappableSemanticsKeysWithNative,
  liftResponsesResumeIntoSemanticsWithNative,
  prepareRuntimeMetadataForServertoolsWithNative,
  syncResponsesContextFromCanonicalMessagesWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { runReqProcessStage1ToolGovernance } from "./stages/req_process/req_process_stage1_tool_governance/index.js";
import { buildAdapterContextFromNormalized } from "./hub-pipeline-adapter-context.js";
import {
  deriveWorkingRequestFlags,
  estimateInputTokensForWorkingRequest,
  prepareReasoningStopRequestTooling,
  propagateApplyPatchToolModeToRequestMetadata,
  resolveActiveProcessModeAndAudit,
  sanitizeStandardizedRequestMessages,
} from "./hub-pipeline-chat-process-request-utils.js";
import {
  annotatePassthroughAuditSkipped,
  appendPassthroughGovernanceSkippedNode,
  appendToolGovernanceNodeResult,
  propagateClockReservationToMetadata,
} from "./hub-pipeline-chat-process-governance-utils.js";
import { createSnapshotRecorder } from "../snapshot-recorder.js";
import { executeRouteAndBuildOutbound } from "./hub-pipeline-route-and-outbound.js";
import { peekHubStageTopSummary } from "./hub-stage-timing.js";

export async function executeChatProcessEntryPipeline(args: {
  normalized: NormalizedRequest;
  routerEngine: VirtualRouterEngine;
  config: HubPipelineConfig;
}): Promise<HubPipelineResult> {
  const { normalized, routerEngine, config } = args;
const hooks = REQUEST_STAGE_HOOKS[normalized.providerProtocol];
if (!hooks) {
  throw new Error(
    `Unsupported provider protocol for hub pipeline: ${normalized.providerProtocol}`,
  );
}

const nodeResults: HubPipelineNodeResult[] = [];
nodeResults.push(
  buildReqInboundSkippedNodeWithNative({
    reason: "stage=outbound",
  }) as unknown as HubPipelineNodeResult,
);

const rawPayloadInput = (() => {
  const payload = normalized.payload;
  if (!payload || typeof payload !== "object") {
    throw new Error("Responses pipeline requires JSON object payload");
  }
  return payload as JsonObject;
})();
const coerced = coerceStandardizedRequestFromPayloadWithNative({
  payload: rawPayloadInput as Record<string, unknown>,
  normalized: {
    id: normalized.id,
    entryEndpoint: normalized.entryEndpoint,
    stream: normalized.stream,
    processMode: normalized.processMode,
    routeHint: normalized.routeHint,
  },
});
const standardizedRequestBase =
  coerced.standardizedRequest as unknown as StandardizedRequest;
const rawPayload = coerced.rawPayload;

// Keep metadata injection consistent with the inbound path: servertool/web_search config must be available
// to chat-process/tool governance even when request enters at outbound stage.
const metaBase = prepareRuntimeMetadataForServertoolsWithNative({
  metadata: normalized.metadata,
  webSearchConfig: config.virtualRouter?.webSearch as unknown as
    | Record<string, unknown>
    | undefined,
  execCommandGuard: config.virtualRouter?.execCommandGuard as unknown as
    | Record<string, unknown>
    | undefined,
  clockConfig: config.virtualRouter?.clock as unknown as
    | Record<string, unknown>
    | undefined,
});
normalized.metadata = metaBase;

let standardizedRequest: StandardizedRequest =
  sanitizeStandardizedRequestMessages(standardizedRequestBase);

const { activeProcessMode, passthroughAudit } =
  resolveActiveProcessModeAndAudit({
    normalized,
    requestMessages: standardizedRequest.messages,
    rawPayload,
  });
// Semantic Gate (chat_process entry): lift any mappable protocol semantics from metadata into request.semantics.
// This is the last chance before entering chat_process; after this point we fail-fast on banned metadata keys.
try {
  const lifted = liftResponsesResumeIntoSemanticsWithNative(
    standardizedRequest as unknown as Record<string, unknown>,
    metaBase,
  );
  for (const key of Object.keys(metaBase)) {
    delete metaBase[key];
  }
  Object.assign(metaBase, lifted.metadata);
  standardizedRequest = lifted.request as unknown as StandardizedRequest;
} catch {
  // best-effort; validation happens below
}
propagateApplyPatchToolModeToRequestMetadata(
  metaBase,
  standardizedRequest,
);

const adapterContext = buildAdapterContextFromNormalized(normalized);
prepareReasoningStopRequestTooling({
  request: standardizedRequest,
  adapterContext,
});
const stageRecorder = (() => {
  if (normalized.externalStageRecorder) {
    return normalized.externalStageRecorder;
  }
  if (normalized.disableSnapshots === true) {
    return undefined;
  }
  if (!shouldRecordSnapshots()) {
    return undefined;
  }
  const effectiveEndpoint =
    normalized.entryEndpoint ||
    adapterContext.entryEndpoint ||
    "/v1/chat/completions";
  try {
    return createSnapshotRecorder(adapterContext, effectiveEndpoint);
  } catch {
    return undefined;
  }
})();

let processedRequest: ProcessedRequest | undefined;
if (activeProcessMode !== "passthrough") {
  {
    const present = findMappableSemanticsKeysWithNative(metaBase);
    if (present.length) {
      throw new Error(
        `[HubPipeline][semantic_gate] Mappable semantics must not be stored in metadata (chat_process.request.entry): ${present.join(", ")}`,
      );
    }
  }
  const processResult = await runReqProcessStage1ToolGovernance({
    request: standardizedRequest,
    rawPayload,
    metadata: metaBase,
    entryEndpoint: normalized.entryEndpoint,
    requestId: normalized.id,
    stageRecorder,
  });
  processedRequest = processResult.processedRequest;
  // Surface request-side clock reservation into pipeline metadata so response conversion
  // can commit delivery only after a successful response is produced.
  propagateClockReservationToMetadata(
    processedRequest,
    metaBase as Record<string, unknown>,
  );
  appendToolGovernanceNodeResult(nodeResults, processResult.nodeResult as any);
} else {
  appendPassthroughGovernanceSkippedNode(nodeResults);
  annotatePassthroughAuditSkipped(passthroughAudit);
}

let workingRequest = syncResponsesContextFromCanonicalMessagesWithNative(
  (processedRequest ?? standardizedRequest) as unknown as Record<
    string,
    unknown
  >,
) as unknown as StandardizedRequest | ProcessedRequest;

// Token estimate for stats/diagnostics (best-effort).
estimateInputTokensForWorkingRequest({
  workingRequest,
  normalizedMetadata:
    (normalized.metadata as Record<string, unknown> | undefined) ??
    ((normalized.metadata = {}) as Record<string, unknown>),
});

const { hasImageAttachment, serverToolRequired } =
  deriveWorkingRequestFlags(workingRequest);

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

const hubStageTop = peekHubStageTopSummary(normalized.id);
if (hubStageTop.length) {
  const rt = ensureRuntimeMetadata(outbound.metadata);
  (rt as Record<string, unknown>).hubStageTop = hubStageTop as unknown;
}

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
