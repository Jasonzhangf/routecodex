import type { AdapterContext } from "../types/chat-envelope.js";
import type { TargetMetadata } from "../../../router/virtual-router/types.js";
import { normalizeReqInboundToolCallIdStyleWithNative } from "../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js";
import {
  extractAdapterContextMetadataFieldsWithNative,
  resolveAdapterContextMetadataSignalsWithNative,
  resolveAdapterContextObjectCarriersWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { cloneRuntimeMetadata } from "../../runtime-metadata.js";
import { isJsonObject, jsonClone, type JsonObject, type JsonValue } from "../types/json.js";
import { saveOriginSnapshot } from "../../../servertool/origin-request-store.js";
import { resolveServertoolPersistentScopeKey } from "../../../servertool/state-scope.js";



function applyMetadataAdapterContextFields(args: {
  adapterContext: AdapterContext;
  metadata: Record<string, unknown>;
}): void {
  const { adapterContext, metadata } = args;
  const adapterObjectCarriers = resolveAdapterContextObjectCarriersWithNative(metadata);
  if (adapterObjectCarriers.runtime) (adapterContext as Record<string, unknown>).runtime = adapterObjectCarriers.runtime;
  const adapterMetadataSignals = resolveAdapterContextMetadataSignalsWithNative(metadata);
  if (typeof adapterMetadataSignals.clientRequestId === "string") (adapterContext as Record<string, unknown>).clientRequestId = adapterMetadataSignals.clientRequestId;
  if (typeof adapterMetadataSignals.groupRequestId === "string") (adapterContext as Record<string, unknown>).groupRequestId = adapterMetadataSignals.groupRequestId;
  if (typeof adapterMetadataSignals.originalModelId === "string") adapterContext.originalModelId = adapterMetadataSignals.originalModelId;
  if (typeof adapterMetadataSignals.clientModelId === "string") adapterContext.clientModelId = adapterMetadataSignals.clientModelId;
  if (typeof adapterMetadataSignals.modelId === "string") (adapterContext as Record<string, unknown>).modelId = adapterMetadataSignals.modelId;
  if (typeof adapterMetadataSignals.estimatedInputTokens === "number") (adapterContext as Record<string, unknown>).estimatedInputTokens = adapterMetadataSignals.estimatedInputTokens;
  const rt = cloneRuntimeMetadata(metadata);
  if (rt) {
    const existingRt = (adapterContext as Record<string, unknown>).__rt;
    const preservedRt = isJsonObject(existingRt as JsonValue | undefined) ? (existingRt as Record<string, unknown>) : undefined;
    (adapterContext as Record<string, unknown>).__rt = { ...rt, ...preservedRt } as unknown;
  }
  if (adapterObjectCarriers.capturedChatRequest) {
    (adapterContext as Record<string, unknown>).capturedChatRequest = adapterObjectCarriers.capturedChatRequest;
    const scope = resolveServertoolPersistentScopeKey(adapterContext);
    if (scope && adapterObjectCarriers.capturedChatRequest) {
      const captured = adapterObjectCarriers.capturedChatRequest as Record<string, unknown>;
      const capturedMessages = Array.isArray(captured.messages) ? (captured.messages as unknown[]) : [];
      saveOriginSnapshot(scope, { requestId: adapterContext.requestId ?? String(Date.now()), sessionScope: scope, capturedChatRequest: captured as any, model: captured?.model as string | undefined, messages: capturedMessages as any, tools: (((captured?.tools as unknown[]) ?? []) as any), parameters: ((captured?.parameters as Record<string, unknown>) ?? undefined) as any, entryEndpoint: adapterContext.entryEndpoint, providerProtocol: adapterContext.providerProtocol });
    }
  }
  if (typeof adapterMetadataSignals.sessionId === "string") (adapterContext as Record<string, unknown>).sessionId = adapterMetadataSignals.sessionId;
  if (typeof adapterMetadataSignals.conversationId === "string") (adapterContext as Record<string, unknown>).conversationId = adapterMetadataSignals.conversationId;
  Object.assign(adapterContext as Record<string, unknown>, extractAdapterContextMetadataFieldsWithNative(metadata, ["clockDaemonId","tmuxSessionId","clientType","clockClientType","clientInjectReady","cwd","workdir","clientWorkdir"]));
  if (adapterObjectCarriers.clientConnectionState) (adapterContext as Record<string, unknown>).clientConnectionState = adapterObjectCarriers.clientConnectionState;
  if (typeof adapterObjectCarriers.clientDisconnected === "boolean") (adapterContext as Record<string, unknown>).clientDisconnected = adapterObjectCarriers.clientDisconnected;
}

function applyTargetAdapterContextFields(args: { adapterContext: AdapterContext; target?: TargetMetadata; }): void {
  const { adapterContext, target } = args;
  const targetDeepseek = isJsonObject(target?.deepseek as JsonValue | undefined) ? (jsonClone(target!.deepseek as JsonValue) as JsonObject) : undefined;
  if (targetDeepseek) {
    (adapterContext as Record<string, unknown>).deepseek = targetDeepseek;
    const rtCarrier = isJsonObject((adapterContext as Record<string, unknown>).__rt as JsonValue | undefined) ? ({ ...((adapterContext as Record<string, unknown>).__rt as Record<string, unknown>) } as Record<string, unknown>) : {};
    rtCarrier.deepseek = targetDeepseek as unknown as JsonValue;
    (adapterContext as Record<string, unknown>).__rt = rtCarrier as unknown as JsonValue;
  }
  if (typeof target?.anthropicThinking === "string" && target.anthropicThinking.trim()) (adapterContext as Record<string, unknown>).anthropicThinking = target.anthropicThinking.trim().toLowerCase();
  if (target?.anthropicThinkingConfig && typeof target.anthropicThinkingConfig === "object" && !Array.isArray(target.anthropicThinkingConfig)) (adapterContext as Record<string, unknown>).anthropicThinkingConfig = jsonClone(target.anthropicThinkingConfig as any);
  if (target?.anthropicThinkingBudgets && typeof target.anthropicThinkingBudgets === "object" && !Array.isArray(target.anthropicThinkingBudgets)) (adapterContext as Record<string, unknown>).anthropicThinkingBudgets = jsonClone(target.anthropicThinkingBudgets as any);
  if (target?.compatibilityProfile && typeof target.compatibilityProfile === "string") (adapterContext as Record<string, unknown>).compatibilityProfile = target.compatibilityProfile;
  if (typeof target?.supportsMultimodal === "boolean") {
    const rtCarrier = isJsonObject((adapterContext as Record<string, unknown>).__rt as JsonValue | undefined) ? ({ ...((adapterContext as Record<string, unknown>).__rt as Record<string, unknown>) } as Record<string, unknown>) : {};
    rtCarrier.supportsMultimodal = target.supportsMultimodal;
    (adapterContext as Record<string, unknown>).__rt = rtCarrier as unknown as JsonValue;
  }
}
export interface HubPipelineAdapterContextRequestLike {
  id: string;
  entryEndpoint: string;
  providerProtocol: string;
  stream: boolean;
  metadata: Record<string, unknown>;
}

export function buildAdapterContextFromNormalized(
  normalized: HubPipelineAdapterContextRequestLike,
  target?: TargetMetadata,
): AdapterContext {
  const metadata = normalized.metadata || {};
  const providerProtocol =
    (target?.outboundProfile as string | undefined) ||
    normalized.providerProtocol;
  const providerKey = (target?.providerKey || metadata.providerKey) as
    | string
    | undefined;
  const providerId = providerKey as
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
      ? String((metadata as Record<string, unknown>).compatibilityProfile).trim()
      : undefined;
  const compatibilityProfile = target ? targetCompatProfile : metadataCompatProfile;
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
    ...(providerKey ? { providerKey, targetProviderKey: providerKey } : {}),
    routeId,
    profileId,
    streamingHint,
    toolCallIdStyle,
    ...(compatibilityProfile ? { compatibilityProfile } : {}),
  };
  applyTargetAdapterContextFields({ adapterContext, target });
  applyMetadataAdapterContextFields({
    adapterContext,
    metadata: metadata as Record<string, unknown>,
  });
  return adapterContext;
}
