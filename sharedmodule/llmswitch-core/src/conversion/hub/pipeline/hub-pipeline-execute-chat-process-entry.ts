import type { JsonObject } from "../types/json.js";
import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";
import type { HubPipelineConfig, HubPipelineNodeResult, HubPipelineResult, NormalizedRequest } from "./hub-pipeline.js";
import type { StageRecorder } from "../format-adapters/index.js";
import { executeRouteAndBuildOutbound } from "./hub-pipeline-route-and-outbound.js";
import { buildAdapterContextFromNormalized } from './hub-pipeline-adapter-context.js';
import {
  buildReqInboundSkippedNodeWithNative,
  coerceStandardizedRequestFromPayloadWithNative as __nativeNormalizeStdReq,
  liftResponsesResumeIntoSemanticsWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { requireJsonObjectPayload, requireRequestStageHooks } from "./hub-pipeline-shared-guards.js";
import { finalizeWorkingRequestForOutbound } from "./hub-pipeline-execute-request-stage-inbound.js";
import {
  annotatePassthroughAuditSkipped,
  appendPassthroughGovernanceSkippedNode,
  appendToolGovernanceNodeResult,
  propagateClockReservationToMetadata,
} from './hub-pipeline-chat-process-governance-utils.js';
import { runReqProcessStage1ToolGovernance } from './stages/req_process/req_process_stage1_tool_governance/index.js';
import {
  attachHubStageTopSummary,
  resolveActiveProcessModeAndAudit,
  sanitizeStandardizedRequestMessages,
} from "./hub-pipeline-chat-process-request-utils.js";
import {
  assertNoMappableSemanticsInMetadata,
  createChatProcessSnapshotRecorder,
  prepareChatProcessRuntimeMetadata,
} from "./hub-pipeline-chat-process-entry-blocks.js";
import { createHubSnapshotStageRecorder } from "./hub-pipeline-snapshot-recorder-blocks.js";

function mergeRuntimeMetadataPatch(base: Record<string, unknown>, patch: Record<string, unknown>): void { Object.assign(base, patch); }

function createChatProcessEntryNodeResults(): HubPipelineNodeResult[] { return [buildReqInboundSkippedNodeWithNative({ reason: "stage=outbound" }) as unknown as HubPipelineNodeResult]; }

function prepareChatProcessEntryExecutionContext(args: { normalized: NormalizedRequest; config: HubPipelineConfig; standardizedRequestBase: StandardizedRequest; rawPayload: Record<string, unknown>; }): { metaBase: Record<string, unknown>; standardizedRequest: StandardizedRequest; activeProcessMode: "chat" | "passthrough"; passthroughAudit?: Record<string, unknown>; stageRecorder: ReturnType<typeof createHubSnapshotStageRecorder>; } {
  const metaBase = prepareChatProcessRuntimeMetadata({ normalized: args.normalized, config: args.config });
  let standardizedRequest: StandardizedRequest = args.standardizedRequestBase;
  const { activeProcessMode, passthroughAudit } = resolveActiveProcessModeAndAudit({ normalized: args.normalized, requestMessages: standardizedRequest.messages, rawPayload: args.rawPayload });
  standardizedRequest = sanitizeStandardizedRequestMessages(standardizedRequest);
  try {
    const lifted = liftResponsesResumeIntoSemanticsWithNative(standardizedRequest as any, metaBase);
    mergeRuntimeMetadataPatch(metaBase, lifted.metadata as Record<string, unknown>);
    standardizedRequest = lifted.request as unknown as StandardizedRequest;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? "unknown");
    throw new Error(`[HubPipeline][semantic_gate] Failed to lift protocol semantics into request.semantics before chat_process (requestId=${args.normalized.id || "unknown"}): ${reason}`);
  }
  const adapterContext = buildAdapterContextFromNormalized(args.normalized);
  const stageRecorder = createChatProcessSnapshotRecorder({ normalized: args.normalized, adapterContext, warningLabel: "Snapshot recorder creation" });
  return { metaBase, standardizedRequest, activeProcessMode, passthroughAudit, stageRecorder };
}

