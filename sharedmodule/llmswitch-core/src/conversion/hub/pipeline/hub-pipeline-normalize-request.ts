import type { StageRecorder } from "../format-adapters/index.js";
import type { HubPolicyConfig } from "../policy/policy-engine.js";
import {
  normalizeHubEndpointWithNative,
  resolveHubPolicyOverrideFromMetadataWithNative,
  resolveHubProviderProtocolWithNative,
  resolveHubShadowCompareConfigWithNative,
  runHubPipelineOrchestrationWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import {
  resolveReadablePayload,
  materializePayloadRecord,
} from "./hub-pipeline-request-normalization-utils.js";
import type {
  HubPipelineRequest,
  HubShadowCompareRequestConfig,
  NormalizedRequest,
  ProviderProtocol,
} from "./hub-pipeline.js";

export async function normalizeHubPipelineRequest(
  request: HubPipelineRequest,
): Promise<NormalizedRequest> {
  if (!request || typeof request !== "object") {
    throw new Error("HubPipeline requires request payload");
  }
  const resolveProviderProtocolOrThrow = (value: unknown): ProviderProtocol => {
    try {
      return resolveHubProviderProtocolWithNative(value) as ProviderProtocol;
    } catch {
      // Keep legacy caller-facing error shape below.
    }
    throw new Error(
      `[HubPipeline] Unsupported providerProtocol "${value}". Configure a valid protocol (openai-chat|openai-responses|anthropic-messages|gemini-chat).`,
    );
  };
  const id = request.id || `req_${Date.now()}`;
  const endpoint = normalizeHubEndpointWithNative(request.endpoint);
  const metadataRecord: Record<string, unknown> = {
    ...(request.metadata ?? {}),
  };
  const policyOverride = resolveHubPolicyOverrideFromMetadataWithNative(
    metadataRecord,
  ) as HubPolicyConfig | undefined;
  if (Object.prototype.hasOwnProperty.call(metadataRecord, "__hubPolicyOverride")) {
    delete (metadataRecord as Record<string, unknown>).__hubPolicyOverride;
  }
  const shadowCompare = resolveHubShadowCompareConfigWithNative(
    metadataRecord,
  ) as HubShadowCompareRequestConfig | undefined;
  if (Object.prototype.hasOwnProperty.call(metadataRecord, "__hubShadowCompare")) {
    delete (metadataRecord as Record<string, unknown>).__hubShadowCompare;
  }
  const disableSnapshots = metadataRecord.__disableHubSnapshots === true;
  if (Object.prototype.hasOwnProperty.call(metadataRecord, "__disableHubSnapshots")) {
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
  const externalStageRecorder =
    (metadataRecord as Record<string, unknown>).__hubStageRecorder &&
    typeof ((metadataRecord as Record<string, unknown>)
      .__hubStageRecorder as StageRecorder).record === "function"
      ? ((metadataRecord as Record<string, unknown>)
          .__hubStageRecorder as StageRecorder)
      : undefined;
  if (Object.prototype.hasOwnProperty.call(metadataRecord, "__hubStageRecorder")) {
    delete (metadataRecord as Record<string, unknown>).__hubStageRecorder;
  }
  const entryEndpoint =
    typeof metadataRecord.entryEndpoint === "string"
      ? normalizeHubEndpointWithNative(metadataRecord.entryEndpoint)
      : endpoint;
  const providerProtocol = resolveProviderProtocolOrThrow(metadataRecord.providerProtocol);
  const processMode = metadataRecord.processMode === "passthrough" ? "passthrough" : "chat";
  const direction = metadataRecord.direction === "response" ? "response" : "request";
  const stage = metadataRecord.stage === "outbound" ? "outbound" : "inbound";
  const resolvedReadable = resolveReadablePayload(request.payload);
  const stream = Boolean(
    metadataRecord.stream ||
      resolvedReadable ||
      (request.payload &&
        typeof request.payload === "object" &&
        (request.payload as Record<string, unknown>).stream),
  );

  let payload = await materializePayloadRecord(
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
    typeof metadataRecord.routeHint === "string" ? metadataRecord.routeHint : undefined;
  const orchestrationResult = runHubPipelineOrchestrationWithNative({
    requestId: id,
    endpoint,
    entryEndpoint,
    providerProtocol,
    payload,
    metadata: {
      ...metadataRecord,
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
      orchestrationResult.error && typeof orchestrationResult.error.code === "string"
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

  const orchestrationMetadata =
    orchestrationResult.metadata &&
    typeof orchestrationResult.metadata === "object" &&
    !Array.isArray(orchestrationResult.metadata)
      ? (orchestrationResult.metadata as Record<string, unknown>)
      : {};
  const normalizedEntryEndpoint =
    typeof orchestrationMetadata.entryEndpoint === "string" &&
    orchestrationMetadata.entryEndpoint.trim().length > 0
      ? normalizeHubEndpointWithNative(orchestrationMetadata.entryEndpoint)
      : entryEndpoint;
  const normalizedProviderProtocol = resolveProviderProtocolOrThrow(
    orchestrationMetadata.providerProtocol,
  );
  const normalizedProcessMode: NormalizedRequest["processMode"] =
    orchestrationMetadata.processMode === "passthrough" ? "passthrough" : "chat";
  const normalizedDirection: NormalizedRequest["direction"] =
    orchestrationMetadata.direction === "response" ? "response" : "request";
  const normalizedStage: NormalizedRequest["stage"] =
    orchestrationMetadata.stage === "outbound" ? "outbound" : "inbound";
  const normalizedStream = Boolean(
    typeof orchestrationMetadata.stream === "boolean"
      ? orchestrationMetadata.stream
      : stream,
  );
  const normalizedRouteHint =
    typeof orchestrationMetadata.routeHint === "string" &&
    orchestrationMetadata.routeHint.trim().length > 0
      ? orchestrationMetadata.routeHint.trim()
      : routeHint;
  const normalizedMetadata: Record<string, unknown> = {
    ...metadataRecord,
    entryEndpoint: normalizedEntryEndpoint,
    providerProtocol: normalizedProviderProtocol,
    processMode: normalizedProcessMode,
    direction: normalizedDirection,
    stage: normalizedStage,
    stream: normalizedStream,
    ...(normalizedRouteHint ? { routeHint: normalizedRouteHint } : {}),
    ...(orchestrationResult.metadata ?? {}),
  };

  return {
    id,
    endpoint,
    entryEndpoint: normalizedEntryEndpoint,
    providerProtocol: normalizedProviderProtocol,
    payload,
    metadata: normalizedMetadata,
    policyOverride: policyOverride ?? undefined,
    shadowCompare: shadowCompare ?? undefined,
    disableSnapshots,
    ...(externalStageRecorder ? { externalStageRecorder } : {}),
    processMode: normalizedProcessMode,
    direction: normalizedDirection,
    stage: normalizedStage,
    stream: normalizedStream,
    routeHint: normalizedRouteHint,
    ...(hubEntryMode ? { hubEntryMode } : {}),
  };
}
