import type { StageRecorder } from "../format-adapters/index.js";
import type { JsonObject, JsonValue } from "../types/json.js";
import { isJsonObject } from "../types/json.js";
import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { HubPipelineConfig, HubPipelineNodeResult, NormalizedRequest } from "./hub-pipeline.js";
import type { RequestStageHooks } from "./hub-pipeline-stage-hooks.js";
import { runReqInboundStage1FormatParse } from "./stages/req_inbound/req_inbound_stage1_format_parse/index.js";
import { runReqInboundStage2SemanticMap } from "./stages/req_inbound/req_inbound_stage2_semantic_map/index.js";
import { writeCacheEntryForRequest } from "./stages/req_inbound/req_inbound_stage3_context_capture/cache-write.js";
import { runReqProcessStage1ToolGovernance } from "./stages/req_process/req_process_stage1_tool_governance/index.js";
import { isCompactionRequest } from "../../compaction-detect.js";
import {
  buildReqInboundNodeResultWithNative,
  findMappableSemanticsKeysWithNative,
  prepareRuntimeMetadataForServertoolsWithNative,
  readResponsesResumeFromMetadataWithNative,
  resolveApplyPatchToolModeFromEnvWithNative,
  resolveApplyPatchToolModeFromToolsWithNative,
  resolveHubClientProtocolWithNative,
  syncResponsesContextFromCanonicalMessagesWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { ensureRuntimeMetadata } from "../../runtime-metadata.js";
import { shouldRecordSnapshots } from "../../snapshot-utils.js";
import { recordHubPolicyObservation, type HubPolicyConfig } from "../policy/policy-engine.js";
import { measureHubStage } from "./hub-stage-timing.js";
import { buildAdapterContextFromNormalized } from "./hub-pipeline-adapter-context.js";
import { createSnapshotRecorder } from "../snapshot-recorder.js";
import {
  deriveWorkingRequestFlags,
  estimateInputTokensForWorkingRequest,
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

type ApplyPatchToolMode = "schema" | "freeform";

export interface RequestStageInboundResult<TContext = Record<string, unknown>> {
  rawRequest: JsonObject;
  semanticMapper: ReturnType<RequestStageHooks<TContext>["createSemanticMapper"]>;
  effectivePolicy: HubPolicyConfig | undefined;
  shadowCompareBaselineMode: NormalizedRequest["shadowCompare"] extends { baselineMode: infer T }
    ? T
    : never;
  inboundRecorder?: StageRecorder;
  contextSnapshot?: Record<string, unknown>;
  standardizedRequest: StandardizedRequest;
  processedRequest?: ProcessedRequest;
  workingRequest: StandardizedRequest | ProcessedRequest;
  activeProcessMode: "chat" | "passthrough";
  passthroughAudit?: Record<string, unknown>;
  nodeResults: HubPipelineNodeResult[];
  hasImageAttachment: boolean;
  serverToolRequired: boolean;
}

export async function executeRequestStageInbound<TContext = Record<string, unknown>>(args: {
  normalized: NormalizedRequest;
  hooks: RequestStageHooks<TContext>;
  config: HubPipelineConfig;
}): Promise<RequestStageInboundResult<TContext>> {
  const { normalized, hooks, config } = args;
  const semanticMapper = hooks.createSemanticMapper();
  const rawRequest = (() => {
    const payload = normalized.payload;
    if (!payload || typeof payload !== "object") {
      throw new Error("Responses pipeline requires JSON object payload");
    }
    return payload as JsonObject;
  })();

  // Detect applyPatchToolMode (runtime/tooling hint). Client tool schemas are captured as chat semantics
  // in req_inbound_stage2_semantic_map; they must not be stored in metadata.
  try {
    const toolsRaw = Array.isArray((rawRequest as any)?.tools)
      ? ((rawRequest as any).tools as unknown[])
      : null;
    const applyPatchToolMode =
      (resolveApplyPatchToolModeFromEnvWithNative() as
        | ApplyPatchToolMode
        | undefined) ??
      (resolveApplyPatchToolModeFromToolsWithNative(toolsRaw) as
        | ApplyPatchToolMode
        | undefined);
    if (applyPatchToolMode) {
      normalized.metadata = normalized.metadata || {};
      const rt = ensureRuntimeMetadata(
        normalized.metadata as Record<string, unknown>,
      );
      (rt as Record<string, unknown>).applyPatchToolMode = applyPatchToolMode;
    }
  } catch {
    // best-effort: do not block request handling due to tool scan failures
  }

  if (isCompactionRequest(rawRequest)) {
    normalized.metadata = normalized.metadata || {};
    const rt = ensureRuntimeMetadata(
      normalized.metadata as Record<string, unknown>,
    );
    (rt as Record<string, unknown>).compactionRequest = true;
  }

  const effectivePolicy = normalized.policyOverride ?? config.policy;
  const shadowCompareBaselineMode = normalized.shadowCompare?.baselineMode;
  const inboundAdapterContext = buildAdapterContextFromNormalized(normalized);
  const inboundRecorder = (() => {
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
      inboundAdapterContext.entryEndpoint ||
      "/v1/chat/completions";
    try {
      return createSnapshotRecorder(inboundAdapterContext, effectiveEndpoint);
    } catch {
      return undefined;
    }
  })();
  const inboundStart = Date.now();

  // Phase 0: observe client inbound payload violations (best-effort; no rewrites).
  recordHubPolicyObservation({
    policy: effectivePolicy,
    providerProtocol: (() => {
      const protocol = resolveHubClientProtocolWithNative(
        normalized.entryEndpoint,
      );
      return protocol === "openai-responses" ||
        protocol === "anthropic-messages" ||
        protocol === "openai-chat"
        ? protocol
        : "openai-chat";
    })(),
    payload: rawRequest,
    phase: "client_inbound",
    stageRecorder: inboundRecorder,
    requestId: normalized.id,
  });

  const formatEnvelope = await measureHubStage(
    normalized.id,
    "req_inbound.stage1_format_parse",
    () =>
      runReqInboundStage1FormatParse({
        rawRequest,
        adapterContext: inboundAdapterContext,
        stageRecorder: inboundRecorder,
      }),
  );

  const responsesResumeFromMetadataRaw =
    readResponsesResumeFromMetadataWithNative(
      normalized.metadata as Record<string, unknown> | undefined,
    );
  const responsesResumeFromMetadata =
    responsesResumeFromMetadataRaw &&
    isJsonObject(responsesResumeFromMetadataRaw as JsonValue)
      ? (responsesResumeFromMetadataRaw as JsonObject)
      : undefined;

  const inboundStage2 = await measureHubStage(
    normalized.id,
    "req_inbound.stage2_semantic_map",
    () =>
      runReqInboundStage2SemanticMap({
        adapterContext: inboundAdapterContext,
        formatEnvelope,
        semanticMapper,
        ...(responsesResumeFromMetadata
          ? { responsesResume: responsesResumeFromMetadata }
          : {}),
        stageRecorder: inboundRecorder,
      }),
  );

  // responsesResume must not enter chat_process as metadata; it is lifted into chat.semantics in stage2.
  if (
    responsesResumeFromMetadata &&
    normalized.metadata &&
    Object.prototype.hasOwnProperty.call(
      normalized.metadata,
      "responsesResume",
    )
  ) {
    delete (normalized.metadata as Record<string, unknown>).responsesResume;
  }

  const contextSnapshot = await measureHubStage(
    normalized.id,
    "req_inbound.stage3_context_capture",
    () => {
      if (inboundStage2.responsesContext) {
        // responses 语义上下文已在 stage2 捕获，但请求侧 CACHE.md 仍需写入
        // 仅做请求写入，不重复 captureContext 逻辑
        writeCacheEntryForRequest({
          rawRequest,
          adapterContext: inboundAdapterContext,
        });
        return inboundStage2.responsesContext as Record<string, unknown>;
      }
      return hooks.captureContext({
        rawRequest,
        adapterContext: inboundAdapterContext,
        stageRecorder: inboundRecorder,
      });
    },
  );

  let standardizedRequest: StandardizedRequest =
    sanitizeStandardizedRequestMessages(inboundStage2.standardizedRequest);

  propagateApplyPatchToolModeToRequestMetadata(
    normalized.metadata as Record<string, unknown> | undefined,
    standardizedRequest,
  );

  const { activeProcessMode, passthroughAudit } =
    resolveActiveProcessModeAndAudit({
      normalized,
      requestMessages: standardizedRequest.messages,
      rawPayload: rawRequest,
    });

  const inboundEnd = Date.now();

  const nodeResults: HubPipelineNodeResult[] = [];
  nodeResults.push(
    buildReqInboundNodeResultWithNative({
      inboundStart,
      inboundEnd,
      messages: standardizedRequest.messages.length,
      tools: standardizedRequest.tools?.length ?? 0,
    }) as unknown as HubPipelineNodeResult,
  );

  // 将 VirtualRouter 层的 servertool 相关配置注入到 metadata，保证响应侧
  // servertool（第三跳 reenter）也能访问到相同配置，即使当前 route 标记为 passthrough。
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
    const processResult = await measureHubStage(
      normalized.id,
      "req_process.stage1_tool_governance",
      () =>
        runReqProcessStage1ToolGovernance({
          request: standardizedRequest,
          rawPayload: rawRequest,
          metadata: metaBase,
          entryEndpoint: normalized.entryEndpoint,
          requestId: normalized.id,
          stageRecorder: inboundRecorder,
        }),
    );
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

  // 使用与 VirtualRouter 一致的 tiktoken 计数逻辑，对标准化请求进行一次
  // 上下文 token 估算，供后续 usage 归一化与统计使用。
  estimateInputTokensForWorkingRequest({
    workingRequest,
    normalizedMetadata:
      (normalized.metadata as Record<string, unknown> | undefined) ??
      ((normalized.metadata = {}) as Record<string, unknown>),
  });

  // request continuation/state must be consumed from chat.semantics once entering chat_process.
  const { hasImageAttachment, serverToolRequired } =
    deriveWorkingRequestFlags(workingRequest);

  return {
    rawRequest,
    semanticMapper,
    effectivePolicy,
    shadowCompareBaselineMode,
    inboundRecorder,
    contextSnapshot: contextSnapshot as Record<string, unknown> | undefined,
    standardizedRequest,
    processedRequest,
    workingRequest,
    activeProcessMode,
    passthroughAudit,
    nodeResults,
    hasImageAttachment,
    serverToolRequired,
  };
}
