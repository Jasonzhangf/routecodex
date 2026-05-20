import type { StageRecorder } from "../format-adapters/index.js";
import type { JsonObject } from "../types/json.js";
import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { HubPipelineConfig, HubPipelineNodeResult, NormalizedRequest } from "./hub-pipeline.js";
import type { RequestStageHooks } from "./hub-pipeline-stage-hooks.js";
import { type HubPolicyConfig } from "../policy/policy-engine.js";
import { buildAdapterContextFromNormalized } from "./hub-pipeline-adapter-context.js";
import { shouldRecordSnapshots } from "../../snapshot-utils.js";
import { createSnapshotRecorder } from "../snapshot-recorder.js";
import type { AdapterContext } from "../types/chat-envelope.js";
import { isCompactionRequest } from "../../compaction-detect.js";
import { resolveApplyPatchToolModeFromToolsWithNative, findMappableSemanticsKeysWithNative, prepareRuntimeMetadataForServertoolsWithNative } from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { ensureRuntimeMetadata } from "../../runtime-metadata.js";
import { requireJsonObjectPayload } from "./hub-pipeline-shared-guards.js";
import {
  resolveActiveProcessModeAndAudit,
  sanitizeStandardizedRequestMessages,
} from "./hub-pipeline-chat-process-request-utils.js";
import { propagateApplyPatchToolModeToRequestMetadata } from "./hub-pipeline-request-metadata-blocks.js";
import { runReqInboundStage1FormatParse } from "./stages/req_inbound/req_inbound_stage1_format_parse/index.js";
import { runReqInboundStage2SemanticMap } from "./stages/req_inbound/req_inbound_stage2_semantic_map/index.js";
import type { JsonValue } from "../types/json.js";
import { isJsonObject } from "../types/json.js";
import { writeCacheEntryForRequest } from "./stages/req_inbound/req_inbound_stage3_context_capture/cache-write.js";
import { captureResponsesRequestContext } from "../../shared/responses-conversation-store.js";
import { buildReqInboundNodeResultWithNative, readResponsesResumeFromMetadataWithNative, resolveHubClientProtocolWithNative } from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { recordHubPolicyObservation } from "../policy/policy-engine.js";
import { annotatePassthroughAuditSkipped, appendPassthroughGovernanceSkippedNode, appendToolGovernanceNodeResult, propagateClockReservationToMetadata } from "./hub-pipeline-chat-process-governance-utils.js";
import { runReqProcessStage1ToolGovernance } from "./stages/req_process/req_process_stage1_tool_governance/index.js";
import { measureHubStage } from "./hub-stage-timing.js";

import { syncResponsesContextFromCanonicalMessagesWithNative } from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { containsImageAttachment } from "../process/chat-process-media.js";
import { decideHeavyInputFastpath } from "../../../router/virtual-router/engine-selection/native-router-hotpath.js";
import { markHeavyInputFastpath } from "./hub-pipeline-heavy-input-fastpath.js";

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


function observeClientInboundPayload(args: {
  normalized: NormalizedRequest;
  effectivePolicy: HubPolicyConfig | undefined;
  rawRequest: JsonObject;
  inboundRecorder?: StageRecorder;
}): void {
  const protocol = resolveHubClientProtocolWithNative(args.normalized.entryEndpoint);
  recordHubPolicyObservation({
    policy: args.effectivePolicy,
    providerProtocol: protocol === "openai-responses" || protocol === "anthropic-messages" || protocol === "openai-chat" ? protocol : "openai-chat",
    payload: args.rawRequest,
    phase: "client_inbound",
    stageRecorder: args.inboundRecorder,
    requestId: args.normalized.id,
  });
}

function readResponsesResumeSnapshot(metadata: Record<string, unknown> | undefined): JsonObject | undefined {
  const raw = readResponsesResumeFromMetadataWithNative(metadata);
  return raw && isJsonObject(raw as JsonValue) ? (raw as JsonObject) : undefined;
}

function clearResponsesResumeMetadata(metadata: Record<string, unknown> | undefined, responsesResumeFromMetadata: JsonObject | undefined): void {
  if (!responsesResumeFromMetadata || !metadata || !Object.prototype.hasOwnProperty.call(metadata, "responsesResume")) return;
  delete metadata.responsesResume;
}

