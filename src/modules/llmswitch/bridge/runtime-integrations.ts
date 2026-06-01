/**
 * Runtime Integrations Bridge
 *
 * Snapshot hooks, responses conversation helpers, SSE converter, and
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
    routeHint?: string;
  }) => void;
  recordResponse?: (args: {
    requestId: string;
    response: AnyRecord;
    routeHint?: string;
    sessionId?: string;
    conversationId?: string;
  }) => void;
  resumeConversation?: (
    responseId: string,
    submitPayload: AnyRecord,
    options?: { requestId?: string; matchedPort?: number; routingPolicyGroup?: string },
  ) => { payload: AnyRecord; meta: AnyRecord };
  resumeLatestContinuationByScope?: (args: {
    payload: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    requestId?: string;
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
    routeHint?: string;
  }) => void;
  recordResponsesResponse?: (args: {
    requestId: string;
    response: AnyRecord;
    routeHint?: string;
  }) => void;
  resumeResponsesConversation?: (
    responseId: string,
    submitPayload: AnyRecord,
    options?: { requestId?: string; matchedPort?: number; routingPolicyGroup?: string },
  ) => Promise<{ payload: AnyRecord; meta: AnyRecord }>;
  resumeLatestResponsesContinuationByScope?: (args: {
    payload: AnyRecord;
    sessionId?: string;
    conversationId?: string;
    requestId?: string;
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
}

export async function recordResponsesResponseForRequest(args: {
  requestId: string;
  response: AnyRecord;
  routeHint?: string;
  sessionId?: string;
  conversationId?: string;
  providerKey?: string;
  matchedPort?: number;
  routingPolicyGroup?: string;
}): Promise<void> {
  const globalStore = readGlobalResponsesConversationStore();
  const fn =
    typeof globalStore?.recordResponse === "function"
      ? globalStore.recordResponse.bind(globalStore)
      : () => undefined;
  const mod =
    typeof globalStore?.recordResponse === "function"
      ? null
      : await getResponsesConversationModule();
  const resolvedFn =
    typeof globalStore?.recordResponse === "function"
      ? fn
      : mod?.recordResponsesResponse;
  if (typeof resolvedFn !== "function") {
    throw new Error("[llmswitch-bridge] recordResponsesResponse not available");
  }
  try {
    resolvedFn(args);
  } catch (error) {
    const code =
      typeof (error as { code?: unknown })?.code === "string"
        ? String((error as { code?: unknown }).code)
        : "";
    const message =
      error instanceof Error ? error.message : String(error ?? "");
    const missingContext =
      code === "MALFORMED_RESPONSE" &&
      message.includes("request context missing for response capture");
    if (missingContext) {
      return;
    }
    throw error;
  }
}

export async function resumeResponsesConversation(
  responseId: string,
  submitPayload: AnyRecord,
  options?: { requestId?: string; matchedPort?: number; routingPolicyGroup?: string },
): Promise<{ payload: AnyRecord; meta: AnyRecord }> {
  const globalStore = readGlobalResponsesConversationStore();
  if (typeof globalStore?.resumeConversation === "function") {
    return await globalStore.resumeConversation(
      responseId,
      submitPayload,
      options,
    );
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
  if (
    typeof globalStore?.finalizeResponsesConversationRequestRetention ===
    "function"
  ) {
    globalStore.finalizeResponsesConversationRequestRetention(
      requestId,
      options,
    );
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

export async function clearAllResponsesConversationState(): Promise<void> {
  const globalStore = readGlobalResponsesConversationStore();
  if (typeof globalStore?.clearAll === "function") {
    globalStore.clearAll();
    return;
  }
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
  const globalStore = readGlobalResponsesConversationStore();
  if (typeof globalStore?.clearUnresolvedRequests === "function") {
    return globalStore.clearUnresolvedRequests();
  }
  if (
    globalStore?.requestMap instanceof Map &&
    typeof globalStore.detachEntry === "function"
  ) {
    let cleared = 0;
    for (const entry of [...globalStore.requestMap.values()]) {
      if (typeof entry.lastResponseId === "string" && entry.lastResponseId.trim()) {
        continue;
      }
      globalStore.detachEntry(entry);
      cleared += 1;
    }
    if (typeof globalStore.pruneIndexes === "function") {
      globalStore.pruneIndexes();
    }
    return cleared;
  }
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
  const globalStore = readGlobalResponsesConversationStore();
  if (typeof globalStore?.clearAll === "function") {
    globalStore.clearAll();
    return;
  }
  const mod = await getResponsesConversationModule();
  const fn = mod.resetResponsesConversationStateForRestartSimulation;
  if (typeof fn !== "function") {
    throw new Error(
      "[llmswitch-bridge] resetResponsesConversationStateForRestartSimulation not available",
    );
  }
  fn();
}

type ResponsesSseToJsonModule = {
  ResponsesSseToJsonConverter?: new () => {
    convertSseToJson(stream: unknown, options: AnyRecord): Promise<unknown>;
  };
};

type ResponsesJsonToSseModule = {
  ResponsesJsonToSseConverter?: new () => {
    convertResponseToJsonToSse(
      payload: unknown,
      options: AnyRecord,
    ): Promise<unknown>;
  };
};

let cachedResponsesSseToJsonConverterFactory:
  | (() => {
      convertSseToJson(stream: unknown, options: AnyRecord): Promise<unknown>;
    })
  | null = null;
let cachedResponsesJsonToSseConverterFactory:
  | (() => {
      convertResponseToJsonToSse(
        payload: unknown,
        options: AnyRecord,
      ): Promise<unknown>;
    })
  | null = null;

export async function createResponsesSseToJsonConverter(): Promise<{
  convertSseToJson(stream: unknown, options: AnyRecord): Promise<unknown>;
}> {
  if (!cachedResponsesSseToJsonConverterFactory) {
    const mod = await importCoreDist<ResponsesSseToJsonModule>(
      "sse/sse-to-json/index",
    );
    const Ctor = mod.ResponsesSseToJsonConverter;
    if (typeof Ctor !== "function") {
      throw new Error(
        "[llmswitch-bridge] ResponsesSseToJsonConverter not available",
      );
    }
    cachedResponsesSseToJsonConverterFactory = () => new Ctor();
  }
  return cachedResponsesSseToJsonConverterFactory();
}

export async function createResponsesJsonToSseConverter(): Promise<{
  convertResponseToJsonToSse(
    payload: unknown,
    options: AnyRecord,
  ): Promise<unknown>;
}> {
  if (!cachedResponsesJsonToSseConverterFactory) {
    const mod = await importCoreDist<ResponsesJsonToSseModule>(
      "sse/json-to-sse/index",
    );
    const Ctor = mod.ResponsesJsonToSseConverter;
    if (typeof Ctor !== "function") {
      throw new Error(
        "[llmswitch-bridge] ResponsesJsonToSseConverter not available",
      );
    }
    cachedResponsesJsonToSseConverterFactory = () => new Ctor();
  }
  return cachedResponsesJsonToSseConverterFactory();
}

type ProviderRuntimeIngressExports = {
  reportProviderErrorToRouterPolicy?: (
    event: ProviderErrorEvent,
  ) => ProviderErrorEvent;
  reportProviderSuccessToRouterPolicy?: (
    event: ProviderSuccessEvent,
  ) => ProviderSuccessEvent;
  setProviderRuntimeQuotaHooks?: (
    owner: unknown,
    hooks?: {
      onProviderError?: (event: ProviderErrorEvent) => void;
      onProviderSuccess?: (event: ProviderSuccessEvent) => void;
    },
  ) => void;
  setProviderRuntimeProviderQuotaHooks?: (
    owner: unknown,
    hooks?: {
      onProviderError?: (event: ProviderErrorEvent) => void;
    },
  ) => void;
};

let cachedProviderRuntimeIngress: ProviderRuntimeIngressExports | null = null;

async function getProviderRuntimeIngress(): Promise<ProviderRuntimeIngressExports> {
  if (!cachedProviderRuntimeIngress) {
    cachedProviderRuntimeIngress =
      await importCoreDist<ProviderRuntimeIngressExports>(
        "router/virtual-router/provider-runtime-ingress",
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
      "function"
  ) {
    throw new Error(
      "[llmswitch-bridge] preload failed: responses conversation helpers not available",
    );
  }
  loaded.push("conversion/shared/responses-conversation-store");

  const sseToJsonModule = await importCoreDist<ResponsesSseToJsonModule>(
    "sse/sse-to-json/index",
  );
  if (typeof sseToJsonModule.ResponsesSseToJsonConverter !== "function") {
    throw new Error(
      "[llmswitch-bridge] preload failed: ResponsesSseToJsonConverter not available",
    );
  }
  loaded.push("sse/sse-to-json/index");

  const jsonToSseModule = await importCoreDist<ResponsesJsonToSseModule>(
    "sse/json-to-sse/index",
  );
  if (typeof jsonToSseModule.ResponsesJsonToSseConverter !== "function") {
    throw new Error(
      "[llmswitch-bridge] preload failed: ResponsesJsonToSseConverter not available",
    );
  }
  loaded.push("sse/json-to-sse/index");

  const ingressModule = await getProviderRuntimeIngress();
  if (
    typeof ingressModule.reportProviderErrorToRouterPolicy !== "function" ||
    typeof ingressModule.reportProviderSuccessToRouterPolicy !== "function"
  ) {
    throw new Error(
      "[llmswitch-bridge] preload failed: provider runtime ingress hooks not available",
    );
  }
  loaded.push("router/virtual-router/provider-runtime-ingress");

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

export async function setProviderRuntimeQuotaHooks(
  owner: unknown,
  hooks?: {
    onProviderError?: (event: ProviderErrorEvent) => void;
    onProviderSuccess?: (event: ProviderSuccessEvent) => void;
  },
): Promise<boolean> {
  const mod = await getProviderRuntimeIngress();
  const fn = mod.setProviderRuntimeQuotaHooks;
  if (typeof fn !== "function") {
    return false;
  }
  fn(owner, hooks);
  return true;
}

export async function setProviderRuntimeProviderQuotaHooks(
  owner: unknown,
  hooks?: {
    onProviderError?: (event: ProviderErrorEvent) => void;
  },
): Promise<boolean> {
  const mod = await getProviderRuntimeIngress();
  const fn = mod.setProviderRuntimeProviderQuotaHooks;
  if (typeof fn !== "function") {
    return false;
  }
  fn(owner, hooks);
  return true;
}
