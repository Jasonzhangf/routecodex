/**
 * Runtime Integrations Bridge
 *
 * Snapshot hooks, responses conversation helpers, native SSE runtime, and
 * provider runtime ingress hooks.
 */
import { importCoreDist } from "./module-loader.js";
import { captureResponsesRequestContext, recordResponsesResponse, resumeResponsesConversation as resumeResponsesConversationHost, lookupResponsesContinuationByResponseId as lookupResponsesContinuationByResponseIdHost, resumeLatestResponsesContinuationByScope as resumeLatestResponsesContinuationByScopeHost, materializeLatestResponsesContinuationByScope as materializeLatestResponsesContinuationByScopeHost, rebindResponsesConversationRequestId as rebindResponsesConversationRequestIdHost, clearResponsesConversationByRequestId as clearResponsesConversationByRequestIdHost, finalizeResponsesConversationRequestRetention as finalizeResponsesConversationRequestRetentionHost, clearAllResponsesConversationState as clearAllResponsesConversationStateHost, resetResponsesConversationStateForRestartSimulation as resetResponsesConversationStateForRestartSimulationHost, clearUnresolvedResponsesConversationRequests as clearUnresolvedResponsesConversationRequestsHost, } from "./responses-conversation-store-host.js";
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
export async function captureResponsesRequestContextForRequest(args) {
    captureResponsesRequestContext(args);
}
export async function recordResponsesResponseForRequest(args) {
    recordResponsesResponse(args);
}
export async function resumeResponsesConversation(responseId, submitPayload, options) {
    return resumeResponsesConversationHost(responseId, submitPayload, options);
}
export async function lookupResponsesContinuationByResponseId(responseId, options) {
    return lookupResponsesContinuationByResponseIdHost(responseId, options);
}
export async function rebindResponsesConversationRequestId(oldId, newId) {
    if (!oldId || !newId || oldId === newId) {
        return;
    }
    rebindResponsesConversationRequestIdHost(oldId, newId);
}
export async function clearResponsesConversationByRequestId(requestId) {
    if (!requestId) {
        return;
    }
    clearResponsesConversationByRequestIdHost(requestId);
}
export async function finalizeResponsesConversationRequestRetention(requestId, options) {
    if (!requestId) {
        return;
    }
    finalizeResponsesConversationRequestRetentionHost(requestId, options);
}
export async function resumeLatestResponsesContinuationByScope(args) {
    return resumeLatestResponsesContinuationByScopeHost(args);
}
export async function materializeLatestResponsesContinuationByScope(args) {
    return materializeLatestResponsesContinuationByScopeHost(args);
}
export async function clearAllResponsesConversationState() {
    clearAllResponsesConversationStateHost();
}
export async function clearUnresolvedResponsesConversationRequests() {
    return clearUnresolvedResponsesConversationRequestsHost();
}
export async function resetResponsesConversationStateForRestartSimulation() {
    resetResponsesConversationStateForRestartSimulationHost();
}
let cachedNativeSseRuntimeModule = null;
async function getNativeSseRuntimeModule() {
    if (!cachedNativeSseRuntimeModule) {
        cachedNativeSseRuntimeModule = await importCoreDist("native/router-hotpath/native-sse-runtime");
    }
    return cachedNativeSseRuntimeModule;
}
export async function buildResponsesJsonFromSseStreamWithNative(input) {
    const mod = await getNativeSseRuntimeModule();
    if (typeof mod.collectSseBodyText !== "function" ||
        typeof mod.buildJsonFromSseWithNative !== "function") {
        throw new Error("[llmswitch-bridge] native SSE runtime decode helpers not available");
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
    await resumeLatestResponsesContinuationByScopeHost({ payload: {}, entryKind: "responses" });
    loaded.push("bridge/responses-conversation-store-host");
    const nativeSseRuntimeModule = await getNativeSseRuntimeModule();
    if (typeof nativeSseRuntimeModule.collectSseBodyText !== "function" ||
        typeof nativeSseRuntimeModule.buildJsonFromSseWithNative !== "function") {
        throw new Error("[llmswitch-bridge] preload failed: native SSE runtime decode helpers not available");
    }
    loaded.push("native/router-hotpath/native-sse-runtime");
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
//# sourceMappingURL=runtime-integrations.js.map