function persistResponsesConversationContext(args: {
  adapterContext: ReturnType<typeof buildAdapterContextFromNormalized>;
  rawRequest: JsonObject;
  context: Record<string, unknown> | undefined;
}): void {
  if (!args.context) return;
  const providerProtocol = resolveHubClientProtocolWithNative(args.adapterContext.entryEndpoint);
  if (providerProtocol !== "openai-responses") return;
  const reqId = typeof args.adapterContext.requestId === "string" ? args.adapterContext.requestId.trim() : undefined;
  if (!reqId) return;
  captureResponsesRequestContext({
    requestId: reqId,
    payload: args.rawRequest as unknown as Record<string, unknown>,
    context: args.context as unknown as Record<string, unknown>,
    sessionId: typeof (args.adapterContext as Record<string, unknown>).sessionId === "string" ? String((args.adapterContext as Record<string, unknown>).sessionId) : undefined,
    conversationId: typeof (args.adapterContext as Record<string, unknown>).conversationId === "string" ? String((args.adapterContext as Record<string, unknown>).conversationId) : undefined,
    routeHint: typeof (args.adapterContext as Record<string, unknown>).routeId === "string" ? String((args.adapterContext as Record<string, unknown>).routeId) : undefined,
  });
}

async function captureInboundContextSnapshot<TContext = Record<string, unknown>>(args: {
  inboundStage2ResponsesContext: Record<string, unknown> | undefined;
  rawRequest: JsonObject;
  inboundAdapterContext: ReturnType<typeof buildAdapterContextFromNormalized>;
  hooks: RequestStageHooks<TContext>;
  inboundRecorder?: StageRecorder;
}): Promise<Record<string, unknown> | undefined> {
  if (args.inboundStage2ResponsesContext) {
    writeCacheEntryForRequest({ rawRequest: args.rawRequest, adapterContext: args.inboundAdapterContext as any });
    persistResponsesConversationContext({
      adapterContext: args.inboundAdapterContext,
      rawRequest: args.rawRequest,
      context: args.inboundStage2ResponsesContext,
    });
    return args.inboundStage2ResponsesContext;
  }
  const fallbackContext = await args.hooks.captureContext({ rawRequest: args.rawRequest, adapterContext: args.inboundAdapterContext as any, stageRecorder: args.inboundRecorder });
  persistResponsesConversationContext({
    adapterContext: args.inboundAdapterContext,
    rawRequest: args.rawRequest,
    context: fallbackContext as Record<string, unknown> | undefined,
  });
  return fallbackContext as Record<string, unknown> | undefined;
}

function appendInboundNodeResult(args: {
  nodeResults: HubPipelineNodeResult[];
  inboundStart: number;
  inboundEnd: number;
  standardizedMessages: number;
  standardizedTools: number;
}): void {
  args.nodeResults.push(buildReqInboundNodeResultWithNative({ inboundStart: args.inboundStart, inboundEnd: args.inboundEnd, messages: args.standardizedMessages, tools: args.standardizedTools }) as unknown as HubPipelineNodeResult);
}

export interface RequestStageInboundResult<TContext = Record<string, unknown>> { rawRequest: JsonObject; semanticMapper: ReturnType<RequestStageHooks<TContext>["createSemanticMapper"]>; effectivePolicy: HubPolicyConfig | undefined; shadowCompareBaselineMode: NormalizedRequest["shadowCompare"] extends { baselineMode: infer T } ? T : never; inboundRecorder?: StageRecorder; contextSnapshot?: Record<string, unknown>; standardizedRequest: StandardizedRequest; processedRequest?: ProcessedRequest; workingRequest: StandardizedRequest | ProcessedRequest; activeProcessMode: "chat" | "passthrough"; passthroughAudit?: Record<string, unknown>; nodeResults: HubPipelineNodeResult[]; hasImageAttachment: boolean; serverToolRequired: boolean; }

