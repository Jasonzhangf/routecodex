import type { JsonObject } from "../types/json.js";
import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";
import type { StageRecorder } from "../format-adapters/index.js";
import type { HubPipelineConfig, HubPipelineNodeResult, HubPipelineResult, NormalizedRequest } from "./hub-pipeline.js";
import type { RequestStageHooks } from "./hub-pipeline-stage-hooks.js";
import type { HubPolicyConfig, HubPolicyMode } from "../policy/policy-engine.js";
import { applyHasImageAttachmentFlagWithNative, buildCapturedChatRequestSnapshotWithNative, buildHubPipelineResultMetadataWithNative, applyOutboundStreamPreferenceWithNative, buildReqOutboundNodeResultWithNative, buildRouterMetadataInputWithNative, resolveOutboundStreamIntentWithNative, syncSessionIdentifiersToMetadataWithNative } from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { replaceMutableRecord } from "./hub-pipeline-mutable-record-utils.js";
import { buildAdapterContextFromNormalized } from "./hub-pipeline-adapter-context.js";
import { shouldRecordSnapshots } from "../../snapshot-utils.js";
import { createSnapshotRecorder } from "../snapshot-recorder.js";
import type { AdapterContext } from "../types/chat-envelope.js";
import { extractSessionIdentifiersFromMetadata } from "./session-identifiers.js";
import { applyMaxTokensPolicyForRequest } from "./hub-pipeline-max-tokens-policy.js";
import { markHeavyInputFastpath, shouldUseHeavyInputFastpath } from "./hub-pipeline-heavy-input-fastpath.js";
import { runReqProcessStage2RouteSelect } from "./stages/req_process/req_process_stage2_route_select/index.js";
import { buildRequestStageProviderPayload } from "./hub-pipeline-execute-request-stage-provider-payload.js";
import { logHubStageTiming } from "./hub-stage-timing.js";


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

type ShadowCompareBaselineMode = NormalizedRequest["shadowCompare"] extends { baselineMode: infer T } ? T : never;

export function buildCapturedChatRequestInput(args: unknown): unknown {
  const directRequest = args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : undefined;
  if (!directRequest) {
    return {};
  }

  const record = directRequest;
  const workingRequest = record.workingRequest && typeof record.workingRequest === "object" && !Array.isArray(record.workingRequest)
    ? (record.workingRequest as Record<string, unknown>)
    : (record.messages || record.input ? record : undefined);
  const normalizedMetadata = record.normalizedMetadata && typeof record.normalizedMetadata === "object" && !Array.isArray(record.normalizedMetadata)
    ? (record.normalizedMetadata as Record<string, unknown>)
    : undefined;

  if (normalizedMetadata && shouldUseHeavyInputFastpath(normalizedMetadata)) {
    markHeavyInputFastpath({
      metadata: normalizedMetadata,
      estimatedInputTokens: normalizedMetadata.estimatedInputTokens,
      reason: "captured_snapshot",
    });
  }

  const messages = Array.isArray(workingRequest?.messages) ? workingRequest?.messages : [];
  const semantics =
    workingRequest && Object.prototype.hasOwnProperty.call(workingRequest, "semantics") &&
    workingRequest?.semantics &&
    typeof workingRequest.semantics === "object" &&
    !Array.isArray(workingRequest.semantics)
      ? workingRequest.semantics
      : undefined;
  return {
    model: (typeof workingRequest?.model === "string" && String(workingRequest.model).trim()) || (typeof normalizedMetadata?.model === "string" && normalizedMetadata.model.trim()) || null,
    messages,
    ...(workingRequest && Object.prototype.hasOwnProperty.call(workingRequest, "input") ? { input: workingRequest?.input } : {}),
    tools: Array.isArray(workingRequest?.tools) ? workingRequest?.tools : null,
    ...(workingRequest && Object.prototype.hasOwnProperty.call(workingRequest, "tool_choice") ? { tool_choice: workingRequest?.tool_choice } : {}),
    ...(workingRequest && Object.prototype.hasOwnProperty.call(workingRequest, "semantics") ? { semantics: semantics ?? null } : {}),
    parameters: workingRequest?.parameters && typeof workingRequest.parameters === "object" && !Array.isArray(workingRequest.parameters)
      ? workingRequest.parameters
      : null,
  };
}


