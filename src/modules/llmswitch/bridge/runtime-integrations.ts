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

type SnapshotHooksModule = {
  writeSnapshotViaHooks?: (options: AnyRecord) => Promise<void> | void;
};

let cachedSnapshotHooksModule: SnapshotHooksModule | null = null;

async function getSnapshotHooksModule(): Promise<SnapshotHooksModule> {
  if (!cachedSnapshotHooksModule) {
    cachedSnapshotHooksModule = await importCoreDist<SnapshotHooksModule>(
      "conversion/snapshot-utils",
    );
  }
  return cachedSnapshotHooksModule;
}

export async function writeSnapshotViaHooks(
  channelOrOptions: string | AnyRecord,
  payload?: AnyRecord,
): Promise<void> {
  const hooksModule = await getSnapshotHooksModule();
  const writer = hooksModule?.writeSnapshotViaHooks;
  if (typeof writer !== "function") {
    throw new Error("[llmswitch-bridge] writeSnapshotViaHooks not available");
  }

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

  await writer(options);
}

type ResponsesConversationStoreLike = {
  captureRequestContext?: (args: {
    requestId: string;
    payload: AnyRecord;
    context: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    providerKey?: string;
    entryKind?: 'responses' | 'chat' | 'messages';
    matchedPort?: number;
    routingPolicyGroup?: string;
    routeHint?: string;
  }) => void;
  recordResponse?: (args: {
    requestId: string;
    response: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    providerKey?: string;
    entryKind?: 'responses' | 'chat' | 'messages';
    continuationOwner?: 'direct' | 'relay';
    matchedPort?: number;
    routingPolicyGroup?: string;
    allowScopeContinuation?: boolean;
    routeHint?: string;
  }) => void;
  resumeConversation?: (
    responseId: string,
    submitPayload: AnyRecord,
    options?: {
      requestId?: string;
      entryKind?: 'responses' | 'chat' | 'messages';
      continuationOwner?: 'direct' | 'relay';
      matchedPort?: number;
      routingPolicyGroup?: string;
    },
  ) => { payload: AnyRecord; meta: AnyRecord };
  lookupContinuationByResponseId?: (responseId: string, options?: {
    entryKind?: 'responses' | 'chat' | 'messages';
    continuationOwner?: 'direct' | 'relay';
    matchedPort?: number;
    routingPolicyGroup?: string;
  }) => {
    responseId: string;
    providerKey?: string;
    continuationOwner?: 'direct' | 'relay';
    entryKind?: 'responses' | 'chat' | 'messages';
    requestId?: string;
  } | null;
  resumeLatestContinuationByScope?: (args: {
    payload: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    requestId?: string;
    entryKind?: 'responses' | 'chat' | 'messages';
    continuationOwner?: 'direct' | 'relay';
    matchedPort?: number;
    routingPolicyGroup?: string;
  }) => { payload: AnyRecord; meta: AnyRecord } | null;
  materializeLatestContinuationByScope?: (args: {
    payload: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    requestId?: string;
    entryKind?: 'responses' | 'chat' | 'messages';
    continuationOwner?: 'direct' | 'relay';
    matchedPort?: number;
    routingPolicyGroup?: string;
  }) => { payload: AnyRecord; meta: AnyRecord } | null;
  clearRequest?: (requestId?: string) => void;
  releaseRequestPayload?: (requestId?: string) => void;
  finalizeResponsesConversationRequestRetention?: (
    requestId?: string,
    options?: { keepForSubmitToolOutputs?: boolean },
  ) => void;
  clearAll?: () => void;
  clearUnresolvedRequests?: () => number;
  requestMap?: Map<string, { lastResponseId?: unknown }>;
  detachEntry?: (entry: { lastResponseId?: unknown }) => void;
  pruneIndexes?: () => void;
  rebindRequestId?: (oldId: string, newId: string) => void;
};

