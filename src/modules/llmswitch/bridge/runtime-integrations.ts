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
import {
  shouldRecordSnapshotsNative,
  writeSnapshotViaHooksNative,
} from "./snapshot-hooks-host.js";
import {
  assertSseRuntimeNativeAvailable,
  buildJsonFromSseWithNative,
} from './sse-runtime-host.js';
import {
  assertProviderRuntimeIngressNativeAvailable,
  reportProviderErrorToRouterPolicyNative,
  reportProviderSuccessToRouterPolicyNative,
} from './provider-runtime-ingress-host.js';
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

type AnyRecord = Record<string, unknown>;
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

async function collectSseBodyText(source: AsyncIterable<string | Buffer>): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of source) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
  }
  return chunks.join("");
}

export async function buildResponsesJsonFromSseStreamWithNative(input: {
  stream: AsyncIterable<string | Buffer>;
  requestId: string;
  model: string;
  config?: AnyRecord;
}): Promise<unknown> {
  const bodyText = await collectSseBodyText(input.stream);
  return buildJsonFromSseWithNative({
    protocol: "openai-responses",
    bodyText,
    requestId: input.requestId,
    model: input.model,
    config: input.config ?? {},
  });
}

export async function preloadCriticalBridgeRuntimeModules(): Promise<{
  loaded: string[];
}> {
  const loaded: string[] = [];

  shouldRecordSnapshotsNative();
  loaded.push("native/router-hotpath/snapshot-hooks");

  await resumeLatestResponsesContinuationByScopeHost({ payload: {}, entryKind: "responses" });
  loaded.push("bridge/responses-conversation-store-host");

  assertSseRuntimeNativeAvailable();
  loaded.push("native-json/sse-runtime");

  assertProviderRuntimeIngressNativeAvailable();
  loaded.push("native-json/provider-runtime-ingress");

  return { loaded };
}

export async function reportProviderErrorToRouterPolicy(
  event: ProviderErrorEvent,
): Promise<ProviderErrorEvent> {
  return reportProviderErrorToRouterPolicyNative(event);
}

export async function reportProviderSuccessToRouterPolicy(
  event: ProviderSuccessEvent,
): Promise<ProviderSuccessEvent> {
  return reportProviderSuccessToRouterPolicyNative(event);
}
