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
  getRouterHotpathJsonBindingSync,
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

function nativeJsonBinding(): Record<string, unknown> {
  return getRouterHotpathJsonBindingSync() as unknown as Record<string, unknown>;
}

function requireNativeJsonFunction<T extends (...args: any[]) => unknown>(
  capability: string,
): T {
  const fn = nativeJsonBinding()[capability];
  if (typeof fn !== "function") {
    throw new Error(`[llmswitch-bridge] ${capability} not available`);
  }
  return fn as T;
}

async function collectSseBodyText(source: AsyncIterable<string | Buffer>): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of source) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
  }
  return chunks.join("");
}

function buildJsonFromSseWithNative(input: {
  protocol: string;
  bodyText: string;
  requestId?: string;
  model?: string;
  config?: AnyRecord;
}): AnyRecord {
  const fn = requireNativeJsonFunction<(inputJson: string) => string>("buildJsonFromSseJson");
  const raw = fn(JSON.stringify({
    protocol: input.protocol,
    body_text: input.bodyText,
    request_id: input.requestId,
    model: input.model,
    config: input.config ?? {},
  }));
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("[llmswitch-bridge] buildJsonFromSseJson returned invalid result");
  }
  return parsed as AnyRecord;
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

function reportProviderRuntimeIngressWithNative<TEvent>(
  capability: string,
  event: TEvent,
): TEvent {
  const fn = requireNativeJsonFunction<(inputJson: string) => string>(capability);
  return JSON.parse(fn(JSON.stringify(event))) as TEvent;
}

export async function preloadCriticalBridgeRuntimeModules(): Promise<{
  loaded: string[];
}> {
  const loaded: string[] = [];

  shouldRecordSnapshotsNative();
  loaded.push("native/router-hotpath/snapshot-hooks");

  await resumeLatestResponsesContinuationByScopeHost({ payload: {}, entryKind: "responses" });
  loaded.push("bridge/responses-conversation-store-host");

  requireNativeJsonFunction<(inputJson: string) => string>("buildJsonFromSseJson");
  loaded.push("native-json/sse-runtime");

  requireNativeJsonFunction<(inputJson: string) => string>("reportProviderErrorToRouterPolicyJson");
  requireNativeJsonFunction<(inputJson: string) => string>("reportProviderSuccessToRouterPolicyJson");
  loaded.push("native-json/provider-runtime-ingress");

  return { loaded };
}

export async function reportProviderErrorToRouterPolicy(
  event: ProviderErrorEvent,
): Promise<ProviderErrorEvent> {
  return reportProviderRuntimeIngressWithNative("reportProviderErrorToRouterPolicyJson", event);
}

export async function reportProviderSuccessToRouterPolicy(
  event: ProviderSuccessEvent,
): Promise<ProviderSuccessEvent> {
  return reportProviderRuntimeIngressWithNative("reportProviderSuccessToRouterPolicyJson", event);
}