type ResponsesConversationModule = {
  captureResponsesRequestContext?: (args: {
    requestId: string;
    payload: AnyRecord;
    context: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    entryKind?: 'responses' | 'chat' | 'messages';
    routeHint?: string;
  }) => void;
  recordResponsesResponse?: (args: {
    requestId: string;
    response: AnyRecord;
    entryKind?: 'responses' | 'chat' | 'messages';
    routeHint?: string;
  }) => void;
  resumeResponsesConversation?: (
    responseId: string,
    submitPayload: AnyRecord,
    options?: { requestId?: string; entryKind?: 'responses' | 'chat' | 'messages'; continuationOwner?: 'direct' | 'relay'; matchedPort?: number; routingPolicyGroup?: string },
  ) => Promise<{ payload: AnyRecord; meta: AnyRecord }>;
  lookupResponsesContinuationByResponseId?: (responseId: string, options?: {
    entryKind?: 'responses' | 'chat' | 'messages';
    continuationOwner?: 'direct' | 'relay';
    matchedPort?: number;
    routingPolicyGroup?: string;
  }) => {
    responseId: string;
    providerKey?: string;
    continuationOwner?: 'direct' | 'relay';
    entryKind?: 'responses' | 'chat' | 'messages';
    requestId?: string;
  } | null;
  resumeLatestResponsesContinuationByScope?: (args: {
    payload: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    requestId?: string;
    entryKind?: 'responses' | 'chat' | 'messages';
    continuationOwner?: 'direct' | 'relay';
    matchedPort?: number;
    routingPolicyGroup?: string;
  }) => { payload: AnyRecord; meta: AnyRecord } | null;
  materializeLatestResponsesContinuationByScope?: (args: {
    payload: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    requestId?: string;
    entryKind?: 'responses' | 'chat' | 'messages';
    continuationOwner?: 'direct' | 'relay';
    matchedPort?: number;
    routingPolicyGroup?: string;
  }) => { payload: AnyRecord; meta: AnyRecord } | null;
  rebindResponsesConversationRequestId?: (oldId: string, newId: string) => void;
  clearResponsesConversationByRequestId?: (requestId?: string) => void;
  finalizeResponsesConversationRequestRetention?: (
    requestId?: string,
    options?: { keepForSubmitToolOutputs?: boolean },
  ) => void;
  clearAllResponsesConversationState?: () => void;
  resetResponsesConversationStateForRestartSimulation?: () => void;
  clearUnresolvedResponsesConversationRequests?: () => number;
};

function readGlobalResponsesConversationStore(): ResponsesConversationStoreLike | null {
  const store = (globalThis as Record<string, unknown>)
    .__rccResponsesConversationStore;
  return store && typeof store === "object" && !Array.isArray(store)
    ? (store as ResponsesConversationStoreLike)
    : null;
}

let cachedResponsesConversationModule: ResponsesConversationModule | null =
  null;

async function getResponsesConversationModule(): Promise<ResponsesConversationModule> {
  if (!cachedResponsesConversationModule) {
    cachedResponsesConversationModule =
      await importCoreDist<ResponsesConversationModule>(
        "conversion/shared/responses-conversation-store",
      );
  }
  return cachedResponsesConversationModule;
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
  const globalStore = readGlobalResponsesConversationStore();
  if (typeof globalStore?.captureRequestContext === "function") {
    globalStore.captureRequestContext(args);
    return;
  }
  const mod = await getResponsesConversationModule();
  const fn = mod.captureResponsesRequestContext;
  if (typeof fn !== "function") {
    throw new Error(
      "[llmswitch-bridge] captureResponsesRequestContext not available",
    );
  }
  fn(args);
  if (process.env.RESPONSES_DEBUG === '1') {
    const store = (mod as { responsesConversationStore?: unknown }).responsesConversationStore;
    const stats =
      store && typeof (store as { getDebugStats?: unknown }).getDebugStats === 'function'
        ? (store as { getDebugStats: () => unknown }).getDebugStats()
        : null;
    console.log('[runtime-integrations] capture core store', args.requestId, stats);
  }
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
  const globalStore = readGlobalResponsesConversationStore();
  if (typeof globalStore?.recordResponse === "function") {
    globalStore.recordResponse(args);
    return;
  }
  const mod = await getResponsesConversationModule();
  const resolvedFn = mod.recordResponsesResponse;
  if (typeof resolvedFn !== "function") {
    throw new Error("[llmswitch-bridge] recordResponsesResponse not available");
  }
  resolvedFn(args);
}

export async function resumeResponsesConversation(
  responseId: string,
  submitPayload: AnyRecord,
  options?: { requestId?: string; entryKind?: 'responses' | 'chat' | 'messages'; continuationOwner?: 'direct' | 'relay'; matchedPort?: number; routingPolicyGroup?: string },
): Promise<{ payload: AnyRecord; meta: AnyRecord }> {
  const globalStore = readGlobalResponsesConversationStore();
  if (typeof globalStore?.resumeConversation === "function") {
    return globalStore.resumeConversation(responseId, submitPayload, options);
  }
  const mod = await getResponsesConversationModule();
  const fn = mod.resumeResponsesConversation;
  if (typeof fn !== "function") {
    throw new Error(
      "[llmswitch-bridge] resumeResponsesConversation not available",
    );
  }
  return await fn(responseId, submitPayload, options);
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
  const globalStore = readGlobalResponsesConversationStore();
  if (typeof globalStore?.lookupContinuationByResponseId === "function") {
    return globalStore.lookupContinuationByResponseId(responseId, options);
  }
  const mod = await getResponsesConversationModule();
  const fn = mod.lookupResponsesContinuationByResponseId;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] lookupResponsesContinuationByResponseId not available');
  }
  return fn(responseId, options);
}

