/**
 * Runtime Integrations Bridge
 *
 * Snapshot hooks, responses conversation helpers, SSE converter, and
 * provider runtime ingress hooks.
 */
import { importCoreDist } from "./module-loader.js";
let cachedSnapshotHooksModule = null;
async function getSnapshotHooksModule() {
    if (!cachedSnapshotHooksModule) {
        cachedSnapshotHooksModule = await importCoreDist("conversion/snapshot-utils");
    }
    return cachedSnapshotHooksModule;
}
export async function writeSnapshotViaHooks(channelOrOptions, payload) {
    const hooksModule = await getSnapshotHooksModule();
    const writer = hooksModule?.writeSnapshotViaHooks;
    if (typeof writer !== "function") {
        throw new Error("[llmswitch-bridge] writeSnapshotViaHooks not available");
    }
    let options;
    if (payload && typeof channelOrOptions === "string") {
        const channelValue = typeof payload.channel === "string" && payload.channel
            ? payload.channel
            : channelOrOptions;
        options = { ...payload, channel: channelValue };
    }
    else if (channelOrOptions && typeof channelOrOptions === "object") {
        options = channelOrOptions;
    }
    if (!options) {
        return;
    }
    await writer(options);
}
function readGlobalResponsesConversationStore() {
    const store = globalThis
        .__rccResponsesConversationStore;
    return store && typeof store === "object" && !Array.isArray(store)
        ? store
        : null;
}
let cachedResponsesConversationModule = null;
async function getResponsesConversationModule() {
    if (!cachedResponsesConversationModule) {
        cachedResponsesConversationModule =
            await importCoreDist("conversion/shared/responses-conversation-store");
    }
    return cachedResponsesConversationModule;
}
export async function captureResponsesRequestContextForRequest(args) {
    const globalStore = readGlobalResponsesConversationStore();
    if (typeof globalStore?.captureRequestContext === "function") {
        globalStore.captureRequestContext(args);
        return;
    }
    const mod = await getResponsesConversationModule();
    const fn = mod.captureResponsesRequestContext;
    if (typeof fn !== "function") {
        throw new Error("[llmswitch-bridge] captureResponsesRequestContext not available");
    }
    fn(args);
}
export async function recordResponsesResponseForRequest(args) {
    const globalStore = readGlobalResponsesConversationStore();
    const fn = typeof globalStore?.recordResponse === "function"
        ? globalStore.recordResponse.bind(globalStore)
        : () => undefined;
    const mod = typeof globalStore?.recordResponse === "function"
        ? null
        : await getResponsesConversationModule();
    const resolvedFn = typeof globalStore?.recordResponse === "function"
        ? fn
        : mod?.recordResponsesResponse;
    if (typeof resolvedFn !== "function") {
        throw new Error("[llmswitch-bridge] recordResponsesResponse not available");
    }
    resolvedFn(args);
}
export async function resumeResponsesConversation(responseId, submitPayload, options) {
    const globalStore = readGlobalResponsesConversationStore();
    if (typeof globalStore?.resumeConversation === "function") {
        return await globalStore.resumeConversation(responseId, submitPayload, options);
    }
    const mod = await getResponsesConversationModule();
    const fn = mod.resumeResponsesConversation;
    if (typeof fn !== "function") {
        throw new Error("[llmswitch-bridge] resumeResponsesConversation not available");
    }
    return await fn(responseId, submitPayload, options);
}
export async function lookupResponsesContinuationByResponseId(responseId, options) {
    const globalStore = readGlobalResponsesConversationStore();
    if (typeof globalStore?.lookupContinuationByResponseId === 'function') {
        return globalStore.lookupContinuationByResponseId(responseId, options);
    }
    const mod = await getResponsesConversationModule();
    const fn = mod.lookupResponsesContinuationByResponseId;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] lookupResponsesContinuationByResponseId not available');
    }
    return fn(responseId, options);
}
export async function rebindResponsesConversationRequestId(oldId, newId) {
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
export async function clearResponsesConversationByRequestId(requestId) {
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
export async function finalizeResponsesConversationRequestRetention(requestId, options) {
    if (!requestId) {
        return;
    }
    const globalStore = readGlobalResponsesConversationStore();
    if (typeof globalStore?.finalizeResponsesConversationRequestRetention ===
        "function") {
        globalStore.finalizeResponsesConversationRequestRetention(requestId, options);
        return;
    }
    const mod = await getResponsesConversationModule();
    const fn = mod.finalizeResponsesConversationRequestRetention;
    if (typeof fn !== "function") {
        throw new Error("[llmswitch-bridge] finalizeResponsesConversationRequestRetention not available");
    }
    fn(requestId, options);
}
export async function resumeLatestResponsesContinuationByScope(args) {
    const globalStore = readGlobalResponsesConversationStore();
    if (typeof globalStore?.resumeLatestContinuationByScope === "function") {
        return globalStore.resumeLatestContinuationByScope(args);
    }
    const mod = await getResponsesConversationModule();
    const fn = mod.resumeLatestResponsesContinuationByScope;
    if (typeof fn !== "function") {
        throw new Error("[llmswitch-bridge] resumeLatestResponsesContinuationByScope not available");
    }
    return fn(args);
}
export async function materializeLatestResponsesContinuationByScope(args) {
    const globalStore = readGlobalResponsesConversationStore();
    if (typeof globalStore?.materializeLatestContinuationByScope === "function") {
        return globalStore.materializeLatestContinuationByScope(args);
    }
    const mod = await getResponsesConversationModule();
    const fn = mod.materializeLatestResponsesContinuationByScope;
    if (typeof fn !== "function") {
        throw new Error("[llmswitch-bridge] materializeLatestResponsesContinuationByScope not available");
    }
    return fn(args);
}
export async function clearAllResponsesConversationState() {
    const globalStore = readGlobalResponsesConversationStore();
    if (typeof globalStore?.clearAll === "function") {
        globalStore.clearAll();
        return;
    }
    const mod = await getResponsesConversationModule();
    const fn = mod.clearAllResponsesConversationState;
    if (typeof fn !== "function") {
        throw new Error("[llmswitch-bridge] clearAllResponsesConversationState not available");
    }
    fn();
}
export async function clearUnresolvedResponsesConversationRequests() {
    const globalStore = readGlobalResponsesConversationStore();
    if (typeof globalStore?.clearUnresolvedRequests === "function") {
        return globalStore.clearUnresolvedRequests();
    }
    if (globalStore?.requestMap instanceof Map &&
        typeof globalStore.detachEntry === "function") {
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
        throw new Error("[llmswitch-bridge] clearUnresolvedResponsesConversationRequests not available");
    }
    return fn();
}
export async function resetResponsesConversationStateForRestartSimulation() {
    const globalStore = readGlobalResponsesConversationStore();
    if (typeof globalStore?.clearAll === "function") {
        globalStore.clearAll();
        return;
    }
    const mod = await getResponsesConversationModule();
    const fn = mod.resetResponsesConversationStateForRestartSimulation;
    if (typeof fn !== "function") {
        throw new Error("[llmswitch-bridge] resetResponsesConversationStateForRestartSimulation not available");
    }
    fn();
}
let cachedResponsesSseToJsonConverterFactory = null;
let cachedResponsesJsonToSseConverterFactory = null;
export async function createResponsesSseToJsonConverter() {
    if (!cachedResponsesSseToJsonConverterFactory) {
        const mod = await importCoreDist("sse/sse-to-json/index");
        const Ctor = mod.ResponsesSseToJsonConverter;
        if (typeof Ctor !== "function") {
            throw new Error("[llmswitch-bridge] ResponsesSseToJsonConverter not available");
        }
        cachedResponsesSseToJsonConverterFactory = () => new Ctor();
    }
    return cachedResponsesSseToJsonConverterFactory();
}
export async function createResponsesJsonToSseConverter() {
    if (!cachedResponsesJsonToSseConverterFactory) {
        const mod = await importCoreDist("sse/json-to-sse/index");
        const Ctor = mod.ResponsesJsonToSseConverter;
        if (typeof Ctor !== "function") {
            throw new Error("[llmswitch-bridge] ResponsesJsonToSseConverter not available");
        }
        cachedResponsesJsonToSseConverterFactory = () => new Ctor();
    }
    return cachedResponsesJsonToSseConverterFactory();
}
let cachedProviderRuntimeIngress = null;
async function getProviderRuntimeIngress() {
    if (!cachedProviderRuntimeIngress) {
        cachedProviderRuntimeIngress =
            await importCoreDist("native/router-hotpath/native-provider-runtime-ingress");
    }
    return cachedProviderRuntimeIngress;
}
export async function preloadCriticalBridgeRuntimeModules() {
    const loaded = [];
    const snapshotHooksModule = await getSnapshotHooksModule();
    if (typeof snapshotHooksModule.writeSnapshotViaHooks !== "function") {
        throw new Error("[llmswitch-bridge] preload failed: writeSnapshotViaHooks not available");
    }
    loaded.push("conversion/snapshot-utils");
    const responsesConversationModule = await getResponsesConversationModule();
    if (typeof responsesConversationModule.resumeResponsesConversation !==
        "function" ||
        typeof responsesConversationModule.resumeLatestResponsesContinuationByScope !==
            "function" ||
        typeof responsesConversationModule.materializeLatestResponsesContinuationByScope !==
            "function") {
        throw new Error("[llmswitch-bridge] preload failed: responses conversation helpers not available");
    }
    loaded.push("conversion/shared/responses-conversation-store");
    const sseToJsonModule = await importCoreDist("sse/sse-to-json/index");
    if (typeof sseToJsonModule.ResponsesSseToJsonConverter !== "function") {
        throw new Error("[llmswitch-bridge] preload failed: ResponsesSseToJsonConverter not available");
    }
    loaded.push("sse/sse-to-json/index");
    const jsonToSseModule = await importCoreDist("sse/json-to-sse/index");
    if (typeof jsonToSseModule.ResponsesJsonToSseConverter !== "function") {
        throw new Error("[llmswitch-bridge] preload failed: ResponsesJsonToSseConverter not available");
    }
    loaded.push("sse/json-to-sse/index");
    const ingressModule = await getProviderRuntimeIngress();
    if (typeof ingressModule.reportProviderErrorToRouterPolicy !== "function" ||
        typeof ingressModule.reportProviderSuccessToRouterPolicy !== "function") {
        throw new Error("[llmswitch-bridge] preload failed: provider runtime ingress hooks not available");
    }
    loaded.push("native/router-hotpath/native-provider-runtime-ingress");
    return { loaded };
}
export async function reportProviderErrorToRouterPolicy(event) {
    const mod = await getProviderRuntimeIngress();
    const fn = mod.reportProviderErrorToRouterPolicy;
    if (typeof fn !== "function") {
        throw new Error("[llmswitch-bridge] reportProviderErrorToRouterPolicy not available");
    }
    return fn(event);
}
export async function reportProviderSuccessToRouterPolicy(event) {
    const mod = await getProviderRuntimeIngress();
    const fn = mod.reportProviderSuccessToRouterPolicy;
    if (typeof fn !== "function") {
        throw new Error("[llmswitch-bridge] reportProviderSuccessToRouterPolicy not available");
    }
    return fn(event);
}
