/**
 * Runtime Integrations Bridge
 *
 * Snapshot hooks, responses conversation helpers, native SSE runtime, and
 * provider runtime ingress hooks.
 */

import type {
  ProviderErrorEvent,
  ProviderSuccessEvent,
} from "../../../types/llmswitch-local-types.js";
import { importCoreDist } from "./module-loader.js";
import type { AnyRecord } from "./module-loader.js";
import {
  shouldRecordSnapshotsNative,
  writeSnapshotViaHooksNative,
} from "./native-exports.js";
import {
  captureResponsesRequestContext,
  recordResponsesResponse,
  resumeResponsesConversation as resumeResponsesConversationHost,
  lookupResponsesContinuationByResponseId as lookupResponsesContinuationByResponseIdHost,
  resumeLatestResponsesContinuationByScope as resumeLatestResponsesContinuationByScopeHost,
  materializeLatestResponsesContinuationByScope as materializeLatestResponsesContinuationByScopeHost,
  rebindResponsesConversationRequestId as rebindResponsesConversationRequestIdHost,
  clearResponsesConversationByRequestId as clearResponsesConversationByRequestIdHost,
  finalizeResponsesConversationRequestRetention as finalizeResponsesConversationRequestRetentionHost,
  clearAllResponsesConversationState as clearAllResponsesConversationStateHost,
  resetResponsesConversationStateForRestartSimulation as resetResponsesConversationStateForRestartSimulationHost,
  clearUnresolvedResponsesConversationRequests as clearUnresolvedResponsesConversationRequestsHost,
} from "./responses-conversation-store-host.js";

export async function writeSnapshotViaHooks(
  channelOrOptions: string | AnyRecord,
  payload?: AnyRecord,
): Promise<void> {
  let options: AnyRecord | undefined;
  if (payload && typeof channelOrOptions === "string") {
    const channelValue =
      typeof payload.channel === "string" && payload.channel
        ? payload.channel
        : channelOrOptions;
    options = { ...payload, channel: channelValue };
  } else if (channelOrOptions && typeof channelOrOptions === "object") {
    options = channelOrOptions;
  }

  if (!options) {
    return;
  }

  writeSnapshotViaHooksNative(options);
}

export async function captureResponsesRequestContextForRequest(args: {
  requestId: string;
  payload: AnyRecord;
  context: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  routeHint?: string;
  providerKey?: string;
  entryKind?: 'responses' | 'chat' | 'messages';
  matchedPort?: number;
  routingPolicyGroup?: string;
}): Promise<void> {
  captureResponsesRequestContext(args);
}

export async function recordResponsesResponseForRequest(args: {
  requestId: string;
  response: AnyRecord;
  routeHint?: string;
  sessionId?: string;
  conversationId?: string;
  providerKey?: string;
  entryKind?: 'responses' | 'chat' | 'messages';
  continuationOwner?: 'direct' | 'relay';
  matchedPort?: number;
  routingPolicyGroup?: string;
  allowScopeContinuation?: boolean;
}): Promise<void> {
  recordResponsesResponse(args);
}

export async function resumeResponsesConversation(
  responseId: string,
  submitPayload: AnyRecord,
  options?: { requestId?: string; entryKind?: 'responses' | 'chat' | 'messages'; continuationOwner?: 'direct' | 'relay'; matchedPort?: number; routingPolicyGroup?: string },
): Promise<{ payload: AnyRecord; meta: AnyRecord }> {
  return resumeResponsesConversationHost(responseId, submitPayload, options);
}

export async function lookupResponsesContinuationByResponseId(
  responseId: string,
  options?: { entryKind?: 'responses' | 'chat' | 'messages'; continuationOwner?: 'direct' | 'relay'; matchedPort?: number; routingPolicyGroup?: string },
): Promise<{
  responseId: string;
  providerKey?: string;
  continuationOwner?: 'direct' | 'relay';
  entryKind?: 'responses' | 'chat' | 'messages';
  requestId?: string;
} | null> {
  return lookupResponsesContinuationByResponseIdHost(responseId, options);
}

export async function rebindResponsesConversationRequestId(
  oldId?: string,
  newId?: string,
): Promise<void> {
  if (!oldId || !newId || oldId === newId) {
    return;
  }
  rebindResponsesConversationRequestIdHost(oldId, newId);
}

export async function clearResponsesConversationByRequestId(
  requestId?: string,
): Promise<void> {
  if (!requestId) {
    return;
  }
  clearResponsesConversationByRequestIdHost(requestId);
}

export async function finalizeResponsesConversationRequestRetention(
  requestId?: string,
  options?: { keepForSubmitToolOutputs?: boolean },
): Promise<void> {
  if (!requestId) {
    return;
  }
  finalizeResponsesConversationRequestRetentionHost(requestId, options);
}

export async function resumeLatestResponsesContinuationByScope(args: {
  payload: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  requestId?: string;
  entryKind?: 'responses' | 'chat' | 'messages';
  continuationOwner?: 'direct' | 'relay';
  matchedPort?: number;
  routingPolicyGroup?: string;
}): Promise<{ payload: AnyRecord; meta: AnyRecord } | null> {
  return resumeLatestResponsesContinuationByScopeHost(args);
}