async function executeInboundSemanticStages<TContext = Record<string, unknown>>(args: { normalized: NormalizedRequest; hooks: RequestStageHooks<TContext>; semanticMapper: ReturnType<RequestStageHooks<TContext>["createSemanticMapper"]>; rawRequest: JsonObject; effectivePolicy: HubPolicyConfig | undefined; inboundAdapterContext: ReturnType<typeof buildAdapterContextFromNormalized>; inboundRecorder?: StageRecorder; }) {
  observeClientInboundPayload({ normalized: args.normalized, effectivePolicy: args.effectivePolicy, rawRequest: args.rawRequest, inboundRecorder: args.inboundRecorder });
  const formatEnvelope = await measureHubStage(args.normalized.id, "req_inbound.stage1_format_parse", () => runReqInboundStage1FormatParse({ rawRequest: args.rawRequest, adapterContext: args.inboundAdapterContext, stageRecorder: args.inboundRecorder }));
  const responsesResumeFromMetadata = readResponsesResumeSnapshot(args.normalized.metadata as Record<string, unknown> | undefined);
  const inboundStage2 = await measureHubStage(args.normalized.id, "req_inbound.stage2_semantic_map", () => runReqInboundStage2SemanticMap({ adapterContext: args.inboundAdapterContext, formatEnvelope, semanticMapper: args.semanticMapper, ...(responsesResumeFromMetadata ? { responsesResume: responsesResumeFromMetadata } : {}), stageRecorder: args.inboundRecorder }));
  clearResponsesResumeMetadata(args.normalized.metadata as Record<string, unknown> | undefined, responsesResumeFromMetadata);
  const contextSnapshot = await measureHubStage(args.normalized.id, "req_inbound.stage3_context_capture", () => captureInboundContextSnapshot({ inboundStage2ResponsesContext: inboundStage2.responsesContext as Record<string, unknown> | undefined, rawRequest: args.rawRequest, inboundAdapterContext: args.inboundAdapterContext, hooks: args.hooks, inboundRecorder: args.inboundRecorder }));
  const standardizedRequest = sanitizeStandardizedRequestMessages(inboundStage2.standardizedRequest as unknown as StandardizedRequest);
  propagateApplyPatchToolModeToRequestMetadata(args.normalized.metadata as Record<string, unknown> | undefined, standardizedRequest);
  const { activeProcessMode, passthroughAudit } = resolveActiveProcessModeAndAudit({ normalized: args.normalized, requestMessages: standardizedRequest.messages, rawPayload: args.rawRequest });
  return { contextSnapshot: contextSnapshot as Record<string, unknown> | undefined, standardizedRequest, activeProcessMode, passthroughAudit };
}

async function executeInboundGovernanceStage(args: { normalized: NormalizedRequest; config: HubPipelineConfig; standardizedRequest: StandardizedRequest; rawRequest: JsonObject; inboundRecorder?: StageRecorder; inboundStart: number; activeProcessMode: "chat" | "passthrough"; passthroughAudit?: Record<string, unknown>; }) {
  const inboundEnd = Date.now(); const nodeResults: HubPipelineNodeResult[] = [];
  appendInboundNodeResult({ nodeResults, inboundStart: args.inboundStart, inboundEnd, standardizedMessages: args.standardizedRequest.messages.length, standardizedTools: args.standardizedRequest.tools?.length ?? 0 });
  const metadata = prepareRuntimeMetadataForServertoolsWithNative({ metadata: args.normalized.metadata, webSearchConfig: args.config.virtualRouter?.webSearch as any, execCommandGuard: args.config.virtualRouter?.execCommandGuard as any, clockConfig: args.config.virtualRouter?.clock as any });
  args.normalized.metadata = metadata;
  if (args.activeProcessMode !== "passthrough") { const present = findMappableSemanticsKeysWithNative(metadata); if (present.length) throw new Error(`[HubPipeline][semantic_gate] Mappable semantics must not be stored in metadata (request_stage.inbound): ${present.join(", ")}`); }
  const processedRequest = await measureHubStage(args.normalized.id, "req_process.stage1_tool_governance", async () => {
    if (args.activeProcessMode === "passthrough") { appendPassthroughGovernanceSkippedNode(nodeResults); annotatePassthroughAuditSkipped(args.passthroughAudit); return undefined; }
    const processResult = await runReqProcessStage1ToolGovernance({ request: args.standardizedRequest, rawPayload: args.rawRequest as any, metadata, entryEndpoint: args.normalized.entryEndpoint, requestId: args.normalized.id, stageRecorder: args.inboundRecorder });
    const processed = processResult.processedRequest; propagateClockReservationToMetadata(processed, metadata); appendToolGovernanceNodeResult(nodeResults, processResult.nodeResult as any); return processed;
  });
  return { processedRequest, nodeResults };
}


