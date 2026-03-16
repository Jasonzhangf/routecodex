import { Readable } from "node:stream";
import type {
  StandardizedMessage,
  StandardizedRequest,
  ProcessedRequest,
} from "../types/standardized.js";
import type { JsonObject, JsonValue } from "../types/json.js";
import { isJsonObject, jsonClone } from "../types/json.js";
import { convertMessagesToBridgeInput } from "../../bridge-message-utils.js";
import type { AdapterContext, ChatEnvelope } from "../types/chat-envelope.js";
import type { FormatEnvelope } from "../types/format-envelope.js";
import type {
  StageRecorder,
  FormatAdapter,
  SemanticMapper,
} from "../format-adapters/index.js";
import { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";
import { providerErrorCenter } from "../../../router/virtual-router/error-center.js";
import { providerSuccessCenter } from "../../../router/virtual-router/success-center.js";
import {
  defaultSseCodecRegistry,
  type SseProtocol,
} from "../../../sse/index.js";
import type {
  VirtualRouterConfig,
  RouterMetadataInput,
  RoutingDecision,
  RoutingDiagnostics,
  TargetMetadata,
  VirtualRouterHealthStore,
  ProviderQuotaView,
} from "../../../router/virtual-router/types.js";
import {
  runHubChatProcess,
  type HubProcessNodeResult,
} from "../process/chat-process.js";
import { ResponsesFormatAdapter } from "../format-adapters/responses-format-adapter.js";
import { ResponsesSemanticMapper } from "../semantic-mappers/responses-mapper.js";
import { AnthropicFormatAdapter } from "../format-adapters/anthropic-format-adapter.js";
import { AnthropicSemanticMapper } from "../semantic-mappers/anthropic-mapper.js";
import { GeminiFormatAdapter } from "../format-adapters/gemini-format-adapter.js";
import { GeminiSemanticMapper } from "../semantic-mappers/gemini-mapper.js";
import { ChatFormatAdapter } from "../format-adapters/chat-format-adapter.js";
import { ChatSemanticMapper } from "../semantic-mappers/chat-mapper.js";
import { createSnapshotRecorder } from "../snapshot-recorder.js";
import { shouldRecordSnapshots } from "../../snapshot-utils.js";
import { runReqInboundStage1FormatParse } from "./stages/req_inbound/req_inbound_stage1_format_parse/index.js";
import { runReqInboundStage2SemanticMap } from "./stages/req_inbound/req_inbound_stage2_semantic_map/index.js";
import {
  runChatContextCapture,
  captureResponsesContextSnapshot,
} from "./stages/req_inbound/req_inbound_stage3_context_capture/index.js";
import { writeCacheEntryForRequest } from "./stages/req_inbound/req_inbound_stage3_context_capture/cache-write.js";
import { normalizeReqInboundToolCallIdStyleWithNative } from "../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js";
import {
  createResponsesContextCapture,
  createNoopContextCapture,
  type ContextCaptureFn,
} from "./stages/req_inbound/req_inbound_stage3_context_capture/context-factories.js";
import { runReqProcessStage1ToolGovernance } from "./stages/req_process/req_process_stage1_tool_governance/index.js";
import { runReqProcessStage2RouteSelect } from "./stages/req_process/req_process_stage2_route_select/index.js";
import { runReqOutboundStage1SemanticMap } from "./stages/req_outbound/req_outbound_stage1_semantic_map/index.js";
import { runReqOutboundStage2FormatBuild } from "./stages/req_outbound/req_outbound_stage2_format_build/index.js";
import { runReqOutboundStage3Compat } from "./stages/req_outbound/req_outbound_stage3_compat/index.js";
import { applyTargetMetadata, applyTargetToSubject } from "./target-utils.js";
import { extractSessionIdentifiersFromMetadata } from "./session-identifiers.js";
import { computeRequestTokens } from "../../../router/virtual-router/token-estimator.js";
import { estimateSessionBoundTokens } from "../process/chat-process-session-usage.js";
import {
  annotatePassthroughGovernanceSkipWithNative,
  attachPassthroughProviderInputAuditWithNative,
  buildPassthroughAuditWithNative,
  applyOutboundStreamPreferenceWithNative,
  normalizeHubEndpointWithNative,
  extractAdapterContextMetadataFieldsWithNative,
  resolveApplyPatchToolModeFromToolsWithNative,
  resolveHubClientProtocolWithNative,
  resolveHubPolicyOverrideFromMetadataWithNative,
  resolveHubProviderProtocolWithNative,
  resolveOutboundStreamIntentWithNative,
  resolveHubShadowCompareConfigWithNative,
  resolveActiveProcessModeWithNative,
  findMappableSemanticsKeysWithNative,
  resolveHubSseProtocolFromMetadataWithNative,
  resolveStopMessageRouterMetadataWithNative,
  runHubPipelineOrchestrationWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import {
  normalizeAliasMapWithNative,
  resolveAliasMapFromRespSemanticsWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js";
import { isCompactionRequest } from "../../compaction-detect.js";
import {
  applyHubProviderOutboundPolicy,
  recordHubPolicyObservation,
  setHubPolicyRuntimePolicy,
  type HubPolicyConfig,
  type HubPolicyMode,
} from "../policy/policy-engine.js";
import {
  applyProviderOutboundToolSurface,
  type HubToolSurfaceConfig,
} from "../tool-surface/tool-surface-engine.js";
import {
  cloneRuntimeMetadata,
  ensureRuntimeMetadata,
  readRuntimeMetadata,
} from "../../runtime-metadata.js";
import {
  containsImageAttachment,
  stripHistoricalImageAttachments,
  stripHistoricalVisualToolOutputs,
  repairIncompleteToolCalls,
} from "../process/chat-process-media.js";
import {
  measureHubStage,
  logHubStageTiming,
  clearHubStageTiming,
} from "./hub-stage-timing.js";

type ApplyPatchToolMode = "schema" | "freeform";

function isTruthyEnv(value: unknown): boolean {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function resolveApplyPatchToolModeFromEnv(): ApplyPatchToolMode | undefined {
  const rawMode = String(
    process.env.RCC_APPLY_PATCH_TOOL_MODE ||
      process.env.ROUTECODEX_APPLY_PATCH_TOOL_MODE ||
      "",
  )
    .trim()
    .toLowerCase();
  if (rawMode === "freeform") return "freeform";
  if (rawMode === "schema" || rawMode === "json_schema") return "schema";
  const freeformFlag =
    process.env.RCC_APPLY_PATCH_FREEFORM ||
    process.env.ROUTECODEX_APPLY_PATCH_FREEFORM;
  if (isTruthyEnv(freeformFlag)) return "freeform";
  return undefined;
}

function applyChatProcessEntryMediaCleanup(
  request: StandardizedRequest,
): StandardizedRequest {
  return {
    ...request,
    messages: repairIncompleteToolCalls(
      stripHistoricalVisualToolOutputs(
        stripHistoricalImageAttachments(request.messages),
      ),
    ),
  };
}

function readResponsesResumeFromMetadata(
  metadata: Record<string, unknown> | undefined,
): JsonObject | undefined {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const resume = (metadata as Record<string, unknown>).responsesResume;
  return resume && isJsonObject(resume as JsonValue)
    ? (resume as JsonObject)
    : undefined;
}

function readResponsesResumeFromRequestSemantics(
  request: StandardizedRequest | ProcessedRequest,
): Record<string, unknown> | undefined {
  try {
    const semantics = (request as any)?.semantics;
    const responses =
      semantics &&
      typeof semantics === "object" &&
      !Array.isArray(semantics) &&
      (semantics as Record<string, unknown>).responses &&
      typeof (semantics as Record<string, unknown>).responses === "object" &&
      !Array.isArray((semantics as Record<string, unknown>).responses)
        ? ((semantics as Record<string, unknown>).responses as Record<
            string,
            unknown
          >)
        : undefined;
    const resume =
      responses &&
      responses.resume &&
      typeof responses.resume === "object" &&
      !Array.isArray(responses.resume)
        ? (responses.resume as Record<string, unknown>)
        : undefined;
    return resume;
  } catch {
    return undefined;
  }
}

function liftResponsesResumeIntoSemantics<
  T extends StandardizedRequest | ProcessedRequest,
>(request: T, metadata: Record<string, unknown>): T {
  const resumeMeta = readResponsesResumeFromMetadata(metadata);
  if (!resumeMeta) {
    return request;
  }

  const next = {
    ...request,
    semantics: {
      ...(((request as any).semantics as Record<string, unknown> | undefined) ??
        {}),
    },
  } as T;
  const semantics = (next as any).semantics as Record<string, unknown>;
  if (
    !semantics.responses ||
    typeof semantics.responses !== "object" ||
    Array.isArray(semantics.responses)
  ) {
    semantics.responses = {};
  }
  const responsesNode = semantics.responses as Record<string, unknown>;
  if (responsesNode.resume === undefined) {
    responsesNode.resume = jsonClone(resumeMeta as any);
  }
  delete metadata.responsesResume;
  return next;
}

function syncResponsesContextFromCanonicalMessages<
  T extends StandardizedRequest | ProcessedRequest,
>(request: T): T {
  const semantics = (request as any)?.semantics;
  const responsesNode =
    semantics &&
    typeof semantics === "object" &&
    !Array.isArray(semantics) &&
    semantics.responses &&
    typeof semantics.responses === "object" &&
    !Array.isArray(semantics.responses)
      ? (semantics.responses as Record<string, unknown>)
      : undefined;
  const contextNode =
    responsesNode &&
    responsesNode.context &&
    typeof responsesNode.context === "object" &&
    !Array.isArray(responsesNode.context)
      ? (responsesNode.context as Record<string, unknown>)
      : undefined;
  if (!contextNode) {
    return request;
  }

  const bridge = convertMessagesToBridgeInput({
    messages:
      (request.messages as unknown as Array<Record<string, unknown>>) ?? [],
    tools: Array.isArray((request as any).tools)
      ? ((request as any).tools as Array<Record<string, unknown>>)
      : undefined,
  });

  return {
    ...request,
    semantics: {
      ...(semantics as Record<string, unknown>),
      responses: {
        ...responsesNode,
        context: {
          ...contextNode,
          input: jsonClone(bridge.input as any),
          originalSystemMessages: jsonClone(
            bridge.originalSystemMessages as any,
          ),
        },
      },
    },
  } as T;
}

function resolveApplyPatchToolModeFromTools(
  toolsRaw: unknown,
): ApplyPatchToolMode | undefined {
  return resolveApplyPatchToolModeFromToolsWithNative(toolsRaw) as
    | ApplyPatchToolMode
    | undefined;
}

function extractHubPolicyOverride(
  metadata: Record<string, unknown> | undefined,
): HubPolicyConfig | undefined {
  const parsed = resolveHubPolicyOverrideFromMetadataWithNative(metadata);
  if (!parsed) {
    return undefined;
  }
  return {
    mode: parsed.mode,
    ...(parsed.sampleRate !== undefined
      ? { sampleRate: parsed.sampleRate }
      : {}),
  };
}

function propagateAdapterContextMetadataFields(
  adapterContext: AdapterContext,
  metadata: Record<string, unknown>,
  keys: string[],
): void {
  const picked = extractAdapterContextMetadataFieldsWithNative(metadata, keys);
  Object.assign(adapterContext as Record<string, unknown>, picked);
}

function resolveStopMessageRouterMetadata(
  metadata: Record<string, unknown> | undefined,
): Pick<
  RouterMetadataInput,
  | "stopMessageClientInjectSessionScope"
  | "stopMessageClientInjectScope"
  | "clientTmuxSessionId"
  | "client_tmux_session_id"
  | "tmuxSessionId"
  | "tmux_session_id"
> {
  return resolveStopMessageRouterMetadataWithNative(metadata);
}

function isSearchRouteId(routeId: unknown): boolean {
  const normalized =
    typeof routeId === "string" ? routeId.trim().toLowerCase() : "";
  return normalized.startsWith("web_search") || normalized.startsWith("search");
}

function isCanonicalWebSearchToolDefinition(tool: unknown): boolean {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    return false;
  }
  const row = tool as Record<string, unknown>;
  const rawType =
    typeof row.type === "string" ? row.type.trim().toLowerCase() : "";
  if (rawType === "web_search_20250305" || rawType === "web_search") {
    return true;
  }
  const fnNode =
    row.function &&
    typeof row.function === "object" &&
    !Array.isArray(row.function)
      ? (row.function as Record<string, unknown>)
      : undefined;
  const name =
    typeof fnNode?.name === "string"
      ? fnNode.name.trim().toLowerCase()
      : typeof row.name === "string"
        ? row.name.trim().toLowerCase()
        : "";
  return name === "web_search" || name === "websearch" || name === "web-search";
}

function maybeApplyDirectBuiltinWebSearchTool(
  providerPayload: Record<string, unknown>,
  adapterContext: AdapterContext,
  providerProtocol: string,
): Record<string, unknown> {
  if (providerProtocol !== "anthropic-messages") {
    return providerPayload;
  }
  if (!isSearchRouteId(adapterContext.routeId)) {
    return providerPayload;
  }
  const modelId =
    typeof providerPayload.model === "string"
      ? providerPayload.model.trim()
      : "";
  if (!modelId) {
    return providerPayload;
  }
  const rt = readRuntimeMetadata(
    adapterContext as unknown as Record<string, unknown>,
  ) as Record<string, unknown> | undefined;
  const webSearch =
    rt &&
    typeof rt.webSearch === "object" &&
    rt.webSearch &&
    !Array.isArray(rt.webSearch)
      ? (rt.webSearch as Record<string, unknown>)
      : undefined;
  const enginesRaw = Array.isArray(webSearch?.engines)
    ? (webSearch?.engines as unknown[])
    : [];
  const matchedEngine = enginesRaw.find((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const row = entry as Record<string, unknown>;
    const executionMode =
      typeof row.executionMode === "string"
        ? row.executionMode.trim().toLowerCase()
        : "";
    if (executionMode !== "direct") {
      return false;
    }
    const directActivation =
      typeof row.directActivation === "string"
        ? row.directActivation.trim().toLowerCase()
        : "route";
    if (directActivation !== "builtin") {
      return false;
    }
    const configuredModelId =
      typeof row.modelId === "string" ? row.modelId.trim() : "";
    if (configuredModelId && configuredModelId === modelId) {
      return true;
    }
    const providerKey =
      typeof row.providerKey === "string" ? row.providerKey.trim() : "";
    return providerKey.endsWith(`.${modelId}`);
  }) as Record<string, unknown> | undefined;
  if (!matchedEngine) {
    return providerPayload;
  }

  const rawMaxUses =
    typeof matchedEngine.maxUses === "number"
      ? matchedEngine.maxUses
      : Number(matchedEngine.maxUses);
  const maxUses =
    Number.isFinite(rawMaxUses) && rawMaxUses > 0 ? Math.floor(rawMaxUses) : 2;
  const builtinTool: Record<string, unknown> = {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: maxUses,
  };

  const tools = Array.isArray(providerPayload.tools)
    ? providerPayload.tools
    : [];
  let replaced = false;
  const nextTools: unknown[] = [];
  for (const tool of tools) {
    if (!replaced && isCanonicalWebSearchToolDefinition(tool)) {
      nextTools.push(builtinTool);
      replaced = true;
      continue;
    }
    if (isCanonicalWebSearchToolDefinition(tool)) {
      continue;
    }
    nextTools.push(tool);
  }
  if (!replaced) {
    nextTools.unshift(builtinTool);
  }
  providerPayload.tools = nextTools;
  return providerPayload;
}

type HubShadowCompareRequestConfig = {
  baselineMode: HubPolicyMode;
};

function extractHubShadowCompareConfig(
  metadata: Record<string, unknown> | undefined,
): HubShadowCompareRequestConfig | undefined {
  const parsed = resolveHubShadowCompareConfigWithNative(metadata);
  if (!parsed) {
    return undefined;
  }
  return { baselineMode: parsed.baselineMode as HubPolicyMode };
}

export interface HubPipelineConfig {
  virtualRouter: VirtualRouterConfig;
  /**
   * Optional: hub-level policy controls (observe-only in V1 Phase 0).
   * Must remain config-driven and default to off.
   */
  policy?: HubPolicyConfig;
  /**
   * Optional: tool surface rollout controls.
   * - shadow: compute & record diffs, do not modify outbound payload
   * - enforce: rewrite outbound payload to match canonical tool surface
   */
  toolSurface?: HubToolSurfaceConfig;
  /**
   * 可选：供 VirtualRouterEngine 使用的健康状态持久化存储。
   * 当提供时，VirtualRouterEngine 将在初始化时恢复上一次快照，并在 cooldown/熔断变化时调用 persistSnapshot。
   */
  healthStore?: VirtualRouterHealthStore;
  /**
   * 可选：路由状态存储，用于持久化 sticky routing / stopMessage 等指令状态。
   */
  routingStateStore?: {
    loadSync(key: string): unknown;
    saveAsync(key: string, state: unknown): void;
  };
  /**
   * 可选：配额视图。若提供，VirtualRouterEngine 将在路由过程中参考
   * provider 的 quota 状态（inPool/priorityTier/cooldownUntil/blacklistUntil）
   * 过滤目标并按优先级分层调度。
   */
  quotaView?: ProviderQuotaView;
}

export interface HubPipelineRequestMetadata extends Record<string, unknown> {
  entryEndpoint?: string;
  providerProtocol?: string;
  processMode?: "chat" | "passthrough";
  stage?: "inbound" | "outbound";
  direction?: "request" | "response";
  stream?: boolean;
  routeHint?: string;
}

export interface HubPipelineRequest {
  id?: string;
  endpoint: string;
  payload: Record<string, unknown> | { readable?: Readable } | Readable;
  metadata?: HubPipelineRequestMetadata;
}

type HubPipelineNodeMetadata =
  | HubProcessNodeResult["metadata"]
  | Record<string, unknown>;

export interface HubPipelineNodeResult {
  id: string;
  success: boolean;
  metadata: HubPipelineNodeMetadata;
  error?: JsonObject;
}

export interface HubPipelineResult {
  requestId: string;
  providerPayload?: Record<string, unknown>;
  standardizedRequest?: StandardizedRequest;
  processedRequest?: ProcessedRequest;
  routingDecision?: RoutingDecision;
  routingDiagnostics?: RoutingDiagnostics;
  target?: TargetMetadata;
  metadata: Record<string, unknown>;
  nodeResults: HubPipelineNodeResult[];
}

type ProviderProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "gemini-chat";

interface NormalizedRequest {
  id: string;
  endpoint: string;
  entryEndpoint: string;
  providerProtocol: ProviderProtocol;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  policyOverride?: HubPolicyConfig;
  shadowCompare?: HubShadowCompareRequestConfig;
  disableSnapshots?: boolean;
  processMode: "chat" | "passthrough";
  direction: "request" | "response";
  stage: "inbound" | "outbound";
  stream: boolean;
  routeHint?: string;
  hubEntryMode?: "chat_process";
}

interface RequestContextCaptureOptions {
  rawRequest: JsonObject;
  adapterContext: AdapterContext;
  stageRecorder?: StageRecorder;
}

interface RequestStageHooks<TContext = Record<string, unknown>> {
  createFormatAdapter: () => FormatAdapter;
  createSemanticMapper: () => SemanticMapper;
  captureContext: ContextCaptureFn;
  contextMetadataKey?: string;
}

function buildPassthroughAudit(
  rawInbound: Record<string, unknown>,
  providerProtocol: ProviderProtocol,
): Record<string, unknown> {
  return buildPassthroughAuditWithNative(rawInbound, providerProtocol);
}

function annotatePassthroughGovernanceSkip(
  audit: Record<string, unknown>,
): void {
  const next = annotatePassthroughGovernanceSkipWithNative(audit);
  for (const key of Object.keys(audit)) {
    delete (audit as Record<string, unknown>)[key];
  }
  Object.assign(audit, next);
}

function attachPassthroughProviderInputAudit(
  audit: Record<string, unknown>,
  providerPayload: Record<string, unknown>,
  providerProtocol: ProviderProtocol,
): void {
  const next = attachPassthroughProviderInputAuditWithNative(
    audit,
    providerPayload,
    providerProtocol,
  );
  for (const key of Object.keys(audit)) {
    delete (audit as Record<string, unknown>)[key];
  }
  Object.assign(audit, next);
}

function resolveActiveProcessMode(
  baseMode: "chat" | "passthrough",
  messages: StandardizedMessage[] | undefined,
): "chat" | "passthrough" {
  return resolveActiveProcessModeWithNative(baseMode, messages);
}

export class HubPipeline {
  private readonly routerEngine: VirtualRouterEngine;
  private config: HubPipelineConfig;
  private unsubscribeProviderErrors?: () => void;
  private unsubscribeProviderSuccess?: () => void;

  constructor(config: HubPipelineConfig) {
    this.config = config;
    this.routerEngine = new VirtualRouterEngine({
      healthStore: config.healthStore,
      routingStateStore: config.routingStateStore as any,
      quotaView: config.quotaView,
    });
    this.routerEngine.initialize(config.virtualRouter);
    setHubPolicyRuntimePolicy(config.policy);
    try {
      this.unsubscribeProviderErrors = providerErrorCenter.subscribe(
        (event) => {
          try {
            this.routerEngine.handleProviderError(event);
          } catch {
            // ignore subscriber errors
          }
        },
      );
    } catch {
      this.unsubscribeProviderErrors = undefined;
    }
    try {
      this.unsubscribeProviderSuccess = providerSuccessCenter.subscribe(
        (event) => {
          try {
            this.routerEngine.handleProviderSuccess(event);
          } catch {
            // ignore subscriber errors
          }
        },
      );
    } catch {
      this.unsubscribeProviderSuccess = undefined;
    }
  }

  updateRuntimeDeps(deps: {
    healthStore?: HubPipelineConfig["healthStore"] | null;
    routingStateStore?: HubPipelineConfig["routingStateStore"] | null;
    quotaView?: HubPipelineConfig["quotaView"] | null;
  }): void {
    if (!deps || typeof deps !== "object") {
      return;
    }
    if ("healthStore" in deps) {
      this.config.healthStore = deps.healthStore ?? undefined;
    }
    if ("routingStateStore" in deps) {
      this.config.routingStateStore = (deps.routingStateStore ??
        undefined) as any;
    }
    if ("quotaView" in deps) {
      this.config.quotaView = deps.quotaView ?? undefined;
    }
    try {
      this.routerEngine.updateDeps({
        healthStore: this.config.healthStore ?? null,
        routingStateStore: (this.config.routingStateStore ?? null) as any,
        quotaView: this.config.quotaView ?? null,
      });
    } catch {
      // best-effort: runtime deps updates must never break routing
    }
  }

  updateVirtualRouterConfig(nextConfig: VirtualRouterConfig): void {
    if (!nextConfig || typeof nextConfig !== "object") {
      throw new Error(
        "HubPipeline updateVirtualRouterConfig requires VirtualRouterConfig payload",
      );
    }
    this.config.virtualRouter = nextConfig;
    this.routerEngine.initialize(nextConfig);
  }

  dispose(): void {
    if (this.unsubscribeProviderErrors) {
      try {
        this.unsubscribeProviderErrors();
      } catch {
        // ignore dispose failures
      }
      this.unsubscribeProviderErrors = undefined;
    }
    if (this.unsubscribeProviderSuccess) {
      try {
        this.unsubscribeProviderSuccess();
      } catch {
        // ignore dispose failures
      }
      this.unsubscribeProviderSuccess = undefined;
    }
  }

  private async executeRequestStagePipeline<TContext = Record<string, unknown>>(
    normalized: NormalizedRequest,
    hooks: RequestStageHooks<TContext>,
  ): Promise<HubPipelineResult> {
    const semanticMapper = hooks.createSemanticMapper();
    const rawRequest = this.asJsonObject(normalized.payload);
    // Detect applyPatchToolMode (runtime/tooling hint). Client tool schemas are captured as chat semantics
    // in req_inbound_stage2_semantic_map; they must not be stored in metadata.
    try {
      const toolsRaw = Array.isArray((rawRequest as any)?.tools)
        ? ((rawRequest as any).tools as unknown[])
        : null;
      const applyPatchToolMode =
        resolveApplyPatchToolModeFromEnv() ??
        resolveApplyPatchToolModeFromTools(toolsRaw);
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
    const effectivePolicy = normalized.policyOverride ?? this.config.policy;
    const shadowCompareBaselineMode = normalized.shadowCompare?.baselineMode;
    const inboundAdapterContext = this.buildAdapterContext(normalized);
    const inboundRecorder = this.maybeCreateStageRecorder(
      inboundAdapterContext,
      normalized.entryEndpoint,
      {
        disableSnapshots: normalized.disableSnapshots === true,
      },
    );
    const inboundStart = Date.now();

    // Phase 0: observe client inbound payload violations (best-effort; no rewrites).
    recordHubPolicyObservation({
      policy: effectivePolicy,
      providerProtocol: this.resolveClientProtocol(normalized.entryEndpoint),
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
    const responsesResumeFromMetadata = readResponsesResumeFromMetadata(
      normalized.metadata as Record<string, unknown> | undefined,
    );
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
    let standardizedRequest = applyChatProcessEntryMediaCleanup(
      inboundStage2.standardizedRequest,
    );

    try {
      const rt = readRuntimeMetadata(
        normalized.metadata as Record<string, unknown>,
      );
      const mode = String((rt as any)?.applyPatchToolMode || "")
        .trim()
        .toLowerCase();
      if (mode === "freeform" || mode === "schema") {
        (
          standardizedRequest.metadata as Record<string, unknown>
        ).applyPatchToolMode = mode;
      }
    } catch {
      // best-effort: do not block request handling due to metadata propagation failures
    }

    const activeProcessMode = resolveActiveProcessMode(
      normalized.processMode,
      standardizedRequest.messages,
    );
    if (activeProcessMode !== normalized.processMode) {
      normalized.processMode = activeProcessMode;
    }
    const passthroughAudit =
      activeProcessMode === "passthrough"
        ? buildPassthroughAudit(rawRequest, normalized.providerProtocol)
        : undefined;

    const inboundEnd = Date.now();

    const nodeResults: HubPipelineNodeResult[] = [];
    nodeResults.push({
      id: "req_inbound",
      success: true,
      metadata: {
        node: "req_inbound",
        executionTime: inboundEnd - inboundStart,
        startTime: inboundStart,
        endTime: inboundEnd,
        dataProcessed: {
          messages: standardizedRequest.messages.length,
          tools: standardizedRequest.tools?.length ?? 0,
        },
      },
    });

    // 将 VirtualRouter 层的 servertool 相关配置注入到 metadata，保证响应侧
    // servertool（第三跳 reenter）也能访问到相同配置，即使当前 route 标记为 passthrough。
    const metaBase: Record<string, unknown> = {
      ...(normalized.metadata ?? {}),
    };
    const rtBase = ensureRuntimeMetadata(metaBase);
    const webSearchConfig = this.config.virtualRouter?.webSearch;
    if (webSearchConfig) {
      (rtBase as Record<string, unknown>).webSearch = webSearchConfig;
    }
    const execCommandGuard = this.config.virtualRouter?.execCommandGuard;
    if (execCommandGuard) {
      (rtBase as Record<string, unknown>).execCommandGuard = execCommandGuard;
    }
    const clockConfig = this.config.virtualRouter?.clock;
    if (clockConfig) {
      (rtBase as Record<string, unknown>).clock = clockConfig;
    }
    normalized.metadata = metaBase;

    let processedRequest: ProcessedRequest | undefined;
    if (activeProcessMode !== "passthrough") {
      assertNoMappableSemanticsInMetadata(
        metaBase,
        "chat_process.request.entry",
      );
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
      try {
        const reservation = (processedRequest as any)?.metadata
          ?.__clockReservation;
        if (reservation && typeof reservation === "object") {
          (metaBase as Record<string, unknown>).__clockReservation =
            reservation as unknown;
        }
      } catch {
        // best-effort: do not block request handling due to metadata propagation failures
      }
      if (processResult.nodeResult) {
        nodeResults.push(
          this.convertProcessNodeResult(
            "chat_process.req.stage4.tool_governance",
            processResult.nodeResult,
          ),
        );
      }
    } else {
      nodeResults.push({
        id: "chat_process.req.stage4.tool_governance",
        success: true,
        metadata: {
          node: "chat_process.req.stage4.tool_governance",
          skipped: true,
          reason: "process_mode_passthrough_parse_record_only",
        },
      });
      if (passthroughAudit) {
        annotatePassthroughGovernanceSkip(passthroughAudit);
      }
    }

    let workingRequest: StandardizedRequest | ProcessedRequest =
      syncResponsesContextFromCanonicalMessages(
        processedRequest ?? standardizedRequest,
      );

    // 使用与 VirtualRouter 一致的 tiktoken 计数逻辑，对标准化请求进行一次
    // 上下文 token 估算，供后续 usage 归一化与统计使用。
    try {
      const estimatedTokens =
        estimateSessionBoundTokens(
          workingRequest,
          normalized.metadata as Record<string, unknown> | undefined,
        ) ?? computeRequestTokens(workingRequest, "");
      if (
        typeof estimatedTokens === "number" &&
        Number.isFinite(estimatedTokens) &&
        estimatedTokens > 0
      ) {
        normalized.metadata = normalized.metadata || {};
        (normalized.metadata as Record<string, unknown>).estimatedInputTokens =
          estimatedTokens;
      }
    } catch {
      // 估算失败不应影响主流程
    }

    const normalizedMeta = normalized.metadata as
      | Record<string, unknown>
      | undefined;
    // responsesResume is a client-protocol semantic (/v1/responses tool loop) and must live in chat.semantics.
    // Do not read it from metadata once entering chat_process.
    const responsesResume =
      readResponsesResumeFromRequestSemantics(workingRequest);
    const stdMetadata = (
      workingRequest as StandardizedRequest | ProcessedRequest | undefined
    )?.metadata as Record<string, unknown> | undefined;
    const hasImageAttachment = containsImageAttachment(
      (workingRequest.messages ?? []) as StandardizedRequest["messages"],
    );
    const serverToolRequired =
      stdMetadata?.webSearchEnabled === true ||
      stdMetadata?.serverToolRequired === true;

    const sessionIdentifiers = extractSessionIdentifiersFromMetadata(
      normalized.metadata as Record<string, unknown> | undefined,
    );

    // 将从 metadata / clientHeaders 中解析出的会话标识同步回 normalized.metadata，
    // 便于后续 AdapterContext（响应侧 servertool）也能访问到相同的 sessionId /
    // conversationId，用于 sticky-session 相关逻辑（例如 stopMessage）。
    if (
      sessionIdentifiers.sessionId &&
      normalized.metadata &&
      typeof normalized.metadata === "object"
    ) {
      (normalized.metadata as Record<string, unknown>).sessionId =
        sessionIdentifiers.sessionId;
    }
    if (
      sessionIdentifiers.conversationId &&
      normalized.metadata &&
      typeof normalized.metadata === "object"
    ) {
      (normalized.metadata as Record<string, unknown>).conversationId =
        sessionIdentifiers.conversationId;
    }

    const disableStickyRoutes =
      (
        readRuntimeMetadata(
          normalized.metadata as Record<string, unknown>,
        ) as any
      )?.disableStickyRoutes === true;
    const stopMessageRouterMetadata = resolveStopMessageRouterMetadata(
      normalized.metadata as Record<string, unknown> | undefined,
    );
    const estimatedInputTokens = (() => {
      const value = (normalized.metadata as Record<string, unknown> | undefined)
        ?.estimatedInputTokens;
      return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
    })();
    const metadataInput: RouterMetadataInput = {
      requestId: normalized.id,
      entryEndpoint: normalized.entryEndpoint,
      processMode: normalized.processMode,
      stream: normalized.stream,
      direction: normalized.direction,
      providerProtocol: normalized.providerProtocol,
      routeHint: normalized.routeHint,
      stage: normalized.stage,
      responsesResume:
        responsesResume as RouterMetadataInput["responsesResume"],
      ...(estimatedInputTokens !== undefined ? { estimatedInputTokens } : {}),
      ...(disableStickyRoutes ? { disableStickyRoutes: true } : {}),
      ...(serverToolRequired ? { serverToolRequired: true } : {}),
      ...(sessionIdentifiers.sessionId
        ? { sessionId: sessionIdentifiers.sessionId }
        : {}),
      ...(sessionIdentifiers.conversationId
        ? { conversationId: sessionIdentifiers.conversationId }
        : {}),
      ...stopMessageRouterMetadata,
    };
    logHubStageTiming(
      normalized.id,
      "req_process.stage2_route_select",
      "start",
    );
    const routing = runReqProcessStage2RouteSelect({
      routerEngine: this.routerEngine,
      request: workingRequest,
      metadataInput,
      normalizedMetadata: normalized.metadata,
      stageRecorder: inboundRecorder,
    });
    logHubStageTiming(
      normalized.id,
      "req_process.stage2_route_select",
      "completed",
    );
    // Emit virtual router hit log for debugging (orange [virtual-router] ...)
    try {
      const routeName = routing.decision?.routeName;
      const providerKey = routing.target?.providerKey;
      const modelId = workingRequest.model;
      const logger = (normalized.metadata &&
        (normalized.metadata as any).logger) as {
        logVirtualRouterHit?: (
          route: string,
          provider: string,
          model?: string,
          sessionId?: string,
        ) => void;
      };
      if (
        logger &&
        typeof logger.logVirtualRouterHit === "function" &&
        routeName &&
        providerKey
      ) {
        logger.logVirtualRouterHit(
          routeName,
          providerKey,
          typeof modelId === "string" ? modelId : undefined,
          typeof sessionIdentifiers.sessionId === "string"
            ? sessionIdentifiers.sessionId
            : undefined,
        );
      }
    } catch {
      // logging must not break routing
    }

    const outboundStream = this.resolveOutboundStreamIntent(
      routing.target?.streaming,
    );
    workingRequest = this.applyOutboundStreamPreference(
      workingRequest,
      outboundStream,
      activeProcessMode,
    );
    this.applyMaxTokensPolicy(workingRequest, routing.target);

    const outboundAdapterContext = this.buildAdapterContext(
      normalized,
      routing.target,
    );
    if (routing.target?.compatibilityProfile) {
      outboundAdapterContext.compatibilityProfile =
        routing.target.compatibilityProfile;
    }
    const outboundProtocol =
      outboundAdapterContext.providerProtocol as ProviderProtocol;
    if (
      activeProcessMode === "passthrough" &&
      outboundProtocol !== normalized.providerProtocol
    ) {
      throw new Error(
        `[HubPipeline] passthrough requires matching protocols: entry=${normalized.providerProtocol}, target=${outboundProtocol}`,
      );
    }
    // Snapshots must be grouped by entry endpoint (client-facing protocol), not by provider protocol.
    // Otherwise one request would be split across multiple folders (e.g. openai-responses + anthropic-messages),
    // which breaks codex-samples correlation.
    const outboundRecorder = this.maybeCreateStageRecorder(
      outboundAdapterContext,
      normalized.entryEndpoint,
      {
        disableSnapshots: normalized.disableSnapshots === true,
      },
    );
    const outboundStart = Date.now();
    let providerPayload: Record<string, unknown>;
    let shadowBaselineProviderPayload: Record<string, unknown> | undefined;
    if (activeProcessMode === "passthrough") {
      providerPayload = jsonClone(rawRequest as any) as Record<string, unknown>;
      if (typeof outboundStream === "boolean") {
        providerPayload.stream = outboundStream;
      }
      if (passthroughAudit) {
        attachPassthroughProviderInputAudit(
          passthroughAudit,
          providerPayload,
          outboundProtocol,
        );
      }
    } else {
      const protocolSwitch = outboundProtocol !== normalized.providerProtocol;
      const outboundHooks = protocolSwitch
        ? this.resolveProtocolHooks(outboundProtocol)
        : hooks;
      if (!outboundHooks) {
        throw new Error(
          `[HubPipeline] Unsupported provider protocol for hub pipeline: ${outboundProtocol}`,
        );
      }
      const outboundSemanticMapper = protocolSwitch
        ? outboundHooks.createSemanticMapper()
        : semanticMapper;
      const outboundContextMetadataKey = protocolSwitch
        ? outboundHooks.contextMetadataKey
        : hooks.contextMetadataKey;
      const outboundContextSnapshot = protocolSwitch
        ? undefined
        : (contextSnapshot as Record<string, unknown> | undefined);

      const outboundStage1 = await measureHubStage(
        normalized.id,
        "req_outbound.stage1_semantic_map",
        () =>
          runReqOutboundStage1SemanticMap({
            request: workingRequest,
            adapterContext: outboundAdapterContext,
            semanticMapper: outboundSemanticMapper,
            contextSnapshot: outboundContextSnapshot,
            contextMetadataKey: outboundContextMetadataKey,
            stageRecorder: outboundRecorder,
          }),
      );
      let formattedPayload = await measureHubStage(
        normalized.id,
        "req_outbound.stage2_format_build",
        () =>
          runReqOutboundStage2FormatBuild({
            formatEnvelope: outboundStage1.formatEnvelope,
            stageRecorder: outboundRecorder,
          }),
      );
      formattedPayload = await measureHubStage(
        normalized.id,
        "req_outbound.stage3_compat",
        () =>
          runReqOutboundStage3Compat({
            payload: formattedPayload as JsonObject,
            adapterContext: outboundAdapterContext,
            stageRecorder: outboundRecorder,
          }),
      );

      if (shadowCompareBaselineMode) {
        const baselinePolicy: HubPolicyConfig = {
          ...(effectivePolicy ?? {}),
          mode: shadowCompareBaselineMode,
        };
        // Compute a baseline provider payload in the *same execution*, without recording
        // snapshots/diffs and without re-running the full pipeline. This avoids side effects
        // (conversation store, followup captures, etc.) that a second execute() would trigger.
        const baselineFormatted =
          typeof (globalThis as any).structuredClone === "function"
            ? ((globalThis as any).structuredClone(
                formattedPayload,
              ) as JsonObject)
            : (jsonClone(formattedPayload as any) as JsonObject);
        let baselinePayload = applyHubProviderOutboundPolicy({
          policy: baselinePolicy,
          providerProtocol: outboundProtocol,
          compatibilityProfile:
            typeof outboundAdapterContext.compatibilityProfile === "string"
              ? outboundAdapterContext.compatibilityProfile
              : undefined,
          payload: baselineFormatted,
          stageRecorder: undefined,
          requestId: normalized.id,
        }) as Record<string, unknown>;
        baselinePayload = applyProviderOutboundToolSurface({
          config: this.config.toolSurface,
          providerProtocol: outboundProtocol,
          payload: baselinePayload as JsonObject,
          stageRecorder: undefined,
          requestId: normalized.id,
        }) as Record<string, unknown>;
        shadowBaselineProviderPayload = baselinePayload;
      }
      // Phase 0/1: observe provider outbound payload violations before any enforcement rewrites.
      // This provides black-box visibility into what the pipeline would have sent upstream.
      recordHubPolicyObservation({
        policy: effectivePolicy,
        providerProtocol: outboundProtocol,
        compatibilityProfile:
          typeof outboundAdapterContext.compatibilityProfile === "string"
            ? outboundAdapterContext.compatibilityProfile
            : undefined,
        payload: formattedPayload as JsonObject,
        stageRecorder: outboundRecorder,
        requestId: normalized.id,
      });
      providerPayload = applyHubProviderOutboundPolicy({
        policy: effectivePolicy,
        providerProtocol: outboundProtocol,
        compatibilityProfile:
          typeof outboundAdapterContext.compatibilityProfile === "string"
            ? outboundAdapterContext.compatibilityProfile
            : undefined,
        payload: formattedPayload as JsonObject,
        stageRecorder: outboundRecorder,
        requestId: normalized.id,
      }) as Record<string, unknown>;
      providerPayload = applyProviderOutboundToolSurface({
        config: this.config.toolSurface,
        providerProtocol: outboundProtocol,
        payload: providerPayload as JsonObject,
        stageRecorder: outboundRecorder,
        requestId: normalized.id,
      }) as Record<string, unknown>;
      providerPayload = maybeApplyDirectBuiltinWebSearchTool(
        providerPayload,
        outboundAdapterContext,
        outboundProtocol,
      );

      recordHubPolicyObservation({
        policy: effectivePolicy,
        providerProtocol: outboundProtocol,
        compatibilityProfile:
          typeof outboundAdapterContext.compatibilityProfile === "string"
            ? outboundAdapterContext.compatibilityProfile
            : undefined,
        payload: providerPayload as JsonObject,
        stageRecorder: outboundRecorder,
        requestId: normalized.id,
      });
      if (passthroughAudit) {
        attachPassthroughProviderInputAudit(
          passthroughAudit,
          providerPayload,
          outboundProtocol,
        );
      }
    }
    const outboundEnd = Date.now();
    nodeResults.push({
      id: "req_outbound",
      success: true,
      metadata: {
        node: "req_outbound",
        executionTime: outboundEnd - outboundStart,
        startTime: outboundStart,
        endTime: outboundEnd,
        dataProcessed: {
          messages: workingRequest.messages.length,
          tools: workingRequest.tools?.length ?? 0,
        },
      },
    });

    // 为响应侧 servertool/web_search 提供一次性 Chat 请求快照，便于在 Hub 内部实现
    // 第三跳（将工具结果注入消息历史后重新调用主模型）。
    //
    // 注意：这里不再根据 processMode(passthrough/chat) 做分支判断——即使某些
    // route 将 processMode 标记为 passthrough，我们仍然需要保留一次规范化后的
    // Chat 请求快照，供 stopMessage 等被动触发型
    // servertool 在响应阶段使用。
    //
    // 之前这里通过 JSON.stringify/parse 做深拷贝，但在部分 Responses/Gemini
    // 场景下，workingRequest 上携带的 metadata 可能包含无法安全序列化的字段，
    // 导致克隆过程抛错、capturedChatRequest 被静默丢弃，从而让响应侧的
    // stop_message_auto 等 ServerTool 无法获取上一跳的 Chat 请求。
    //
    // 对于 capturedChatRequest，我们只需要一个“可读快照”，不会在后续流程中
    // 对其做就地修改，因此可以直接使用浅拷贝结构，避免序列化失败导致整段
    // 逻辑失效。
    // Deep-clone a JSON-safe snapshot for servertool followups.
    // Only capture the canonical Chat payload fields (model/messages/tools/parameters) to keep it serializable.
    const capturedChatRequest: Record<string, unknown> = {
      model: workingRequest.model,
      messages: jsonClone(workingRequest.messages as any),
      tools: workingRequest.tools
        ? jsonClone(workingRequest.tools as any)
        : workingRequest.tools,
      parameters: workingRequest.parameters
        ? jsonClone(workingRequest.parameters as any)
        : workingRequest.parameters,
    } as Record<string, unknown>;

    const metadata: Record<string, unknown> = {
      ...normalized.metadata,
      capturedChatRequest,
      entryEndpoint: normalized.entryEndpoint,
      providerProtocol: outboundProtocol,
      stream: normalized.stream,
      processMode: normalized.processMode,
      ...(passthroughAudit ? { passthroughAudit } : {}),
      routeHint: normalized.routeHint,
      target: routing.target,
      ...(typeof outboundStream === "boolean"
        ? { providerStream: outboundStream }
        : {}),
      ...(shadowBaselineProviderPayload
        ? {
            hubShadowCompare: {
              baselineMode: shadowCompareBaselineMode,
              candidateMode: (effectivePolicy?.mode ?? "off") as HubPolicyMode,
              providerProtocol: outboundProtocol,
              baselineProviderPayload: shadowBaselineProviderPayload,
            },
          }
        : {}),
    };

    if (hasImageAttachment) {
      metadata.hasImageAttachment = true;
    } else {
      delete metadata.hasImageAttachment;
    }

    return {
      requestId: normalized.id,
      providerPayload,
      standardizedRequest,
      processedRequest,
      routingDecision: routing.decision,
      routingDiagnostics: routing.diagnostics,
      target: routing.target,
      metadata,
      nodeResults,
    };
  }

  private resolveClientProtocol(entryEndpoint: string): ProviderProtocol {
    const protocol = resolveHubClientProtocolWithNative(entryEndpoint);
    if (
      protocol === "openai-responses" ||
      protocol === "anthropic-messages" ||
      protocol === "openai-chat"
    ) {
      return protocol;
    }
    return "openai-chat";
  }

  private coerceStandardizedRequestFromPayload(
    payload: Record<string, unknown>,
    normalized: NormalizedRequest,
  ): {
    standardizedRequest: StandardizedRequest;
    rawPayload: Record<string, unknown>;
  } {
    const model =
      typeof payload.model === "string" && payload.model.trim().length
        ? payload.model.trim()
        : "";
    if (!model) {
      throw new Error("[HubPipeline] outbound stage requires payload.model");
    }
    const messages = Array.isArray(payload.messages)
      ? (payload.messages as StandardizedRequest["messages"])
      : null;
    if (!messages) {
      throw new Error(
        "[HubPipeline] outbound stage requires payload.messages[]",
      );
    }
    const tools = Array.isArray(payload.tools)
      ? (payload.tools as StandardizedRequest["tools"])
      : undefined;
    const parameters =
      payload.parameters &&
      typeof payload.parameters === "object" &&
      !Array.isArray(payload.parameters)
        ? (payload.parameters as StandardizedRequest["parameters"])
        : ({} as StandardizedRequest["parameters"]);
    const semanticsFromPayload =
      payload.semantics &&
      typeof payload.semantics === "object" &&
      !Array.isArray(payload.semantics)
        ? (jsonClone(payload.semantics as any) as Record<string, unknown>)
        : undefined;
    const metadataFromPayload =
      payload.metadata &&
      typeof payload.metadata === "object" &&
      !Array.isArray(payload.metadata)
        ? (payload.metadata as Record<string, unknown>)
        : undefined;
    const standardizedRequest: StandardizedRequest = {
      model,
      messages,
      ...(tools ? { tools } : {}),
      parameters,
      metadata: {
        originalEndpoint: normalized.entryEndpoint,
        ...(metadataFromPayload ? metadataFromPayload : {}),
        requestId: normalized.id,
        stream: normalized.stream,
        processMode: normalized.processMode,
        ...(normalized.routeHint ? { routeHint: normalized.routeHint } : {}),
      } as any,
      ...(semanticsFromPayload
        ? { semantics: semanticsFromPayload as any }
        : {}),
    };
    // Ensure followup/chat_process entry can still preserve mappable semantics
    // without injecting them into metadata.
    try {
      const semantics =
        (standardizedRequest as any).semantics &&
        typeof (standardizedRequest as any).semantics === "object"
          ? ((standardizedRequest as any).semantics as Record<string, unknown>)
          : ((standardizedRequest as any).semantics = {});
      if (
        !semantics.tools ||
        typeof semantics.tools !== "object" ||
        Array.isArray(semantics.tools)
      ) {
        semantics.tools = {};
      }
      const toolsNode = semantics.tools as Record<string, unknown>;
      if (
        Array.isArray(payload.tools) &&
        payload.tools.length &&
        toolsNode.clientToolsRaw === undefined
      ) {
        toolsNode.clientToolsRaw = jsonClone(payload.tools as any);
      }
    } catch {
      // best-effort
    }
    // Keep rawPayload minimal and JSON-safe; chat-process only needs the OpenAI-chat-like surface here.
    const rawPayload: Record<string, unknown> = {
      model,
      messages,
      ...(tools ? { tools } : {}),
      ...(parameters && Object.keys(parameters).length ? { parameters } : {}),
    };
    return { standardizedRequest, rawPayload };
  }

  private async executeChatProcessEntryPipeline(
    normalized: NormalizedRequest,
  ): Promise<HubPipelineResult> {
    const hooks = this.resolveProtocolHooks(normalized.providerProtocol);
    if (!hooks) {
      throw new Error(
        `Unsupported provider protocol for hub pipeline: ${normalized.providerProtocol}`,
      );
    }

    const nodeResults: HubPipelineNodeResult[] = [];
    nodeResults.push({
      id: "req_inbound",
      success: true,
      metadata: {
        node: "req_inbound",
        skipped: true,
        reason: "stage=outbound",
        dataProcessed: {},
      },
    });

    const rawPayloadInput = this.asJsonObject(normalized.payload);
    const { standardizedRequest: standardizedRequestBase, rawPayload } =
      this.coerceStandardizedRequestFromPayload(
        rawPayloadInput as any,
        normalized,
      );

    // Keep metadata injection consistent with the inbound path: servertool/web_search config must be available
    // to chat-process/tool governance even when request enters at outbound stage.
    const metaBase: Record<string, unknown> = {
      ...(normalized.metadata ?? {}),
    };
    const rtBase = ensureRuntimeMetadata(metaBase);
    const webSearchConfig = this.config.virtualRouter?.webSearch;
    if (webSearchConfig) {
      (rtBase as Record<string, unknown>).webSearch = webSearchConfig;
    }
    const execCommandGuard = this.config.virtualRouter?.execCommandGuard;
    if (execCommandGuard) {
      (rtBase as Record<string, unknown>).execCommandGuard = execCommandGuard;
    }
    const clockConfig = this.config.virtualRouter?.clock;
    if (clockConfig) {
      (rtBase as Record<string, unknown>).clock = clockConfig;
    }
    normalized.metadata = metaBase;

    const cleanedRequest: StandardizedRequest =
      applyChatProcessEntryMediaCleanup(standardizedRequestBase);
    let standardizedRequest: StandardizedRequest = cleanedRequest;

    const activeProcessMode = resolveActiveProcessMode(
      normalized.processMode,
      cleanedRequest.messages,
    );
    if (activeProcessMode !== normalized.processMode) {
      normalized.processMode = activeProcessMode;
    }
    const passthroughAudit =
      activeProcessMode === "passthrough"
        ? buildPassthroughAudit(rawPayload, normalized.providerProtocol)
        : undefined;
    // Semantic Gate (chat_process entry): lift any mappable protocol semantics from metadata into request.semantics.
    // This is the last chance before entering chat_process; after this point we fail-fast on banned metadata keys.
    try {
      standardizedRequest = liftResponsesResumeIntoSemantics(
        standardizedRequest,
        metaBase,
      );
    } catch {
      // best-effort; validation happens below
    }
    try {
      const rt = readRuntimeMetadata(metaBase);
      const mode = String((rt as any)?.applyPatchToolMode || "")
        .trim()
        .toLowerCase();
      if (mode === "freeform" || mode === "schema") {
        (
          standardizedRequest.metadata as Record<string, unknown>
        ).applyPatchToolMode = mode;
      }
    } catch {
      // ignore
    }

    const adapterContext = this.buildAdapterContext(normalized);
    const stageRecorder = this.maybeCreateStageRecorder(
      adapterContext,
      normalized.entryEndpoint,
      {
        disableSnapshots: normalized.disableSnapshots === true,
      },
    );

    let processedRequest: ProcessedRequest | undefined;
    if (activeProcessMode !== "passthrough") {
      assertNoMappableSemanticsInMetadata(
        metaBase,
        "chat_process.request.entry",
      );
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
      try {
        const reservation = (processedRequest as any)?.metadata
          ?.__clockReservation;
        if (reservation && typeof reservation === "object") {
          (metaBase as Record<string, unknown>).__clockReservation =
            reservation as unknown;
        }
      } catch {
        // best-effort
      }
      if (processResult.nodeResult) {
        nodeResults.push(
          this.convertProcessNodeResult(
            "chat_process.req.stage4.tool_governance",
            processResult.nodeResult,
          ),
        );
      }
    } else {
      nodeResults.push({
        id: "chat_process.req.stage4.tool_governance",
        success: true,
        metadata: {
          node: "chat_process.req.stage4.tool_governance",
          skipped: true,
          reason: "process_mode_passthrough_parse_record_only",
        },
      });
      if (passthroughAudit) {
        annotatePassthroughGovernanceSkip(passthroughAudit);
      }
    }

    let workingRequest: StandardizedRequest | ProcessedRequest =
      syncResponsesContextFromCanonicalMessages(
        processedRequest ?? standardizedRequest,
      );

    // Token estimate for stats/diagnostics (best-effort).
    try {
      const estimatedTokens =
        estimateSessionBoundTokens(
          workingRequest,
          normalized.metadata as Record<string, unknown> | undefined,
        ) ?? computeRequestTokens(workingRequest, "");
      if (
        typeof estimatedTokens === "number" &&
        Number.isFinite(estimatedTokens) &&
        estimatedTokens > 0
      ) {
        normalized.metadata = normalized.metadata || {};
        (normalized.metadata as Record<string, unknown>).estimatedInputTokens =
          estimatedTokens;
      }
    } catch {
      // ignore
    }

    const normalizedMeta = normalized.metadata as
      | Record<string, unknown>
      | undefined;
    // responsesResume is a client-protocol semantic (/v1/responses tool loop) and must live in chat.semantics.
    // Do not read it from metadata once entering chat_process.
    const responsesResume =
      readResponsesResumeFromRequestSemantics(workingRequest);
    const stdMetadata = (
      workingRequest as StandardizedRequest | ProcessedRequest | undefined
    )?.metadata as Record<string, unknown> | undefined;
    const hasImageAttachment = containsImageAttachment(
      (workingRequest.messages ?? []) as StandardizedRequest["messages"],
    );
    const serverToolRequired =
      stdMetadata?.webSearchEnabled === true ||
      stdMetadata?.serverToolRequired === true;

    const sessionIdentifiers = extractSessionIdentifiersFromMetadata(
      normalized.metadata as Record<string, unknown> | undefined,
    );
    if (
      sessionIdentifiers.sessionId &&
      normalized.metadata &&
      typeof normalized.metadata === "object"
    ) {
      (normalized.metadata as Record<string, unknown>).sessionId =
        sessionIdentifiers.sessionId;
    }
    if (
      sessionIdentifiers.conversationId &&
      normalized.metadata &&
      typeof normalized.metadata === "object"
    ) {
      (normalized.metadata as Record<string, unknown>).conversationId =
        sessionIdentifiers.conversationId;
    }

    const disableStickyRoutes =
      (
        readRuntimeMetadata(
          normalized.metadata as Record<string, unknown>,
        ) as any
      )?.disableStickyRoutes === true;
    const stopMessageRouterMetadata = resolveStopMessageRouterMetadata(
      normalized.metadata as Record<string, unknown> | undefined,
    );
    const metadataInput: RouterMetadataInput = {
      requestId: normalized.id,
      entryEndpoint: normalized.entryEndpoint,
      processMode: normalized.processMode,
      stream: normalized.stream,
      direction: normalized.direction,
      providerProtocol: normalized.providerProtocol,
      routeHint: normalized.routeHint,
      stage: normalized.stage,
      responsesResume:
        responsesResume as RouterMetadataInput["responsesResume"],
      ...(disableStickyRoutes ? { disableStickyRoutes: true } : {}),
      ...(serverToolRequired ? { serverToolRequired: true } : {}),
      ...(sessionIdentifiers.sessionId
        ? { sessionId: sessionIdentifiers.sessionId }
        : {}),
      ...(sessionIdentifiers.conversationId
        ? { conversationId: sessionIdentifiers.conversationId }
        : {}),
      ...stopMessageRouterMetadata,
    };

    const routing = runReqProcessStage2RouteSelect({
      routerEngine: this.routerEngine,
      request: workingRequest,
      metadataInput,
      normalizedMetadata: normalized.metadata,
      stageRecorder,
    });
    // Emit virtual router hit log for debugging (same as inbound path).
    try {
      const routeName = routing.decision?.routeName;
      const providerKey = routing.target?.providerKey;
      const modelId = workingRequest.model;
      const logger = (normalized.metadata &&
        (normalized.metadata as any).logger) as {
        logVirtualRouterHit?: (
          route: string,
          provider: string,
          model?: string,
          sessionId?: string,
        ) => void;
      };
      if (
        logger &&
        typeof logger.logVirtualRouterHit === "function" &&
        routeName &&
        providerKey
      ) {
        logger.logVirtualRouterHit(
          routeName,
          providerKey,
          typeof modelId === "string" ? modelId : undefined,
          typeof sessionIdentifiers.sessionId === "string"
            ? sessionIdentifiers.sessionId
            : undefined,
        );
      }
    } catch {
      // ignore
    }

    const outboundStream = this.resolveOutboundStreamIntent(
      routing.target?.streaming,
    );
    workingRequest = this.applyOutboundStreamPreference(
      workingRequest,
      outboundStream,
      activeProcessMode,
    );

    const outboundAdapterContext = this.buildAdapterContext(
      normalized,
      routing.target,
    );
    if (routing.target?.compatibilityProfile) {
      outboundAdapterContext.compatibilityProfile =
        routing.target.compatibilityProfile;
    }
    const outboundProtocol =
      outboundAdapterContext.providerProtocol as ProviderProtocol;
    if (
      activeProcessMode === "passthrough" &&
      outboundProtocol !== normalized.providerProtocol
    ) {
      throw new Error(
        `[HubPipeline] passthrough requires matching protocols: entry=${normalized.providerProtocol}, target=${outboundProtocol}`,
      );
    }
    const outboundRecorder = this.maybeCreateStageRecorder(
      outboundAdapterContext,
      normalized.entryEndpoint,
      {
        disableSnapshots: normalized.disableSnapshots === true,
      },
    );
    const outboundStart = Date.now();
    let providerPayload: Record<string, unknown>;
    if (activeProcessMode === "passthrough") {
      providerPayload = jsonClone(rawPayloadInput as any) as Record<
        string,
        unknown
      >;
      if (typeof outboundStream === "boolean") {
        providerPayload.stream = outboundStream;
      }
      if (passthroughAudit) {
        attachPassthroughProviderInputAudit(
          passthroughAudit,
          providerPayload,
          outboundProtocol,
        );
      }
    } else {
      const protocolSwitch = outboundProtocol !== normalized.providerProtocol;
      const outboundHooks = protocolSwitch
        ? this.resolveProtocolHooks(outboundProtocol)
        : hooks;
      if (!outboundHooks) {
        throw new Error(
          `[HubPipeline] Unsupported provider protocol for hub pipeline: ${outboundProtocol}`,
        );
      }
      const outboundSemanticMapper = protocolSwitch
        ? outboundHooks.createSemanticMapper()
        : hooks.createSemanticMapper();
      const outboundContextMetadataKey = protocolSwitch
        ? outboundHooks.contextMetadataKey
        : hooks.contextMetadataKey;
      const outboundContextSnapshot = undefined;
      const outboundStage1 = await measureHubStage(
        normalized.id,
        "req_outbound.stage1_semantic_map",
        () =>
          runReqOutboundStage1SemanticMap({
            request: workingRequest,
            adapterContext: outboundAdapterContext,
            semanticMapper: outboundSemanticMapper,
            contextSnapshot: outboundContextSnapshot,
            contextMetadataKey: outboundContextMetadataKey,
            stageRecorder: outboundRecorder,
          }),
      );
      let formattedPayload = await measureHubStage(
        normalized.id,
        "req_outbound.stage2_format_build",
        () =>
          runReqOutboundStage2FormatBuild({
            formatEnvelope: outboundStage1.formatEnvelope,
            stageRecorder: outboundRecorder,
          }),
      );
      formattedPayload = await measureHubStage(
        normalized.id,
        "req_outbound.stage3_compat",
        () =>
          runReqOutboundStage3Compat({
            payload: formattedPayload as JsonObject,
            adapterContext: outboundAdapterContext,
            stageRecorder: outboundRecorder,
          }),
      );

      // Phase 0/1: observe + enforce provider outbound policy and tool surface (same as inbound path).
      const effectivePolicy = normalized.policyOverride ?? this.config.policy;
      recordHubPolicyObservation({
        policy: effectivePolicy,
        providerProtocol: outboundProtocol,
        compatibilityProfile:
          typeof outboundAdapterContext.compatibilityProfile === "string"
            ? outboundAdapterContext.compatibilityProfile
            : undefined,
        payload: formattedPayload as JsonObject,
        stageRecorder: outboundRecorder,
        requestId: normalized.id,
      });
      providerPayload = applyHubProviderOutboundPolicy({
        policy: effectivePolicy,
        providerProtocol: outboundProtocol,
        compatibilityProfile:
          typeof outboundAdapterContext.compatibilityProfile === "string"
            ? outboundAdapterContext.compatibilityProfile
            : undefined,
        payload: formattedPayload as JsonObject,
        stageRecorder: outboundRecorder,
        requestId: normalized.id,
      }) as Record<string, unknown>;
      providerPayload = applyProviderOutboundToolSurface({
        config: this.config.toolSurface,
        providerProtocol: outboundProtocol,
        payload: providerPayload as JsonObject,
        stageRecorder: outboundRecorder,
        requestId: normalized.id,
      }) as Record<string, unknown>;
      providerPayload = maybeApplyDirectBuiltinWebSearchTool(
        providerPayload,
        outboundAdapterContext,
        outboundProtocol,
      );
      recordHubPolicyObservation({
        policy: effectivePolicy,
        providerProtocol: outboundProtocol,
        compatibilityProfile:
          typeof outboundAdapterContext.compatibilityProfile === "string"
            ? outboundAdapterContext.compatibilityProfile
            : undefined,
        payload: providerPayload as JsonObject,
        stageRecorder: outboundRecorder,
        requestId: normalized.id,
      });
      if (passthroughAudit) {
        attachPassthroughProviderInputAudit(
          passthroughAudit,
          providerPayload,
          outboundProtocol,
        );
      }
    }

    const outboundEnd = Date.now();
    nodeResults.push({
      id: "req_outbound",
      success: true,
      metadata: {
        node: "req_outbound",
        executionTime: outboundEnd - outboundStart,
        startTime: outboundStart,
        endTime: outboundEnd,
        dataProcessed: {
          messages: workingRequest.messages.length,
          tools: workingRequest.tools?.length ?? 0,
        },
      },
    });

    const capturedChatRequest: Record<string, unknown> = {
      model: workingRequest.model,
      messages: jsonClone(workingRequest.messages as any),
      tools: workingRequest.tools
        ? jsonClone(workingRequest.tools as any)
        : workingRequest.tools,
      parameters: workingRequest.parameters
        ? jsonClone(workingRequest.parameters as any)
        : workingRequest.parameters,
    } as Record<string, unknown>;

    const metadata: Record<string, unknown> = {
      ...normalized.metadata,
      capturedChatRequest,
      entryEndpoint: normalized.entryEndpoint,
      providerProtocol: outboundProtocol,
      stream: normalized.stream,
      processMode: normalized.processMode,
      ...(passthroughAudit ? { passthroughAudit } : {}),
      routeHint: normalized.routeHint,
      target: routing.target,
      ...(typeof outboundStream === "boolean"
        ? { providerStream: outboundStream }
        : {}),
    };

    if (hasImageAttachment) {
      metadata.hasImageAttachment = true;
    } else {
      delete metadata.hasImageAttachment;
    }

    return {
      requestId: normalized.id,
      providerPayload,
      standardizedRequest,
      processedRequest,
      routingDecision: routing.decision,
      routingDiagnostics: routing.diagnostics,
      target: routing.target,
      metadata,
      nodeResults,
    };
  }

  async execute(request: HubPipelineRequest): Promise<HubPipelineResult> {
    const normalized = await this.normalizeRequest(request);
    clearHubStageTiming(normalized.id);
    try {
      if (
        normalized.direction === "request" &&
        normalized.hubEntryMode === "chat_process"
      ) {
        return await this.executeChatProcessEntryPipeline(normalized);
      }
      const hooks = this.resolveProtocolHooks(normalized.providerProtocol);
      if (!hooks) {
        throw new Error(
          `Unsupported provider protocol for hub pipeline: ${normalized.providerProtocol}`,
        );
      }
      return await this.executeRequestStagePipeline(normalized, hooks);
    } finally {
      clearHubStageTiming(normalized.id);
    }
  }

  private captureAnthropicAliasMap(
    normalized: NormalizedRequest,
    adapterContext: AdapterContext,
    chatEnvelope: ChatEnvelope,
  ): void {
    if (!this.shouldCaptureAnthropicAlias(normalized.entryEndpoint)) {
      return;
    }
    const aliasMap = this.resolveAliasMapFromSources(
      adapterContext,
      chatEnvelope,
    );
    if (!aliasMap) {
      return;
    }
    // A1: tool name alias map is mappable semantics and must live in chat.semantics (never metadata).
    try {
      if (
        !chatEnvelope.semantics ||
        typeof chatEnvelope.semantics !== "object" ||
        Array.isArray(chatEnvelope.semantics)
      ) {
        chatEnvelope.semantics = {};
      }
      const semantics = chatEnvelope.semantics as Record<string, unknown>;
      if (!semantics.tools || !isJsonObject(semantics.tools as any)) {
        semantics.tools = {} as any;
      }
      const toolsNode = semantics.tools as Record<string, unknown>;
      if (
        !isJsonObject((toolsNode as any).toolNameAliasMap) &&
        !isJsonObject((toolsNode as any).toolAliasMap)
      ) {
        (toolsNode as any).toolNameAliasMap = jsonClone(aliasMap as any);
      }
    } catch {
      // best-effort: never block request handling due to alias map propagation failures
    }
  }

  private shouldCaptureAnthropicAlias(endpoint: string): boolean {
    return (
      typeof endpoint === "string" &&
      endpoint.toLowerCase().includes("/v1/messages")
    );
  }

  private resolveAliasMapFromSources(
    adapterContext: AdapterContext,
    chatEnvelope: ChatEnvelope,
  ): Record<string, string> | undefined {
    const fromContext = coerceAliasMap(
      (adapterContext as Record<string, unknown>).anthropicToolNameMap,
    );
    if (fromContext) {
      return fromContext;
    }
    const metadataNode = chatEnvelope.metadata as
      | Record<string, unknown>
      | undefined;
    const direct = metadataNode
      ? coerceAliasMap(metadataNode.anthropicToolNameMap)
      : undefined;
    if (direct) {
      return direct;
    }
    const contextNode =
      metadataNode &&
      metadataNode.context &&
      typeof metadataNode.context === "object"
        ? (metadataNode.context as Record<string, unknown>)
        : undefined;
    const fromContextNode = coerceAliasMap(contextNode?.anthropicToolNameMap);
    if (fromContextNode) {
      return fromContextNode;
    }
    return readAliasMapFromSemantics(chatEnvelope);
  }

  private resolveProtocolHooks(
    protocol: ProviderProtocol,
  ): RequestStageHooks<Record<string, unknown>> | undefined {
    switch (protocol) {
      case "openai-chat":
        return {
          createFormatAdapter: () => new ChatFormatAdapter(),
          createSemanticMapper: () => new ChatSemanticMapper(),
          captureContext: (options) => runChatContextCapture(options),
          contextMetadataKey: "chatContext",
        };
      case "openai-responses":
        return {
          createFormatAdapter: () => new ResponsesFormatAdapter(),
          createSemanticMapper: () => new ResponsesSemanticMapper(),
          captureContext: createResponsesContextCapture(
            captureResponsesContextSnapshot,
          ),
          contextMetadataKey: "responsesContext",
        };
      case "anthropic-messages":
        return {
          createFormatAdapter: () => new AnthropicFormatAdapter(),
          createSemanticMapper: () => new AnthropicSemanticMapper(),
          captureContext: (options) => runChatContextCapture(options),
          contextMetadataKey: "anthropicContext",
        };
      case "gemini-chat":
        return {
          createFormatAdapter: () => new GeminiFormatAdapter(),
          createSemanticMapper: () => new GeminiSemanticMapper(),
          captureContext: createNoopContextCapture("gemini-chat"),
        };
      default:
        return undefined;
    }
  }

  private buildAdapterContext(
    normalized: NormalizedRequest,
    target?: TargetMetadata,
  ): AdapterContext {
    const metadata = normalized.metadata || {};
    const providerProtocol =
      (target?.outboundProfile as string | undefined) ||
      normalized.providerProtocol;
    const providerId = (target?.providerKey || metadata.providerKey) as
      | string
      | undefined;
    const routeId = metadata.routeName as string | undefined;
    const profileId = (target?.providerKey || metadata.pipelineId) as
      | string
      | undefined;
    const targetCompatProfile =
      typeof target?.compatibilityProfile === "string" &&
      target.compatibilityProfile.trim()
        ? target.compatibilityProfile.trim()
        : undefined;
    const metadataCompatProfile =
      typeof (metadata as Record<string, unknown>).compatibilityProfile ===
      "string"
        ? String(
            (metadata as Record<string, unknown>).compatibilityProfile,
          ).trim()
        : undefined;
    // When routing has already selected a target runtime, compat must be target-scoped only.
    // Never inherit stale top-level metadata.compatibilityProfile from a previous hop.
    const compatibilityProfile = target
      ? targetCompatProfile
      : metadataCompatProfile;
    const streamingHint =
      normalized.stream === true
        ? "force"
        : normalized.stream === false
          ? "disable"
          : "auto";
    const toolCallIdStyle = normalizeReqInboundToolCallIdStyleWithNative(
      metadata.toolCallIdStyle,
    );
    const adapterContext: AdapterContext = {
      requestId: normalized.id,
      entryEndpoint: normalized.entryEndpoint || "/v1/chat/completions",
      providerProtocol,
      providerId,
      routeId,
      profileId,
      streamingHint,
      toolCallIdStyle,
      ...(compatibilityProfile ? { compatibilityProfile } : {}),
    };
    const targetDeepseek = isJsonObject(
      target?.deepseek as JsonValue | undefined,
    )
      ? (jsonClone(target!.deepseek as JsonValue) as JsonObject)
      : undefined;
    if (targetDeepseek) {
      (adapterContext as Record<string, unknown>).deepseek = targetDeepseek;
      const rtCarrier = isJsonObject(
        (adapterContext as Record<string, unknown>).__rt as
          | JsonValue
          | undefined,
      )
        ? ({
            ...((adapterContext as Record<string, unknown>).__rt as Record<
              string,
              unknown
            >),
          } as Record<string, unknown>)
        : {};
      rtCarrier.deepseek = targetDeepseek as unknown as JsonValue;
      (adapterContext as Record<string, unknown>).__rt =
        rtCarrier as unknown as JsonValue;
    }
    if (typeof target?.anthropicThinking === "string" && target.anthropicThinking.trim()) {
      (adapterContext as Record<string, unknown>).anthropicThinking =
        target.anthropicThinking.trim().toLowerCase();
    }
    if (target?.anthropicThinkingConfig && typeof target.anthropicThinkingConfig === "object" && !Array.isArray(target.anthropicThinkingConfig)) {
      (adapterContext as Record<string, unknown>).anthropicThinkingConfig = jsonClone(
        target.anthropicThinkingConfig as any,
      );
    }
    if (target?.anthropicThinkingBudgets && typeof target.anthropicThinkingBudgets === "object" && !Array.isArray(target.anthropicThinkingBudgets)) {
      (adapterContext as Record<string, unknown>).anthropicThinkingBudgets = jsonClone(
        target.anthropicThinkingBudgets as any,
      );
    }
    const runtime = (metadata as Record<string, unknown>).runtime;
    if (runtime && typeof runtime === "object" && !Array.isArray(runtime)) {
      (adapterContext as Record<string, unknown>).runtime = jsonClone(
        runtime as any,
      ) as any;
    }
    const clientRequestId =
      typeof (metadata as Record<string, unknown>).clientRequestId === "string"
        ? (
            (metadata as Record<string, unknown>).clientRequestId as string
          ).trim()
        : "";
    if (clientRequestId) {
      (adapterContext as Record<string, unknown>).clientRequestId =
        clientRequestId;
    }
    const groupRequestId =
      typeof (metadata as Record<string, unknown>).groupRequestId === "string"
        ? (
            (metadata as Record<string, unknown>).groupRequestId as string
          ).trim()
        : "";
    if (groupRequestId) {
      (adapterContext as Record<string, unknown>).groupRequestId =
        groupRequestId;
    }
    if (typeof metadata.originalModelId === "string") {
      adapterContext.originalModelId = metadata.originalModelId as string;
    }
    if (typeof metadata.clientModelId === "string") {
      adapterContext.clientModelId = metadata.clientModelId as string;
    }
    if (typeof metadata.assignedModelId === "string") {
      (adapterContext as Record<string, unknown>).modelId =
        metadata.assignedModelId;
    }
    const estimatedInputTokens = Number(
      (metadata as Record<string, unknown>).estimatedInputTokens ??
        (metadata as Record<string, unknown>).estimated_tokens ??
        (metadata as Record<string, unknown>).estimatedTokens,
    );
    if (Number.isFinite(estimatedInputTokens) && estimatedInputTokens > 0) {
      (adapterContext as Record<string, unknown>).estimatedInputTokens =
        Math.max(1, Math.round(estimatedInputTokens));
    }
    const rt = cloneRuntimeMetadata(metadata);
    if (rt) {
      (adapterContext as Record<string, unknown>).__rt = rt as unknown;
    }
    const capturedChatRequest =
      (metadata as Record<string, unknown>).capturedChatRequest &&
      typeof (metadata as Record<string, unknown>).capturedChatRequest ===
        "object" &&
      !Array.isArray((metadata as Record<string, unknown>).capturedChatRequest)
        ? (jsonClone(
            (metadata as Record<string, unknown>)
              .capturedChatRequest as unknown as JsonValue,
          ) as unknown)
        : undefined;
    if (capturedChatRequest) {
      (adapterContext as Record<string, unknown>).capturedChatRequest =
        capturedChatRequest;
    }
    const sessionId =
      typeof (metadata as Record<string, unknown>).sessionId === "string"
        ? ((metadata as Record<string, unknown>).sessionId as string).trim()
        : "";
    if (sessionId) {
      (adapterContext as Record<string, unknown>).sessionId = sessionId;
    }
    const conversationId =
      typeof (metadata as Record<string, unknown>).conversationId === "string"
        ? (
            (metadata as Record<string, unknown>).conversationId as string
          ).trim()
        : "";
    if (conversationId) {
      (adapterContext as Record<string, unknown>).conversationId =
        conversationId;
    }
    propagateAdapterContextMetadataFields(adapterContext, metadata, [
      "clockDaemonId",
      "tmuxSessionId",
      "clientType",
      "clockClientType",
      "clientInjectReady",
      "cwd",
    ]);
    const clientConnectionState = (metadata as Record<string, unknown>)
      .clientConnectionState;
    if (
      clientConnectionState &&
      typeof clientConnectionState === "object" &&
      !Array.isArray(clientConnectionState)
    ) {
      const stateRecord = clientConnectionState as { disconnected?: unknown };
      (adapterContext as Record<string, unknown>).clientConnectionState =
        clientConnectionState;
      if (typeof stateRecord.disconnected === "boolean") {
        (adapterContext as Record<string, unknown>).clientDisconnected =
          stateRecord.disconnected;
      }
    }
    const clientDisconnectedRaw = (metadata as Record<string, unknown>)
      .clientDisconnected;
    if (
      clientDisconnectedRaw === true ||
      (typeof clientDisconnectedRaw === "string" &&
        clientDisconnectedRaw.trim().toLowerCase() === "true")
    ) {
      (adapterContext as Record<string, unknown>).clientDisconnected = true;
    }
    if (
      target?.compatibilityProfile &&
      typeof target.compatibilityProfile === "string"
    ) {
      (adapterContext as Record<string, unknown>).compatibilityProfile =
        target.compatibilityProfile;
    }
    return adapterContext;
  }

  private applyMaxTokensPolicy(
    request: StandardizedRequest | ProcessedRequest,
    target?: TargetMetadata,
  ): void {
    if (!target) {
      return;
    }
    const params = request.parameters || (request.parameters = {});
    const direct =
      typeof params.max_tokens === "number" &&
      Number.isFinite(params.max_tokens)
        ? Math.floor(params.max_tokens)
        : undefined;
    const maxOutputRaw =
      typeof (params as Record<string, unknown>).max_output_tokens ===
        "number" &&
      Number.isFinite(
        (params as Record<string, unknown>).max_output_tokens as number,
      )
        ? Math.floor(
            (params as Record<string, unknown>).max_output_tokens as number,
          )
        : undefined;
    const requested = direct ?? maxOutputRaw;
    let configuredDefault =
      typeof target.maxOutputTokens === "number" &&
      Number.isFinite(target.maxOutputTokens)
        ? Math.floor(target.maxOutputTokens)
        : undefined;
    if (!configuredDefault) {
      const registry = (
        this.routerEngine as unknown as {
          providerRegistry?: { get?: (key: string) => any };
        }
      ).providerRegistry;
      const profile = registry?.get?.(target.providerKey);
      const candidate =
        typeof profile?.maxOutputTokens === "number" &&
        Number.isFinite(profile.maxOutputTokens)
          ? Math.floor(profile.maxOutputTokens)
          : undefined;
      if (candidate && candidate > 0) {
        configuredDefault = candidate;
      }
    }

    const desired = requested && requested > 0 ? requested : configuredDefault;

    if (desired && desired > 0) {
      params.max_tokens = desired;
      if ((params as Record<string, unknown>).max_output_tokens !== undefined) {
        (params as Record<string, unknown>).max_output_tokens = desired;
      }
    }
  }

  private maybeCreateStageRecorder(
    context: AdapterContext,
    endpoint?: string,
    options?: { disableSnapshots?: boolean },
  ): StageRecorder | undefined {
    if (options?.disableSnapshots === true) {
      return undefined;
    }
    if (!shouldRecordSnapshots()) {
      return undefined;
    }
    const effectiveEndpoint =
      endpoint || context.entryEndpoint || "/v1/chat/completions";
    try {
      return createSnapshotRecorder(context, effectiveEndpoint);
    } catch {
      return undefined;
    }
  }

  private asJsonObject(value: Record<string, unknown>): JsonObject {
    if (!value || typeof value !== "object") {
      throw new Error("Responses pipeline requires JSON object payload");
    }
    return value as JsonObject;
  }

  private async normalizeRequest(
    request: HubPipelineRequest,
  ): Promise<NormalizedRequest> {
    if (!request || typeof request !== "object") {
      throw new Error("HubPipeline requires request payload");
    }
    const id = request.id || `req_${Date.now()}`;
    const endpoint = normalizeEndpoint(request.endpoint);
    const metadataRecord: Record<string, unknown> = {
      ...(request.metadata ?? {}),
    };
    const policyOverride = extractHubPolicyOverride(metadataRecord);
    if (
      Object.prototype.hasOwnProperty.call(
        metadataRecord,
        "__hubPolicyOverride",
      )
    ) {
      delete (metadataRecord as Record<string, unknown>).__hubPolicyOverride;
    }
    const shadowCompare = extractHubShadowCompareConfig(metadataRecord);
    if (
      Object.prototype.hasOwnProperty.call(metadataRecord, "__hubShadowCompare")
    ) {
      delete (metadataRecord as Record<string, unknown>).__hubShadowCompare;
    }
    const disableSnapshots = metadataRecord.__disableHubSnapshots === true;
    if (
      Object.prototype.hasOwnProperty.call(
        metadataRecord,
        "__disableHubSnapshots",
      )
    ) {
      delete (metadataRecord as Record<string, unknown>).__disableHubSnapshots;
    }
    const hubEntryRaw =
      typeof (metadataRecord as Record<string, unknown>).__hubEntry === "string"
        ? String((metadataRecord as Record<string, unknown>).__hubEntry)
            .trim()
            .toLowerCase()
        : "";
    const hubEntryMode: NormalizedRequest["hubEntryMode"] =
      hubEntryRaw === "chat_process" ||
      hubEntryRaw === "chat-process" ||
      hubEntryRaw === "chatprocess"
        ? "chat_process"
        : undefined;
    if (Object.prototype.hasOwnProperty.call(metadataRecord, "__hubEntry")) {
      delete (metadataRecord as Record<string, unknown>).__hubEntry;
    }
    const entryEndpoint =
      typeof metadataRecord.entryEndpoint === "string"
        ? normalizeEndpoint(metadataRecord.entryEndpoint)
        : endpoint;
    const providerProtocol = resolveProviderProtocol(
      metadataRecord.providerProtocol,
    );
    const processMode =
      metadataRecord.processMode === "passthrough" ? "passthrough" : "chat";
    const direction =
      metadataRecord.direction === "response" ? "response" : "request";
    const stage = metadataRecord.stage === "outbound" ? "outbound" : "inbound";
    const resolvedReadable = this.unwrapReadable(request.payload);
    const stream = Boolean(
      metadataRecord.stream ||
      resolvedReadable ||
      (request.payload &&
        typeof request.payload === "object" &&
        (request.payload as Record<string, unknown>).stream),
    );

    let payload = await this.materializePayload(
      request.payload,
      {
        requestId: id,
        entryEndpoint,
        providerProtocol,
        metadata: metadataRecord,
      },
      resolvedReadable,
    );

    const routeHint =
      typeof metadataRecord.routeHint === "string"
        ? metadataRecord.routeHint
        : undefined;
    const orchestrationResult = runHubPipelineOrchestrationWithNative({
      requestId: id,
      endpoint,
      entryEndpoint,
      providerProtocol,
      payload,
      metadata: {
        entryEndpoint,
        providerProtocol,
        processMode,
        direction,
        stage,
        stream,
        ...(routeHint ? { routeHint } : {}),
      },
      stream,
      processMode,
      direction,
      stage,
    });
    if (!orchestrationResult.success) {
      const code =
        orchestrationResult.error &&
        typeof orchestrationResult.error.code === "string"
          ? orchestrationResult.error.code.trim()
          : "hub_pipeline_native_failed";
      const message =
        orchestrationResult.error &&
        typeof orchestrationResult.error.message === "string"
          ? orchestrationResult.error.message.trim()
          : "Native hub pipeline orchestration failed";
      throw new Error(`[${code}] ${message}`);
    }
    if (orchestrationResult.payload) {
      payload = orchestrationResult.payload;
    }

    const normalizedMetadata: Record<string, unknown> = {
      ...metadataRecord,
      entryEndpoint,
      providerProtocol,
      processMode,
      direction,
      stage,
      stream,
      ...(routeHint ? { routeHint } : {}),
      ...(orchestrationResult.metadata ?? {}),
    };

    return {
      id,
      endpoint,
      entryEndpoint,
      providerProtocol,
      payload,
      metadata: normalizedMetadata,
      policyOverride: policyOverride ?? undefined,
      shadowCompare: shadowCompare ?? undefined,
      disableSnapshots,
      processMode,
      direction,
      stage,
      stream,
      routeHint,
      ...(hubEntryMode ? { hubEntryMode } : {}),
    };
  }

  private convertProcessNodeResult(
    id: string,
    result: HubProcessNodeResult,
  ): HubPipelineNodeResult {
    return {
      id,
      success: result.success,
      metadata: result.metadata,
      error: result.error
        ? {
            code: result.error.code ?? "hub_chat_process_error",
            message: result.error.message,
            details: result.error.details,
          }
        : undefined,
    };
  }

  private async materializePayload(
    payload:
      | Record<string, unknown>
      | { readable?: Readable }
      | Readable
      | undefined,
    context: PayloadNormalizationContext,
    resolvedStream?: Readable | null,
  ): Promise<Record<string, unknown>> {
    const stream = resolvedStream ?? this.unwrapReadable(payload);
    if (stream) {
      return await this.convertSsePayload(stream, context);
    }
    if (!payload || typeof payload !== "object") {
      throw new Error("HubPipeline requires JSON object payload");
    }
    return payload as Record<string, unknown>;
  }

  private unwrapReadable(
    payload:
      | Record<string, unknown>
      | { readable?: Readable }
      | Readable
      | undefined,
  ): Readable | null {
    if (!payload) {
      return null;
    }
    if (payload instanceof Readable) {
      return payload;
    }
    if (payload && typeof payload === "object" && "readable" in payload) {
      const candidate = (payload as Record<string, unknown>).readable;
      if (candidate instanceof Readable) {
        return candidate;
      }
    }
    return null;
  }

  private async convertSsePayload(
    stream: Readable,
    context: PayloadNormalizationContext,
  ): Promise<Record<string, unknown>> {
    const protocol = this.resolveSseProtocol(context);
    const codec = defaultSseCodecRegistry.get(protocol);
    try {
      const result = await codec.convertSseToJson(stream, {
        requestId: context.requestId,
        model: this.extractModelHint(context.metadata),
        direction: "request",
      });
      if (!result || typeof result !== "object") {
        throw new Error("SSE conversion returned empty payload");
      }
      return result as Record<string, unknown>;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error ?? "Unknown error");
      throw new Error(
        `Failed to convert SSE payload for protocol ${protocol}: ${message}`,
      );
    }
  }

  private resolveSseProtocol(
    context: PayloadNormalizationContext,
  ): SseProtocol {
    const explicitProtocol = resolveSseProtocolFromMetadata(context.metadata);
    if (explicitProtocol) {
      return explicitProtocol;
    }
    return context.providerProtocol;
  }

  private extractModelHint(
    metadata: Record<string, unknown>,
  ): string | undefined {
    if (typeof metadata.model === "string" && metadata.model.trim()) {
      return metadata.model;
    }
    const provider = metadata.provider as Record<string, unknown> | undefined;
    const candidates = [
      provider?.model,
      provider?.modelId,
      provider?.defaultModel,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate;
      }
    }
    return undefined;
  }

  private resolveOutboundStreamIntent(
    providerPreference?: TargetMetadata["streaming"],
  ): boolean | undefined {
    return resolveOutboundStreamIntentWithNative(providerPreference);
  }

  private applyOutboundStreamPreference(
    request: StandardizedRequest | ProcessedRequest,
    stream: boolean | undefined,
    processMode?: "chat" | "passthrough",
  ): StandardizedRequest | ProcessedRequest {
    if (!request || typeof request !== "object") {
      return request;
    }
    return applyOutboundStreamPreferenceWithNative(
      request as unknown as Record<string, unknown>,
      stream,
      processMode,
    ) as unknown as StandardizedRequest | ProcessedRequest;
  }
}

function normalizeEndpoint(endpoint: string): string {
  return normalizeHubEndpointWithNative(endpoint);
}

interface PayloadNormalizationContext {
  requestId: string;
  entryEndpoint: string;
  providerProtocol: ProviderProtocol;
  metadata: Record<string, unknown>;
}

function resolveProviderProtocol(value: unknown): ProviderProtocol {
  try {
    const normalized = resolveHubProviderProtocolWithNative(value);
    if (
      normalized === "openai-chat" ||
      normalized === "openai-responses" ||
      normalized === "anthropic-messages" ||
      normalized === "gemini-chat"
    ) {
      return normalized;
    }
  } catch {
    // Keep legacy caller-facing error shape below.
  }
  throw new Error(
    `[HubPipeline] Unsupported providerProtocol "${value}". Configure a valid protocol (openai-chat|openai-responses|anthropic-messages|gemini-chat).`,
  );
}

function resolveSseProtocolFromMetadata(
  metadata: Record<string, unknown>,
): SseProtocol | undefined {
  const resolved = resolveHubSseProtocolFromMetadataWithNative(metadata);
  if (!resolved) {
    return undefined;
  }
  return resolveProviderProtocol(resolved);
}

function coerceAliasMap(
  candidate: unknown,
): Record<string, string> | undefined {
  return normalizeAliasMapWithNative(candidate);
}

function readAliasMapFromSemantics(
  chatEnvelope: ChatEnvelope,
): Record<string, string> | undefined {
  if (
    !chatEnvelope?.semantics ||
    typeof chatEnvelope.semantics !== "object" ||
    Array.isArray(chatEnvelope.semantics)
  ) {
    return undefined;
  }
  return resolveAliasMapFromRespSemanticsWithNative(chatEnvelope.semantics);
}

function assertNoMappableSemanticsInMetadata(
  metadata: Record<string, unknown> | undefined,
  scope: string,
): void {
  if (!metadata || typeof metadata !== "object") {
    return;
  }
  const present = findMappableSemanticsKeysWithNative(metadata);
  if (present.length) {
    throw new Error(
      `[HubPipeline][semantic_gate] Mappable semantics must not be stored in metadata (${scope}): ${present.join(", ")}`,
    );
  }
}