export async function materializeLatestResponsesContinuationByScope(args: {
  payload: AnyRecord;
  sessionId?: string;
  conversationId?: string;
  requestId?: string;
  entryKind?: 'responses' | 'chat' | 'messages';
  continuationOwner?: 'direct' | 'relay';
  matchedPort?: number;
  routingPolicyGroup?: string;
}): Promise<{ payload: AnyRecord; meta: AnyRecord } | null> {
  return materializeLatestResponsesContinuationByScopeHost(args);
}

export async function clearAllResponsesConversationState(): Promise<void> {
  clearAllResponsesConversationStateHost();
}

export async function clearUnresolvedResponsesConversationRequests(): Promise<number> {
  return clearUnresolvedResponsesConversationRequestsHost();
}

export async function resetResponsesConversationStateForRestartSimulation(): Promise<void> {
  resetResponsesConversationStateForRestartSimulationHost();
}

type NativeSseRuntimeModule = {
  collectSseBodyText?: (stream: AsyncIterable<string | Buffer>) => Promise<string>;
  buildJsonFromSseWithNative?: (input: {
    protocol: string;
    bodyText: string;
    requestId?: string;
    model?: string;
    config?: AnyRecord;
  }) => AnyRecord;
};

let cachedNativeSseRuntimeModule: NativeSseRuntimeModule | null = null;

async function getNativeSseRuntimeModule(): Promise<NativeSseRuntimeModule> {
  if (!cachedNativeSseRuntimeModule) {
    cachedNativeSseRuntimeModule = await importCoreDist<NativeSseRuntimeModule>(
      "native/router-hotpath/native-sse-runtime",
    );
  }
  return cachedNativeSseRuntimeModule;
}

export async function buildResponsesJsonFromSseStreamWithNative(input: {
  stream: AsyncIterable<string | Buffer>;
  requestId: string;
  model: string;
  config?: AnyRecord;
}): Promise<unknown> {
  const mod = await getNativeSseRuntimeModule();
  if (
    typeof mod.collectSseBodyText !== "function" ||
    typeof mod.buildJsonFromSseWithNative !== "function"
  ) {
    throw new Error(
      "[llmswitch-bridge] native SSE runtime decode helpers not available",
    );
  }
  const bodyText = await mod.collectSseBodyText(input.stream);
  return mod.buildJsonFromSseWithNative({
    protocol: "openai-responses",
    bodyText,
    requestId: input.requestId,
    model: input.model,
    config: input.config ?? {},
  });
}

type ProviderRuntimeIngressExports = {
  reportProviderErrorToRouterPolicy?: (
    event: ProviderErrorEvent,
  ) => ProviderErrorEvent;
  reportProviderSuccessToRouterPolicy?: (
    event: ProviderSuccessEvent,
  ) => ProviderSuccessEvent;
};

let cachedProviderRuntimeIngress: ProviderRuntimeIngressExports | null = null;

async function getProviderRuntimeIngress(): Promise<ProviderRuntimeIngressExports> {
  if (!cachedProviderRuntimeIngress) {
    cachedProviderRuntimeIngress =
      await importCoreDist<ProviderRuntimeIngressExports>(
        "native/router-hotpath/native-provider-runtime-ingress",
      );
  }
  return cachedProviderRuntimeIngress;
}

export async function preloadCriticalBridgeRuntimeModules(): Promise<{
  loaded: string[];
}> {
  const loaded: string[] = [];

  shouldRecordSnapshotsNative();
  loaded.push("native/router-hotpath/snapshot-hooks");

  await resumeLatestResponsesContinuationByScopeHost({ payload: {}, entryKind: "responses" });
  loaded.push("bridge/responses-conversation-store-host");

  const nativeSseRuntimeModule = await getNativeSseRuntimeModule();
  if (
    typeof nativeSseRuntimeModule.collectSseBodyText !== "function" ||
    typeof nativeSseRuntimeModule.buildJsonFromSseWithNative !== "function"
  ) {
    throw new Error(
      "[llmswitch-bridge] preload failed: native SSE runtime decode helpers not available",
    );
  }
  loaded.push("native/router-hotpath/native-sse-runtime");

  const ingressModule = await getProviderRuntimeIngress();
  if (
    typeof ingressModule.reportProviderErrorToRouterPolicy !== "function" ||
    typeof ingressModule.reportProviderSuccessToRouterPolicy !== "function"
  ) {
    throw new Error(
      "[llmswitch-bridge] preload failed: provider runtime ingress hooks not available",
    );
  }
  loaded.push("native/router-hotpath/native-provider-runtime-ingress");

  return { loaded };
}

export async function reportProviderErrorToRouterPolicy(
  event: ProviderErrorEvent,
): Promise<ProviderErrorEvent> {
  const mod = await getProviderRuntimeIngress();
  const fn = mod.reportProviderErrorToRouterPolicy;
  if (typeof fn !== "function") {
    throw new Error(
      "[llmswitch-bridge] reportProviderErrorToRouterPolicy not available",
    );
  }
  return fn(event);
}

export async function reportProviderSuccessToRouterPolicy(
  event: ProviderSuccessEvent,
): Promise<ProviderSuccessEvent> {
  const mod = await getProviderRuntimeIngress();
  const fn = mod.reportProviderSuccessToRouterPolicy;
  if (typeof fn !== "function") {
    throw new Error(
      "[llmswitch-bridge] reportProviderSuccessToRouterPolicy not available",
    );
  }
  return fn(event);
}