export function finalizeWorkingRequestForOutbound(args: {
  request: StandardizedRequest | ProcessedRequest | Record<string, unknown>;
  normalized: NormalizedRequest;
}): {
  workingRequest: StandardizedRequest | ProcessedRequest;
  hasImageAttachment: boolean;
  serverToolRequired: boolean;
} {
  const workingRequest = syncResponsesContextFromCanonicalMessagesWithNative(
    args.request as Record<string, unknown>,
  ) as unknown as StandardizedRequest | ProcessedRequest;
  {
    const normalizedMetadata =
      (args.normalized.metadata as Record<string, unknown> | undefined) ??
      ((args.normalized.metadata = {}) as Record<string, unknown>);
    const decision = decideHeavyInputFastpath(
      workingRequest as unknown as Record<string, unknown>,
      normalizedMetadata,
    );
    if (typeof decision.estimatedTokens === "number" && Number.isFinite(decision.estimatedTokens) && decision.estimatedTokens > 0) {
      normalizedMetadata.estimatedInputTokens = Math.floor(decision.estimatedTokens);
    }
    if (decision.shouldMark === true) {
      markHeavyInputFastpath({ metadata: normalizedMetadata, estimatedInputTokens: normalizedMetadata.estimatedInputTokens, reason: decision.reason ?? "rough_estimate" });
    }
  }
  const stdMetadata = (workingRequest as StandardizedRequest | ProcessedRequest | undefined)?.metadata as Record<string, unknown> | undefined;
  const hasImageAttachment = containsImageAttachment((workingRequest.messages ?? []) as StandardizedRequest["messages"]);
  const serverToolRequired = stdMetadata?.webSearchEnabled === true || stdMetadata?.serverToolRequired === true;
  return {
    workingRequest,
    hasImageAttachment,
    serverToolRequired,
  };
}

export async function executeRequestStageInbound<TContext = Record<string, unknown>>(args: { normalized: NormalizedRequest; hooks: RequestStageHooks<TContext>; config: HubPipelineConfig; }): Promise<RequestStageInboundResult<TContext>> {
  const { normalized, hooks, config } = args; const rawRequest = requireJsonObjectPayload(normalized);
  const toolsRaw = Array.isArray((rawRequest as any)?.tools) ? (rawRequest as any).tools : null;
  const applyPatchToolMode = resolveApplyPatchToolModeFromToolsWithNative(toolsRaw) as string | undefined;
  if (applyPatchToolMode) {
    normalized.metadata = normalized.metadata || {};
    const rt = ensureRuntimeMetadata(normalized.metadata as Record<string, unknown>);
    (rt as Record<string, unknown>).applyPatchToolMode = applyPatchToolMode;
  }
  if (isCompactionRequest(rawRequest)) {
    normalized.metadata = normalized.metadata || {};
    const rt = ensureRuntimeMetadata(normalized.metadata as Record<string, unknown>);
    (rt as Record<string, unknown>).compactionRequest = true;
  }
  const inboundAdapterContext = buildAdapterContextFromNormalized(normalized);
  const effectivePolicy = normalized.policyOverride ?? config.policy;
  const shadowCompareBaselineMode = normalized.shadowCompare?.baselineMode;
  const inboundRecorder = createHubSnapshotStageRecorder({ normalized, adapterContext: inboundAdapterContext, warningLabel: "Inbound snapshot recorder creation" });
  const inboundStart = Date.now();
  const { contextSnapshot, standardizedRequest, activeProcessMode, passthroughAudit } = await executeInboundSemanticStages({ normalized, hooks, semanticMapper: hooks.createSemanticMapper(), rawRequest, effectivePolicy, inboundAdapterContext, inboundRecorder });
  const { processedRequest, nodeResults } = await executeInboundGovernanceStage({ normalized, config, standardizedRequest, rawRequest, inboundRecorder, inboundStart, activeProcessMode, passthroughAudit });
  const { workingRequest, hasImageAttachment, serverToolRequired } = finalizeWorkingRequestForOutbound({ request: (processedRequest ?? standardizedRequest) as unknown as Record<string, unknown>, normalized });
  return { rawRequest, semanticMapper: hooks.createSemanticMapper(), effectivePolicy, shadowCompareBaselineMode, inboundRecorder, contextSnapshot: contextSnapshot as Record<string, unknown> | undefined, standardizedRequest, processedRequest, workingRequest, activeProcessMode, passthroughAudit, nodeResults, hasImageAttachment, serverToolRequired };
}
