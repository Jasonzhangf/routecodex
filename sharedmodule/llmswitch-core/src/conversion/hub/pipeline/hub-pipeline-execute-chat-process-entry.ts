import type { JsonObject } from "../types/json.js";
import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";
import type { HubPipelineConfig, HubPipelineNodeResult, HubPipelineResult, NormalizedRequest } from "./hub-pipeline.js";
import type { StageRecorder } from "../format-adapters/index.js";
import type { AdapterContext } from "../types/chat-envelope.js";
import { shouldRecordSnapshots } from "../../snapshot-utils.js";
import { createSnapshotRecorder } from "../snapshot-recorder.js";
import { executeRouteAndBuildOutbound } from "./hub-pipeline-route-and-outbound.js";
import { buildAdapterContextFromNormalized } from './hub-pipeline-adapter-context.js';
import { readRuntimeMetadata } from "../../runtime-metadata.js";
import {
  buildReqInboundSkippedNodeWithNative,
  coerceStandardizedRequestFromPayloadWithNative as __nativeNormalizeStdReq,
  findMappableSemanticsKeysWithNative,
  liftResponsesResumeIntoSemanticsWithNative,
  prepareRuntimeMetadataForServertoolsWithNative,
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
} from "./hub-pipeline-chat-process-shared.js";



function propagateApplyPatchToolModeToRequestMetadata(
  normalizedMetadata: Record<string, unknown> | undefined,
  standardizedRequest: StandardizedRequest,
): void {
  try {
    const rt = readRuntimeMetadata((normalizedMetadata ?? {}) as Record<string, unknown>);
    const mode = String((rt as any)?.applyPatchToolMode || "").trim().toLowerCase();
    if (mode === "schema") {
      (standardizedRequest.metadata as Record<string, unknown>).applyPatchToolMode = mode;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? "unknown");
    console.warn(`[hub-pipeline] propagateApplyPatchToolModeToRequestMetadata failed (non-blocking): ${reason}`);
  }
}

function mergeRuntimeMetadataPatch(base: Record<string, unknown>, patch: Record<string, unknown>): void { Object.assign(base, patch); }

function createHubSnapshotStageRecorder(args: {
  normalized: NormalizedRequest;
  adapterContext: AdapterContext;
  warningLabel: string;
}): StageRecorder | undefined {
  const { normalized, adapterContext, warningLabel } = args;
  if (normalized.externalStageRecorder) return normalized.externalStageRecorder;
  if (normalized.disableSnapshots === true) return undefined;
  if (!shouldRecordSnapshots()) return undefined;
  const effectiveEndpoint = normalized.entryEndpoint || adapterContext.entryEndpoint || "/v1/chat/completions";
  try {
    return createSnapshotRecorder(adapterContext, effectiveEndpoint);
  } catch (snapshotError) {
    console.warn(`[hub-pipeline] ${warningLabel} failed (non-blocking): ${snapshotError instanceof Error ? snapshotError.message : String(snapshotError)}`);
    return undefined;
  }
}

function createChatProcessEntryNodeResults(): HubPipelineNodeResult[] { return [buildReqInboundSkippedNodeWithNative({ reason: "stage=outbound" }) as unknown as HubPipelineNodeResult]; }

function prepareChatProcessEntryExecutionContext(args: { normalized: NormalizedRequest; config: HubPipelineConfig; standardizedRequestBase: StandardizedRequest; rawPayload: Record<string, unknown>; }): { metaBase: Record<string, unknown>; standardizedRequest: StandardizedRequest; activeProcessMode: "chat" | "passthrough"; passthroughAudit?: Record<string, unknown>; stageRecorder: ReturnType<typeof createHubSnapshotStageRecorder>; } {
  const metaBase = prepareRuntimeMetadataForServertoolsWithNative({ metadata: args.normalized.metadata, webSearchConfig: args.config.virtualRouter?.webSearch as any, execCommandGuard: args.config.virtualRouter?.execCommandGuard as any, clockConfig: args.config.virtualRouter?.clock as any });
  args.normalized.metadata = metaBase;
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
  propagateApplyPatchToolModeToRequestMetadata(metaBase, standardizedRequest);
  const adapterContext = buildAdapterContextFromNormalized(args.normalized);
  const stageRecorder = createHubSnapshotStageRecorder({ normalized: args.normalized, adapterContext, warningLabel: "Snapshot recorder creation" });
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
  if (activeProcessMode !== "passthrough") { const present = findMappableSemanticsKeysWithNative(metaBase); if (present.length) throw new Error(`[HubPipeline][semantic_gate] Mappable semantics must not be stored in metadata (chat_process.request.entry): ${present.join(", ")}`); }
  const processedRequest = await executeChatProcessGovernancePhase({ normalized, standardizedRequest, rawPayload, metadata: metaBase, stageRecorder, activeProcessMode, passthroughAudit, nodeResults });
  const { workingRequest, hasImageAttachment, serverToolRequired } = finalizeWorkingRequestForOutbound({ request: (processedRequest ?? standardizedRequest) as unknown as Record<string, unknown>, normalized });
  const outbound = await executeRouteAndBuildOutbound({ normalized, hooks, routerEngine, config, workingRequest, nodeResults, inboundRecorder: stageRecorder, activeProcessMode, serverToolRequired, hasImageAttachment, passthroughAudit, rawRequest: rawPayloadInput, contextSnapshot: undefined, semanticMapper: hooks.createSemanticMapper(), effectivePolicy: resolveChatProcessEffectivePolicy(normalized, config), shadowCompareBaselineMode: undefined, routeSelectTiming: { enabled: false } });
  return buildChatProcessEntryPipelineResult({ normalized, standardizedRequest, processedRequest, outbound, nodeResults });
}
