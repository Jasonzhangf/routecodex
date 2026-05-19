import type { JsonObject } from "../types/json.js";
import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";
import type { HubPipelineConfig, HubPipelineNodeResult, HubPipelineResult, NormalizedRequest } from "./hub-pipeline.js";
import { executeRouteAndBuildOutbound } from "./hub-pipeline-route-and-outbound.js";
import {
  applyChatProcessSemanticGate,
  assertNoMappableSemanticsInMetadata,
  createChatProcessSnapshotRecorder,
  prepareChatProcessRuntimeMetadata,
} from "./hub-pipeline-chat-process-entry-blocks.js";
import { buildAdapterContextFromNormalized } from './hub-pipeline-adapter-context.js';
import {
  propagateApplyPatchToolModeToRequestMetadata,
  resolveActiveProcessModeAndAudit,
  sanitizeStandardizedRequestMessages,
} from './hub-pipeline-chat-process-request-utils.js';
import { executeToolGovernanceOrPassthrough, attachHubStageTopSummary } from './hub-pipeline-governance-blocks.js';
import {
  buildReqInboundSkippedNodeWithNative,
  coerceStandardizedRequestFromPayloadWithNative as __nativeNormalizeStdReq,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { finalizeWorkingRequestForOutbound } from "./hub-pipeline-working-request-blocks.js";
import { requireJsonObjectPayload, requireRequestStageHooks } from "./hub-pipeline-shared-guards.js";


function createChatProcessEntryNodeResults(): HubPipelineNodeResult[] {
  return [
    buildReqInboundSkippedNodeWithNative({ reason: "stage=outbound" }) as unknown as HubPipelineNodeResult,
  ];
}

function prepareChatProcessEntryExecutionContext(args: {
  normalized: NormalizedRequest;
  config: HubPipelineConfig;
  standardizedRequestBase: StandardizedRequest;
  rawPayload: Record<string, unknown>;
}): {
  metaBase: Record<string, unknown>;
  standardizedRequest: StandardizedRequest;
  activeProcessMode: "chat" | "passthrough";
  passthroughAudit?: Record<string, unknown>;
  stageRecorder: ReturnType<typeof createChatProcessSnapshotRecorder>;
} {
  const metaBase = prepareChatProcessRuntimeMetadata({ normalized: args.normalized, config: args.config });
  let standardizedRequest: StandardizedRequest = args.standardizedRequestBase;
  const { activeProcessMode, passthroughAudit } = resolveActiveProcessModeAndAudit({
    normalized: args.normalized,
    requestMessages: standardizedRequest.messages,
    rawPayload: args.rawPayload,
  });
  standardizedRequest = sanitizeStandardizedRequestMessages(standardizedRequest);
  standardizedRequest = applyChatProcessSemanticGate({ request: standardizedRequest, metadata: metaBase, requestId: args.normalized.id }) as unknown as StandardizedRequest;
  propagateApplyPatchToolModeToRequestMetadata(metaBase, standardizedRequest);
  const adapterContext = buildAdapterContextFromNormalized(args.normalized);
  const stageRecorder = createChatProcessSnapshotRecorder({ normalized: args.normalized, adapterContext, warningLabel: "Snapshot recorder creation" });
  return { metaBase, standardizedRequest, activeProcessMode, passthroughAudit, stageRecorder };
}

async function executeChatProcessGovernancePhase(args: {
  normalized: NormalizedRequest;
  standardizedRequest: StandardizedRequest;
  rawPayload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  stageRecorder: unknown;
  activeProcessMode: "chat" | "passthrough";
  passthroughAudit?: Record<string, unknown>;
  nodeResults: HubPipelineNodeResult[];
}): Promise<ProcessedRequest | undefined> {
  return executeToolGovernanceOrPassthrough({
    requestId: args.normalized.id,
    entryEndpoint: args.normalized.entryEndpoint,
    standardizedRequest: args.standardizedRequest,
    rawPayload: args.rawPayload,
    metadata: args.metadata,
    stageRecorder: args.stageRecorder as any,
    activeProcessMode: args.activeProcessMode,
    passthroughAudit: args.passthroughAudit,
    nodeResults: args.nodeResults,
  });
}

function buildChatProcessEntryPipelineResult(args: {
  normalized: NormalizedRequest;
  standardizedRequest: StandardizedRequest;
  processedRequest?: ProcessedRequest;
  outbound: {
    providerPayload?: Record<string, unknown>;
    routingDecision?: HubPipelineResult["routingDecision"];
    routingDiagnostics?: HubPipelineResult["routingDiagnostics"];
    target?: HubPipelineResult["target"];
    metadata: Record<string, unknown>;
  };
  nodeResults: HubPipelineNodeResult[];
}): HubPipelineResult {
  attachHubStageTopSummary({ requestId: args.normalized.id, metadata: args.outbound.metadata });
  return {
    requestId: args.normalized.id,
    providerPayload: args.outbound.providerPayload,
    standardizedRequest: args.standardizedRequest,
    processedRequest: args.processedRequest,
    routingDecision: args.outbound.routingDecision,
    routingDiagnostics: args.outbound.routingDiagnostics,
    target: args.outbound.target,
    metadata: args.outbound.metadata,
    nodeResults: args.nodeResults,
  };
}

function resolveChatProcessEffectivePolicy(normalized: NormalizedRequest, config: HubPipelineConfig): HubPipelineConfig["policy"] | undefined {
  return normalized.policyOverride ?? config.policy;
}

function normalizeChatProcessEntryPayload(normalized: NormalizedRequest): {
  rawPayloadInput: JsonObject;
  rawPayload: Record<string, unknown>;
  standardizedRequestBase: StandardizedRequest;
} {
  const rawPayloadInput = requireJsonObjectPayload(normalized);
  const nativeNormalized = __nativeNormalizeStdReq({
    payload: rawPayloadInput as Record<string, unknown>,
    normalized: {
      id: normalized.id,
      entryEndpoint: normalized.entryEndpoint,
      stream: normalized.stream,
      processMode: normalized.processMode,
      routeHint: normalized.routeHint,
    },
  });
  return {
    rawPayloadInput,
    rawPayload: nativeNormalized.rawPayload,
    standardizedRequestBase:
      nativeNormalized.standardizedRequest as unknown as StandardizedRequest,
  };
}

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
  } = normalizeChatProcessEntryPayload(normalized);
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
