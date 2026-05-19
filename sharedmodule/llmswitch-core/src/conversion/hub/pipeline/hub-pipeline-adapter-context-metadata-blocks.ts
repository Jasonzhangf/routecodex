import type { AdapterContext } from "../types/chat-envelope.js";
import {
  extractAdapterContextMetadataFieldsWithNative,
  resolveAdapterContextMetadataSignalsWithNative,
  resolveAdapterContextObjectCarriersWithNative,
} from "../../../router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics.js";
import { cloneRuntimeMetadata } from "../../runtime-metadata.js";
import { isJsonObject, type JsonValue } from "../types/json.js";
import { saveOriginSnapshot } from "../../../servertool/origin-request-store.js";
import { resolveServertoolPersistentScopeKey } from "../../../servertool/state-scope.js";

export function applyMetadataAdapterContextFields(args: {
  adapterContext: AdapterContext;
  metadata: Record<string, unknown>;
}): void {
  const { adapterContext, metadata } = args;
  const adapterObjectCarriers = resolveAdapterContextObjectCarriersWithNative(
    metadata,
  );
  if (adapterObjectCarriers.runtime) {
    (adapterContext as Record<string, unknown>).runtime =
      adapterObjectCarriers.runtime;
  }
  const adapterMetadataSignals = resolveAdapterContextMetadataSignalsWithNative(
    metadata,
  );
  if (typeof adapterMetadataSignals.clientRequestId === "string") {
    (adapterContext as Record<string, unknown>).clientRequestId =
      adapterMetadataSignals.clientRequestId;
  }
  if (typeof adapterMetadataSignals.groupRequestId === "string") {
    (adapterContext as Record<string, unknown>).groupRequestId =
      adapterMetadataSignals.groupRequestId;
  }
  if (typeof adapterMetadataSignals.originalModelId === "string") {
    adapterContext.originalModelId = adapterMetadataSignals.originalModelId;
  }
  if (typeof adapterMetadataSignals.clientModelId === "string") {
    adapterContext.clientModelId = adapterMetadataSignals.clientModelId;
  }
  if (typeof adapterMetadataSignals.modelId === "string") {
    (adapterContext as Record<string, unknown>).modelId =
      adapterMetadataSignals.modelId;
  }
  if (typeof adapterMetadataSignals.estimatedInputTokens === "number") {
    (adapterContext as Record<string, unknown>).estimatedInputTokens =
      adapterMetadataSignals.estimatedInputTokens;
  }
  const rt = cloneRuntimeMetadata(metadata);
  if (rt) {
    const existingRt = (adapterContext as Record<string, unknown>).__rt;
    const preservedRt = isJsonObject(existingRt as JsonValue | undefined)
      ? (existingRt as Record<string, unknown>)
      : undefined;
    (adapterContext as Record<string, unknown>).__rt = {
      ...rt,
      ...preservedRt,
    } as unknown;
  }
  if (adapterObjectCarriers.capturedChatRequest) {
    (adapterContext as Record<string, unknown>).capturedChatRequest =
      adapterObjectCarriers.capturedChatRequest;
    // Persist origin snapshot for followup re-entry (Phase 1+).
    const scope = resolveServertoolPersistentScopeKey(adapterContext);
    if (scope && adapterObjectCarriers.capturedChatRequest) {
      const captured = adapterObjectCarriers.capturedChatRequest as Record<string, unknown>;
      const capturedMessages = Array.isArray(captured.messages) ? (captured.messages as unknown[]) : [];
      saveOriginSnapshot(scope, {
        requestId: adapterContext.requestId ?? String(Date.now()),
        sessionScope: scope,
        capturedChatRequest: captured as any,
        model: captured?.model as string | undefined,
        messages: (capturedMessages as any),
        tools: (((captured?.tools as unknown[]) ?? []) as any),
        parameters: ((captured?.parameters as Record<string, unknown>) ?? undefined) as any,
        entryEndpoint: adapterContext.entryEndpoint,
        providerProtocol: adapterContext.providerProtocol,
      });
    }
  }
  if (typeof adapterMetadataSignals.sessionId === "string") {
    (adapterContext as Record<string, unknown>).sessionId =
      adapterMetadataSignals.sessionId;
  }
  if (typeof adapterMetadataSignals.conversationId === "string") {
    (adapterContext as Record<string, unknown>).conversationId =
      adapterMetadataSignals.conversationId;
  }
  Object.assign(
    adapterContext as Record<string, unknown>,
    extractAdapterContextMetadataFieldsWithNative(metadata, [
      "clockDaemonId",
      "tmuxSessionId",
      "clientType",
      "clockClientType",
      "clientInjectReady",
      "cwd",
      "workdir",
      "clientWorkdir",
    ]),
  );
  if (adapterObjectCarriers.clientConnectionState) {
    (adapterContext as Record<string, unknown>).clientConnectionState =
      adapterObjectCarriers.clientConnectionState;
  }
  if (typeof adapterObjectCarriers.clientDisconnected === "boolean") {
    (adapterContext as Record<string, unknown>).clientDisconnected =
      adapterObjectCarriers.clientDisconnected;
  }
}
