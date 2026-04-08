import { Readable } from "node:stream";
import type {
  StandardizedMessage,
  StandardizedRequest,
  ProcessedRequest,
} from "../types/standardized.js";
import type { JsonObject, JsonValue } from "../types/json.js";
import { isJsonObject, jsonClone } from "../types/json.js";
import type { AdapterContext, ChatEnvelope } from "../types/chat-envelope.js";
import type { FormatEnvelope } from "../types/format-envelope.js";
import type {
  StageRecorder,
} from "../format-adapters/index.js";
import { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";
import { providerErrorCenter } from "../../../router/virtual-router/error-center.js";
import { providerSuccessCenter } from "../../../router/virtual-router/success-center.js";
import type {
  VirtualRouterConfig,
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
import { runReqInboundStage1FormatParse } from "./stages/req_inbound/req_inbound_stage1_format_parse/index.js";
import { runReqInboundStage2SemanticMap } from "./stages/req_inbound/req_inbound_stage2_semantic_map/index.js";
import { writeCacheEntryForRequest } from "./stages/req_inbound/req_inbound_stage3_context_capture/cache-write.js";
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
  resolveApplyPatchToolModeFromEnvWithNative,
  resolveApplyPatchToolModeFromToolsWithNative,
  resolveHubClientProtocolWithNative,
  resolveActiveProcessModeWithNative,
  readResponsesResumeFromMetadataWithNative,
  readResponsesResumeFromRequestSemanticsWithNative,
  applyDirectBuiltinWebSearchToolWithNative,
  liftResponsesResumeIntoSemanticsWithNative,
  syncResponsesContextFromCanonicalMessagesWithNative,
  findMappableSemanticsKeysWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
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
import {
  REQUEST_STAGE_HOOKS,
  type RequestStageHooks,
} from "./hub-pipeline-stage-hooks.js";
import { executeRequestStagePipeline } from "./hub-pipeline-execute-request-stage.js";
import { executeChatProcessEntryPipeline } from "./hub-pipeline-execute-chat-process-entry.js";
import { buildAdapterContextFromNormalized } from "./hub-pipeline-adapter-context.js";
import {
  applyMaxTokensPolicyForRequest,
} from "./hub-pipeline-request-normalization-utils.js";
import { normalizeHubPipelineRequest } from "./hub-pipeline-normalize-request.js";
type ApplyPatchToolMode = "schema" | "freeform";

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function logHubPipelineNonBlockingError(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  try {
    const suffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[hub-pipeline] ${stage} failed (non-blocking): ${formatUnknownError(error)}${suffix}`);
  } catch {
    void 0;
  }
}

export type HubShadowCompareRequestConfig = {
  baselineMode: HubPolicyMode;
};

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

export type ProviderProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "gemini-chat";

export interface NormalizedRequest {
  id: string;
  endpoint: string;
  entryEndpoint: string;
  providerProtocol: ProviderProtocol;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  policyOverride?: HubPolicyConfig;
  shadowCompare?: HubShadowCompareRequestConfig;
  disableSnapshots?: boolean;
  externalStageRecorder?: StageRecorder;
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

// Test-only seam: keep clock/session scope regression script independent from class internals.
export function __unsafeBuildAdapterContextForTest(
  normalized: NormalizedRequest,
  target?: TargetMetadata,
): AdapterContext {
  return buildAdapterContextFromNormalized(normalized, target);
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
          } catch (subscriberError) {
            logHubPipelineNonBlockingError('providerErrorCenter.handleProviderError', subscriberError);
          }
        },
      );
    } catch (subscribeError) {
      logHubPipelineNonBlockingError('providerErrorCenter.subscribe', subscribeError);
      this.unsubscribeProviderErrors = undefined;
    }
    try {
      this.unsubscribeProviderSuccess = providerSuccessCenter.subscribe(
        (event) => {
          try {
            this.routerEngine.handleProviderSuccess(event);
          } catch (subscriberError) {
            logHubPipelineNonBlockingError('providerSuccessCenter.handleProviderSuccess', subscriberError);
          }
        },
      );
    } catch (subscribeError) {
      logHubPipelineNonBlockingError('providerSuccessCenter.subscribe', subscribeError);
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
    } catch (updateDepsError) {
      logHubPipelineNonBlockingError('updateRuntimeDeps.routerEngine.updateDeps', updateDepsError);
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
      } catch (disposeError) {
        logHubPipelineNonBlockingError('dispose.unsubscribeProviderErrors', disposeError);
      }
      this.unsubscribeProviderErrors = undefined;
    }
    if (this.unsubscribeProviderSuccess) {
      try {
        this.unsubscribeProviderSuccess();
      } catch (disposeError) {
        logHubPipelineNonBlockingError('dispose.unsubscribeProviderSuccess', disposeError);
      }
      this.unsubscribeProviderSuccess = undefined;
    }
  }

  async execute(request: HubPipelineRequest): Promise<HubPipelineResult> {
    const normalized = await normalizeHubPipelineRequest(request);
    clearHubStageTiming(normalized.id);
    try {
      if (
        normalized.direction === "request" &&
        normalized.hubEntryMode === "chat_process"
      ) {
        return await executeChatProcessEntryPipeline({
          normalized,
          routerEngine: this.routerEngine,
          config: this.config,
        });
      }
      const hooks = REQUEST_STAGE_HOOKS[normalized.providerProtocol];
      if (!hooks) {
        throw new Error(
          `Unsupported provider protocol for hub pipeline: ${normalized.providerProtocol}`,
        );
      }
      return await executeRequestStagePipeline({
        normalized,
        hooks: hooks as RequestStageHooks<Record<string, unknown>>,
        routerEngine: this.routerEngine,
        config: this.config,
      });
    } finally {
      clearHubStageTiming(normalized.id);
    }
  }

}
