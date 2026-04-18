import type { JsonObject } from "../types/json.js";
import type { ProcessedRequest, StandardizedRequest } from "../types/standardized.js";
import type { VirtualRouterEngine } from "../../../router/virtual-router/engine.js";
import type { StageRecorder } from "../format-adapters/index.js";
import type { RouterMetadataInput } from "../../../router/virtual-router/types.js";
import type {
  HubPipelineConfig,
  HubPipelineNodeResult,
  HubPipelineResult,
  NormalizedRequest,
} from "./hub-pipeline.js";
import type { RequestStageHooks } from "./hub-pipeline-stage-hooks.js";
import { runReqProcessStage2RouteSelect } from "./stages/req_process/req_process_stage2_route_select/index.js";
import { buildAdapterContextFromNormalized } from "./hub-pipeline-adapter-context.js";
import { extractSessionIdentifiersFromMetadata } from "./session-identifiers.js";
import { applyMaxTokensPolicyForRequest } from "./hub-pipeline-request-normalization-utils.js";
import { buildRequestStageProviderPayload } from "./hub-pipeline-execute-request-stage-provider-payload.js";
import { logHubStageTiming } from "./hub-stage-timing.js";
import type { HubPolicyConfig } from "../policy/policy-engine.js";
import { shouldRecordSnapshots } from "../../snapshot-utils.js";
import { createSnapshotRecorder } from "../snapshot-recorder.js";
import {
  applyOutboundStreamPreferenceWithNative,
  applyHasImageAttachmentFlagWithNative,
  buildCapturedChatRequestSnapshotWithNative,
  buildHubPipelineResultMetadataWithNative,
  buildReqOutboundNodeResultWithNative,
  buildRouterMetadataInputWithNative,
  resolveOutboundStreamIntentWithNative,
  syncSessionIdentifiersToMetadataWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { buildCapturedChatRequestInput } from "./hub-pipeline-heavy-input-fastpath.js";

type ShadowCompareBaselineMode =
  NormalizedRequest["shadowCompare"] extends { baselineMode: infer T }
    ? T
    : never;

function isCapturedChatRequestShapeValid(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const hasMessages = Array.isArray(record.messages);
  const hasInput = Object.prototype.hasOwnProperty.call(record, "input") && record.input !== undefined;
  return hasMessages || hasInput;
}

export async function executeRouteAndBuildOutbound<TContext = Record<string, unknown>>(args: {
  normalized: NormalizedRequest;
  hooks: RequestStageHooks<TContext>;
  routerEngine: VirtualRouterEngine;
  config: HubPipelineConfig;
  workingRequest: StandardizedRequest | ProcessedRequest;
  nodeResults: HubPipelineNodeResult[];
  inboundRecorder?: StageRecorder;
  activeProcessMode: "chat" | "passthrough";
  serverToolRequired: boolean;
  hasImageAttachment: boolean;
  passthroughAudit?: Record<string, unknown>;
  rawRequest: JsonObject;
  contextSnapshot?: Record<string, unknown>;
  semanticMapper: ReturnType<RequestStageHooks<TContext>["createSemanticMapper"]>;
  effectivePolicy?: HubPolicyConfig;
  shadowCompareBaselineMode?: ShadowCompareBaselineMode;
  routeSelectTiming?: {
    enabled?: boolean;
    requestId?: string;
  };
}): Promise<{
  providerPayload?: Record<string, unknown>;
  metadata: Record<string, unknown>;
  routingDecision?: HubPipelineResult["routingDecision"];
  routingDiagnostics?: HubPipelineResult["routingDiagnostics"];
  target?: HubPipelineResult["target"];
  workingRequest: StandardizedRequest | ProcessedRequest;
}> {
  const {
    normalized,
    hooks,
    routerEngine,
    config,
    nodeResults,
    inboundRecorder,
    activeProcessMode,
    serverToolRequired,
    hasImageAttachment,
    passthroughAudit,
    rawRequest,
    contextSnapshot,
    semanticMapper,
    effectivePolicy,
    shadowCompareBaselineMode,
    routeSelectTiming,
  } = args;
  let { workingRequest } = args;

  const sessionIdentifiers = extractSessionIdentifiersFromMetadata(
    normalized.metadata as Record<string, unknown> | undefined,
  );

  // 将从 metadata / clientHeaders 中解析出的会话标识同步回 normalized.metadata，
  // 便于后续 AdapterContext（响应侧 servertool）也能访问到相同的 sessionId /
  // conversationId，用于 sticky-session 相关逻辑（例如 stopMessage）。
  const normalizedMetadata =
    normalized.metadata as Record<string, unknown> | undefined;
  const routeRuntimeDirectives =
    normalizedMetadata &&
    typeof normalizedMetadata.__rt === "object" &&
    !Array.isArray(normalizedMetadata.__rt)
      ? (normalizedMetadata.__rt as Record<string, unknown>)
      : undefined;
  if (normalizedMetadata && typeof normalizedMetadata === "object") {
    const next = syncSessionIdentifiersToMetadataWithNative({
      metadata: normalizedMetadata,
      sessionId: sessionIdentifiers.sessionId,
      conversationId: sessionIdentifiers.conversationId,
    });
    for (const key of Object.keys(normalizedMetadata)) {
      delete normalizedMetadata[key];
    }
    Object.assign(normalizedMetadata, next);
  }

  const metadataInput = buildRouterMetadataInputWithNative({
    requestId: normalized.id,
    entryEndpoint: normalized.entryEndpoint,
    processMode: normalized.processMode,
    stream: normalized.stream,
    direction: normalized.direction,
    providerProtocol: normalized.providerProtocol,
    routeHint: normalized.routeHint,
    stage: normalized.stage,
    requestSemantics: (workingRequest as { semantics?: Record<string, unknown> }).semantics,
    includeEstimatedInputTokens: true,
    serverToolRequired: serverToolRequired === true,
    sessionId: sessionIdentifiers.sessionId,
    conversationId: sessionIdentifiers.conversationId,
    metadata: normalizedMetadata,
  }) as unknown as RouterMetadataInput;
  if (routeRuntimeDirectives) {
    (metadataInput as unknown as Record<string, unknown>).__rt = {
      ...routeRuntimeDirectives,
    };
  }

  if (routeSelectTiming?.enabled) {
    logHubStageTiming(
      routeSelectTiming.requestId ?? normalized.id,
      "req_process.stage2_route_select",
      "start",
    );
  }
  const routing = runReqProcessStage2RouteSelect({
    routerEngine,
    request: workingRequest,
    metadataInput,
    normalizedMetadata: normalized.metadata,
    stageRecorder: inboundRecorder,
  });
  if (routeSelectTiming?.enabled) {
    logHubStageTiming(
      routeSelectTiming.requestId ?? normalized.id,
      "req_process.stage2_route_select",
      "completed",
    );
  }

  // Emit virtual router hit log for debugging (orange [virtual-router] ...)
  try {
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
      routeRuntimeDirectives?.disableVirtualRouterHitLog !== true &&
      logger &&
      typeof logger.logVirtualRouterHit === "function" &&
      routing.decision?.routeName &&
      routing.target?.providerKey
    ) {
      logger.logVirtualRouterHit(
        routing.decision.routeName,
        routing.target.providerKey,
        typeof workingRequest.model === "string"
          ? workingRequest.model
          : undefined,
        typeof sessionIdentifiers.sessionId === "string"
          ? sessionIdentifiers.sessionId
          : undefined,
      );
    }
  } catch {
    // logging must not break routing
  }

  const outboundStream = resolveOutboundStreamIntentWithNative(
    routing.target?.streaming,
  );
  workingRequest = applyOutboundStreamPreferenceWithNative(
    workingRequest as unknown as Record<string, unknown>,
    outboundStream,
    activeProcessMode,
  ) as unknown as StandardizedRequest | ProcessedRequest;
  applyMaxTokensPolicyForRequest(workingRequest, routing.target, routerEngine);

  const outboundAdapterContext = buildAdapterContextFromNormalized(
    normalized,
    routing.target,
  );
  if (routing.target?.compatibilityProfile) {
    outboundAdapterContext.compatibilityProfile =
      routing.target.compatibilityProfile;
  }
  const outboundProtocol = String(
    outboundAdapterContext.providerProtocol || "",
  ) as NormalizedRequest["providerProtocol"];
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
  const outboundRecorder = (() => {
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
      outboundAdapterContext.entryEndpoint ||
      "/v1/chat/completions";
    try {
      return createSnapshotRecorder(outboundAdapterContext, effectiveEndpoint);
    } catch {
      return undefined;
    }
  })();
  const outboundStart = Date.now();

  const { providerPayload, shadowBaselineProviderPayload } =
    await buildRequestStageProviderPayload({
      normalized,
      hooks,
      config,
      workingRequest,
      rawRequest,
      contextSnapshot,
      activeProcessMode,
      passthroughAudit,
      outboundProtocol,
      outboundAdapterContext: outboundAdapterContext as Record<string, unknown>,
      outboundStream,
      outboundRecorder,
      semanticMapper,
      effectivePolicy,
      shadowCompareBaselineMode,
    });

  const outboundEnd = Date.now();
  nodeResults.push(
    buildReqOutboundNodeResultWithNative({
      outboundStart,
      outboundEnd,
      messages: workingRequest.messages.length,
      tools: workingRequest.tools?.length ?? 0,
    }) as unknown as HubPipelineNodeResult,
  );

  // 为响应侧 servertool/web_search 提供一次性 Chat 请求快照，便于在 Hub 内部实现
  // 第三跳（将工具结果注入消息历史后重新调用主模型）。
  //
  // 注意：这里不再根据 processMode(passthrough/chat) 做分支判断——即使某些
  // route 将 processMode 标记为 passthrough，我们仍然需要保留一次规范化后的
  // Chat 请求快照，供 stopMessage 等被动触发型 servertool 在响应阶段使用。
  const capturedChatRequest = buildCapturedChatRequestSnapshotWithNative(
    buildCapturedChatRequestInput({
      workingRequest,
      normalizedMetadata:
        normalized.metadata as Record<string, unknown> | undefined,
    }),
  );
  if (!isCapturedChatRequestShapeValid(capturedChatRequest)) {
    throw Object.assign(
      new Error(
        "[HubPipeline] capturedChatRequest must be chat-like (messages or input) for response-side servertool.",
      ),
      {
        code: "ERR_CAPTURED_CHAT_REQUEST_INVALID",
        requestId: normalized.id,
        processMode: activeProcessMode,
        entryEndpoint: normalized.entryEndpoint,
      },
    );
  }

  const metadata = buildHubPipelineResultMetadataWithNative({
    normalized: {
      metadata: normalized.metadata,
      entryEndpoint: normalized.entryEndpoint,
      stream: normalized.stream,
      processMode: normalized.processMode,
      routeHint: normalized.routeHint,
    },
    outboundProtocol,
    target: routing.target,
    outboundStream,
    capturedChatRequest,
    passthroughAudit,
    shadowCompareBaselineMode,
    effectivePolicy: effectivePolicy
      ? { mode: effectivePolicy.mode ?? "off" }
      : undefined,
    shadowBaselineProviderPayload,
  });

  const metadataWithImageFlag = applyHasImageAttachmentFlagWithNative({
    metadata,
    hasImageAttachment,
  });
  for (const key of Object.keys(metadata)) {
    delete metadata[key];
  }
  Object.assign(metadata, metadataWithImageFlag);

  return {
    providerPayload,
    metadata,
    routingDecision: routing.decision,
    routingDiagnostics: routing.diagnostics,
    target: routing.target,
    workingRequest,
  };
}