function isCapturedChatRequestShapeValid(value: unknown): value is Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const record = value as Record<string, unknown>; return Array.isArray(record.messages) || (Object.prototype.hasOwnProperty.call(record, "input") && record.input !== undefined); }
function buildValidatedCapturedChatRequest(args: { normalized: NormalizedRequest; workingRequest: StandardizedRequest | ProcessedRequest; }): Record<string, unknown> {
  const capturedChatRequest = buildCapturedChatRequestSnapshotWithNative(buildCapturedChatRequestInput({ workingRequest: args.workingRequest, normalizedMetadata: args.normalized.metadata as Record<string, unknown> | undefined }));
  if (!isCapturedChatRequestShapeValid(capturedChatRequest)) throw Object.assign(new Error("[HubPipeline] capturedChatRequest must be chat-like (messages or input) for response-side servertool."), { code: "ERR_CAPTURED_CHAT_REQUEST_INVALID", requestId: args.normalized.id, processMode: args.normalized.processMode, entryEndpoint: args.normalized.entryEndpoint });
  return capturedChatRequest;
}
function finalizeRouteAndOutboundMetadata(args: { normalized: NormalizedRequest; outboundProtocol: NormalizedRequest["providerProtocol"]; target: HubPipelineResult["target"]; outboundStream: boolean; capturedChatRequest: Record<string, unknown>; shadowCompareBaselineMode?: ShadowCompareBaselineMode; effectivePolicyMode?: HubPolicyMode; shadowBaselineProviderPayload?: Record<string, unknown>; hasImageAttachment: boolean; }): Record<string, unknown> {
  const metadata = buildHubPipelineResultMetadataWithNative({ normalized: { metadata: args.normalized.metadata, entryEndpoint: args.normalized.entryEndpoint, stream: args.normalized.stream, processMode: args.normalized.processMode, routeHint: args.normalized.routeHint }, outboundProtocol: args.outboundProtocol, target: args.target, outboundStream: args.outboundStream, capturedChatRequest: args.capturedChatRequest, shadowCompareBaselineMode: args.shadowCompareBaselineMode, effectivePolicy: args.effectivePolicyMode ? { mode: args.effectivePolicyMode } : undefined, shadowBaselineProviderPayload: args.shadowBaselineProviderPayload });
  const metadataWithImageFlag = applyHasImageAttachmentFlagWithNative({ metadata, hasImageAttachment: args.hasImageAttachment }); replaceMutableRecord(metadata, metadataWithImageFlag); return metadata;
}
function syncNormalizedSessionMetadata(args: { normalizedMetadata: Record<string, unknown> | undefined; sessionId?: string; conversationId?: string; }) { const { normalizedMetadata, sessionId, conversationId } = args; if (!normalizedMetadata || typeof normalizedMetadata !== "object") return undefined; const next = syncSessionIdentifiersToMetadataWithNative({ metadata: normalizedMetadata, sessionId, conversationId }); replaceMutableRecord(normalizedMetadata, next); return normalizedMetadata; }
function readRouteRuntimeDirectives(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined { return metadata && typeof metadata.__rt === "object" && !Array.isArray(metadata.__rt) ? (metadata.__rt as Record<string, unknown>) : undefined; }
function buildRouteMetadataInput(args: { normalized: NormalizedRequest; requestSemantics: Record<string, unknown> | undefined; serverToolRequired: boolean; sessionId?: string; conversationId?: string; normalizedMetadata: Record<string, unknown> | undefined; routeRuntimeDirectives?: Record<string, unknown>; }): Record<string, unknown> { const metadataInput = buildRouterMetadataInputWithNative({ requestId: args.normalized.id, entryEndpoint: args.normalized.entryEndpoint, processMode: args.normalized.processMode, stream: args.normalized.stream, direction: args.normalized.direction, providerProtocol: args.normalized.providerProtocol, routeHint: args.normalized.routeHint, stage: args.normalized.stage, requestSemantics: args.requestSemantics, includeEstimatedInputTokens: true, serverToolRequired: args.serverToolRequired, sessionId: args.sessionId, conversationId: args.conversationId, metadata: args.normalizedMetadata }) as Record<string, unknown>; if (args.routeRuntimeDirectives) metadataInput.__rt = { ...args.routeRuntimeDirectives }; return metadataInput; }
function prepareRouteSelectionContext(args: { normalized: NormalizedRequest; workingRequest: StandardizedRequest | ProcessedRequest; serverToolRequired: boolean; }) { const sessionIdentifiers = extractSessionIdentifiersFromMetadata(args.normalized.metadata as Record<string, unknown> | undefined); const normalizedMetadata = args.normalized.metadata as Record<string, unknown> | undefined; syncNormalizedSessionMetadata({ normalizedMetadata, sessionId: sessionIdentifiers.sessionId, conversationId: sessionIdentifiers.conversationId }); return { metadataInput: buildRouteMetadataInput({ normalized: args.normalized, requestSemantics: (args.workingRequest as any).semantics, serverToolRequired: args.serverToolRequired === true, sessionId: sessionIdentifiers.sessionId, conversationId: sessionIdentifiers.conversationId, normalizedMetadata, routeRuntimeDirectives: readRouteRuntimeDirectives(normalizedMetadata) }) }; }
function prepareOutboundExecutionContext(args: { normalized: NormalizedRequest; routingTarget: HubPipelineResult["target"]; workingRequest: StandardizedRequest | ProcessedRequest; routerEngine: { updateDeps?: unknown }; }) { const outboundStream = resolveOutboundStreamIntentWithNative(args.routingTarget?.streaming); const workingRequest = applyOutboundStreamPreferenceWithNative(args.workingRequest as any, outboundStream) as unknown as StandardizedRequest | ProcessedRequest; applyMaxTokensPolicyForRequest(workingRequest, args.routingTarget, args.routerEngine as any); const outboundAdapterContext = buildAdapterContextFromNormalized(args.normalized, args.routingTarget); if (args.routingTarget?.compatibilityProfile) outboundAdapterContext.compatibilityProfile = args.routingTarget.compatibilityProfile; const outboundProtocol = String(outboundAdapterContext.providerProtocol || "") as NormalizedRequest["providerProtocol"]; return { workingRequest, outboundStream, outboundAdapterContext, outboundProtocol }; }
function executeMeasuredRouteSelect(args: { normalized: NormalizedRequest; routerEngine: VirtualRouterEngine; workingRequest: StandardizedRequest | ProcessedRequest; metadataInput: Record<string, unknown>; inboundRecorder?: StageRecorder; routeSelectTiming?: { enabled?: boolean; requestId?: string }; }) { if (args.routeSelectTiming?.enabled) logHubStageTiming(args.routeSelectTiming.requestId ?? args.normalized.id, "req_process.stage2_route_select", "start"); const routing = runReqProcessStage2RouteSelect({ routerEngine: args.routerEngine, request: args.workingRequest, metadataInput: args.metadataInput as any, normalizedMetadata: args.normalized.metadata, stageRecorder: args.inboundRecorder }); if (args.routeSelectTiming?.enabled) logHubStageTiming(args.routeSelectTiming.requestId ?? args.normalized.id, "req_process.stage2_route_select", "completed"); return routing; }
function resolveRouteSelectionAndOutboundContext(args: { normalized: NormalizedRequest; routerEngine: VirtualRouterEngine; workingRequest: StandardizedRequest | ProcessedRequest; inboundRecorder?: StageRecorder; serverToolRequired: boolean; routeSelectTiming?: { enabled?: boolean; requestId?: string }; }) { const { metadataInput } = prepareRouteSelectionContext({ normalized: args.normalized, workingRequest: args.workingRequest, serverToolRequired: args.serverToolRequired }); const routing = executeMeasuredRouteSelect({ normalized: args.normalized, routerEngine: args.routerEngine, metadataInput, workingRequest: args.workingRequest, inboundRecorder: args.inboundRecorder, routeSelectTiming: args.routeSelectTiming }); const outboundContext = prepareOutboundExecutionContext({ normalized: args.normalized, routingTarget: routing.target, workingRequest: args.workingRequest, routerEngine: args.routerEngine }); return { routing, workingRequest: outboundContext.workingRequest, outboundStream: outboundContext.outboundStream, outboundAdapterContext: outboundContext.outboundAdapterContext as Record<string, unknown>, outboundProtocol: outboundContext.outboundProtocol }; }
async function buildOutboundProviderPayloadBundle<TContext = Record<string, unknown>>(args: { normalized: NormalizedRequest; hooks: RequestStageHooks<TContext>; config: HubPipelineConfig; workingRequest: StandardizedRequest | ProcessedRequest; nodeResults: HubPipelineNodeResult[]; rawRequest: JsonObject; contextSnapshot?: Record<string, unknown>; outboundProtocol: NormalizedRequest["providerProtocol"]; outboundAdapterContext: Record<string, unknown>; outboundStream: boolean; semanticMapper: ReturnType<RequestStageHooks<TContext>["createSemanticMapper"]>; effectivePolicy?: HubPolicyConfig; shadowCompareBaselineMode?: ShadowCompareBaselineMode; }) { const outboundRecorder = createHubSnapshotStageRecorder({ normalized: args.normalized, adapterContext: args.outboundAdapterContext as any, warningLabel: "Outbound snapshot recorder creation" }); const outboundStart = Date.now(); const { providerPayload, shadowBaselineProviderPayload, outboundWorkingRequest } = await buildRequestStageProviderPayload({ normalized: args.normalized, hooks: args.hooks, config: args.config, workingRequest: args.workingRequest, rawRequest: args.rawRequest, contextSnapshot: args.contextSnapshot, outboundProtocol: args.outboundProtocol, outboundAdapterContext: args.outboundAdapterContext, outboundStream: args.outboundStream, outboundRecorder, semanticMapper: args.semanticMapper, effectivePolicy: args.effectivePolicy, shadowCompareBaselineMode: args.shadowCompareBaselineMode }); const outboundEnd = Date.now(); args.nodeResults.push(buildReqOutboundNodeResultWithNative({ outboundStart, outboundEnd, messages: args.workingRequest.messages.length, tools: args.workingRequest.tools?.length ?? 0 }) as unknown as HubPipelineNodeResult); return { providerPayload, shadowBaselineProviderPayload, outboundWorkingRequest }; }

export async function executeRouteAndBuildOutbound<TContext = Record<string, unknown>>(args: { normalized: NormalizedRequest; hooks: RequestStageHooks<TContext>; routerEngine: VirtualRouterEngine; config: HubPipelineConfig; workingRequest: StandardizedRequest | ProcessedRequest; nodeResults: HubPipelineNodeResult[]; inboundRecorder?: StageRecorder; serverToolRequired: boolean; hasImageAttachment: boolean; rawRequest: JsonObject; contextSnapshot?: Record<string, unknown>; semanticMapper: ReturnType<RequestStageHooks<TContext>["createSemanticMapper"]>; effectivePolicy?: HubPolicyConfig; shadowCompareBaselineMode?: ShadowCompareBaselineMode; routeSelectTiming?: { enabled?: boolean; requestId?: string; }; }): Promise<{ providerPayload?: Record<string, unknown>; metadata: Record<string, unknown>; routingDecision?: HubPipelineResult["routingDecision"]; routingDiagnostics?: HubPipelineResult["routingDiagnostics"]; target?: HubPipelineResult["target"]; workingRequest: StandardizedRequest | ProcessedRequest; }> {
  const { normalized, hooks, routerEngine, config, nodeResults, inboundRecorder, serverToolRequired, hasImageAttachment, rawRequest, contextSnapshot, semanticMapper, effectivePolicy, shadowCompareBaselineMode, routeSelectTiming } = args; let { workingRequest } = args;
  const routeContext = resolveRouteSelectionAndOutboundContext({ normalized, routerEngine, workingRequest, serverToolRequired, inboundRecorder, routeSelectTiming }); workingRequest = routeContext.workingRequest;
  const { providerPayload, shadowBaselineProviderPayload, outboundWorkingRequest } = await buildOutboundProviderPayloadBundle({ normalized, hooks, config, workingRequest, rawRequest, contextSnapshot, outboundProtocol: routeContext.outboundProtocol, outboundAdapterContext: routeContext.outboundAdapterContext, outboundStream: routeContext.outboundStream, semanticMapper, effectivePolicy, shadowCompareBaselineMode, nodeResults });
  const capturedChatRequest = buildValidatedCapturedChatRequest({ normalized, workingRequest: outboundWorkingRequest });
  const metadata = finalizeRouteAndOutboundMetadata({ normalized, outboundProtocol: routeContext.outboundProtocol, target: routeContext.routing.target, outboundStream: routeContext.outboundStream, capturedChatRequest, shadowCompareBaselineMode, effectivePolicyMode: (effectivePolicy as any)?.mode ?? "off", shadowBaselineProviderPayload, hasImageAttachment });
  return { providerPayload, metadata, routingDecision: routeContext.routing.decision, routingDiagnostics: routeContext.routing.diagnostics, target: routeContext.routing.target, workingRequest };
}