async function executeChatProcessGovernancePhase(args: { normalized: NormalizedRequest; standardizedRequest: StandardizedRequest; rawPayload: Record<string, unknown>; metadata: Record<string, unknown>; stageRecorder: unknown; activeProcessMode: "chat" | "passthrough"; passthroughAudit?: Record<string, unknown>; nodeResults: HubPipelineNodeResult[]; }): Promise<ProcessedRequest | undefined> {
  if (args.activeProcessMode === "passthrough") { appendPassthroughGovernanceSkippedNode(args.nodeResults); annotatePassthroughAuditSkipped(args.passthroughAudit); return undefined; }
  const processResult = await runReqProcessStage1ToolGovernance({ request: args.standardizedRequest, rawPayload: args.rawPayload, metadata: args.metadata, entryEndpoint: args.normalized.entryEndpoint, requestId: args.normalized.id, stageRecorder: args.stageRecorder as any });
  const processedRequest = processResult.processedRequest;
  propagateClockReservationToMetadata(processedRequest, args.metadata);
  appendToolGovernanceNodeResult(args.nodeResults, processResult.nodeResult as any);
  return processedRequest;
}

function buildChatProcessEntryPipelineResult(args: { normalized: NormalizedRequest; standardizedRequest: StandardizedRequest; processedRequest?: ProcessedRequest; outbound: { providerPayload?: Record<string, unknown>; routingDecision?: HubPipelineResult["routingDecision"]; routingDiagnostics?: HubPipelineResult["routingDiagnostics"]; target?: HubPipelineResult["target"]; metadata: Record<string, unknown>; }; nodeResults: HubPipelineNodeResult[]; }): HubPipelineResult {
  attachHubStageTopSummary({ requestId: args.normalized.id, metadata: args.outbound.metadata });
  return { requestId: args.normalized.id, providerPayload: args.outbound.providerPayload, standardizedRequest: args.standardizedRequest, processedRequest: args.processedRequest, routingDecision: args.outbound.routingDecision, routingDiagnostics: args.outbound.routingDiagnostics, target: args.outbound.target, metadata: args.outbound.metadata, nodeResults: args.nodeResults };
}

function resolveChatProcessEffectivePolicy(normalized: NormalizedRequest, config: HubPipelineConfig): HubPipelineConfig["policy"] | undefined { return normalized.policyOverride ?? config.policy; }
function normalizeChatProcessEntryPayload(normalized: NormalizedRequest): { rawPayloadInput: JsonObject; rawPayload: Record<string, unknown>; standardizedRequestBase: StandardizedRequest; } {
  const rawPayloadInput = requireJsonObjectPayload(normalized);
  const nativeNormalized = __nativeNormalizeStdReq({ payload: rawPayloadInput as Record<string, unknown>, normalized: { id: normalized.id, entryEndpoint: normalized.entryEndpoint, stream: normalized.stream, processMode: normalized.processMode, routeHint: normalized.routeHint } });
  return { rawPayloadInput, rawPayload: nativeNormalized.rawPayload, standardizedRequestBase: nativeNormalized.standardizedRequest as unknown as StandardizedRequest };
}




export async function executeChatProcessEntryPipeline(args: { normalized: NormalizedRequest; routerEngine: VirtualRouterEngine; config: HubPipelineConfig; }): Promise<HubPipelineResult> {
  const { normalized, routerEngine, config } = args;
  const hooks = requireRequestStageHooks(normalized.providerProtocol);
  const nodeResults: HubPipelineNodeResult[] = createChatProcessEntryNodeResults();
  const { rawPayloadInput, rawPayload, standardizedRequestBase } = normalizeChatProcessEntryPayload(normalized);
  const { metaBase, standardizedRequest, activeProcessMode, passthroughAudit, stageRecorder } = prepareChatProcessEntryExecutionContext({ normalized, config, standardizedRequestBase, rawPayload });
  if (activeProcessMode !== "passthrough") {
    assertNoMappableSemanticsInMetadata(metaBase);
  }
  const processedRequest = await executeChatProcessGovernancePhase({ normalized, standardizedRequest, rawPayload, metadata: metaBase, stageRecorder, activeProcessMode, passthroughAudit, nodeResults });
  const { workingRequest, hasImageAttachment, serverToolRequired } = finalizeWorkingRequestForOutbound({ request: (processedRequest ?? standardizedRequest) as unknown as Record<string, unknown>, normalized });
  const outbound = await executeRouteAndBuildOutbound({ normalized, hooks, routerEngine, config, workingRequest, nodeResults, inboundRecorder: stageRecorder, activeProcessMode, serverToolRequired, hasImageAttachment, passthroughAudit, rawRequest: rawPayloadInput, contextSnapshot: undefined, semanticMapper: hooks.createSemanticMapper(), effectivePolicy: resolveChatProcessEffectivePolicy(normalized, config), shadowCompareBaselineMode: undefined, routeSelectTiming: { enabled: false } });
  return buildChatProcessEntryPipelineResult({ normalized, standardizedRequest, processedRequest, outbound, nodeResults });
}