export async function rebindResponsesConversationRequestId(
  oldId?: string,
  newId?: string,
): Promise<void> {
  if (!oldId || !newId || oldId === newId) {
    return;
  }
  const globalStore = readGlobalResponsesConversationStore();
  if (typeof globalStore?.rebindRequestId === "function") {
    globalStore.rebindRequestId(oldId, newId);
    return;
  }
  const mod = await getResponsesConversationModule();
  const fn = mod.rebindResponsesConversationRequestId;
  if (typeof fn === "function") {
    fn(oldId, newId);
  }
}

export async function clearResponsesConversationByRequestId(
  requestId?: string,
): Promise<void> {
  if (!requestId) {
    return;
  }
  const globalStore = readGlobalResponsesConversationStore();
  if (typeof globalStore?.clearRequest === "function") {
    globalStore.clearRequest(requestId);
    return;
  }
  const mod = await getResponsesConversationModule();
  const fn = mod.clearResponsesConversationByRequestId;
  if (typeof fn === "function") {
    fn(requestId);
  }
}

export async function finalizeResponsesConversationRequestRetention(
  requestId?: string,
  options?: { keepForSubmitToolOutputs?: boolean },
): Promise<void> {
  if (!requestId) {
    return;
  }
  const globalStore = readGlobalResponsesConversationStore();
  if (typeof globalStore?.finalizeResponsesConversationRequestRetention === "function") {
    globalStore.finalizeResponsesConversationRequestRetention(requestId, options);
    return;
  }
  const mod = await getResponsesConversationModule();
  const fn = mod.finalizeResponsesConversationRequestRetention;
  if (typeof fn !== "function") {
    throw new Error(
      "[llmswitch-bridge] finalizeResponsesConversationRequestRetention not available",
    );
  }
  fn(requestId, options);
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
  const globalStore = readGlobalResponsesConversationStore();
  if (typeof globalStore?.resumeLatestContinuationByScope === "function") {
    return globalStore.resumeLatestContinuationByScope(args);
  }
  const mod = await getResponsesConversationModule();
  const fn = mod.resumeLatestResponsesContinuationByScope;
  if (typeof fn !== "function") {
    throw new Error(
      "[llmswitch-bridge] resumeLatestResponsesContinuationByScope not available",
    );
  }
  return fn(args);
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
  const globalStore = readGlobalResponsesConversationStore();
  if (typeof globalStore?.materializeLatestContinuationByScope === "function") {
    return globalStore.materializeLatestContinuationByScope(args);
  }
  const mod = await getResponsesConversationModule();
  const fn = mod.materializeLatestResponsesContinuationByScope;
  if (typeof fn !== "function") {
    throw new Error(
      "[llmswitch-bridge] materializeLatestResponsesContinuationByScope not available",
    );
  }
  return fn(args);
}

export async function clearAllResponsesConversationState(): Promise<void> {
  const mod = await getResponsesConversationModule();
  const fn = mod.clearAllResponsesConversationState;
  if (typeof fn !== "function") {
    throw new Error(
      "[llmswitch-bridge] clearAllResponsesConversationState not available",
    );
  }
  fn();
}

export async function clearUnresolvedResponsesConversationRequests(): Promise<number> {
  const mod = await getResponsesConversationModule();
  const fn = mod.clearUnresolvedResponsesConversationRequests;
  if (typeof fn !== "function") {
    throw new Error(
      "[llmswitch-bridge] clearUnresolvedResponsesConversationRequests not available",
    );
  }
  return fn();
}

export async function resetResponsesConversationStateForRestartSimulation(): Promise<void> {
  const mod = await getResponsesConversationModule();
  const fn = mod.resetResponsesConversationStateForRestartSimulation;
  if (typeof fn !== "function") {
    throw new Error(
      "[llmswitch-bridge] resetResponsesConversationStateForRestartSimulation not available",
    );
  }
  fn();
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

  const snapshotHooksModule = await getSnapshotHooksModule();
  if (typeof snapshotHooksModule.writeSnapshotViaHooks !== "function") {
    throw new Error(
      "[llmswitch-bridge] preload failed: writeSnapshotViaHooks not available",
    );
  }
  loaded.push("conversion/snapshot-utils");

  const responsesConversationModule = await getResponsesConversationModule();
  if (
    typeof responsesConversationModule.resumeResponsesConversation !==
      "function" ||
    typeof responsesConversationModule.resumeLatestResponsesContinuationByScope !==
      "function" ||
    typeof responsesConversationModule.materializeLatestResponsesContinuationByScope !==
      "function"
  ) {
    throw new Error(
      "[llmswitch-bridge] preload failed: responses conversation helpers not available",
    );
  }
  loaded.push("conversion/shared/responses-conversation-store");

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
