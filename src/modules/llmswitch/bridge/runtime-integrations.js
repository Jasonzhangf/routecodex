/**
 * Runtime Integrations Bridge
 *
 * Snapshot hooks, responses conversation helpers, native SSE runtime, and
 * provider runtime ingress hooks.
 */
import { getRouterHotpathJsonBindingSync, shouldRecordSnapshotsNative, writeSnapshotViaHooksNative } from "./native-exports.js";
import { captureResponsesRequestContext, recordResponsesResponse, resumeResponsesConversation as resumeResponsesConversationHost, lookupResponsesContinuationByResponseId as lookupResponsesContinuationByResponseIdHost, resumeLatestResponsesContinuationByScope as resumeLatestResponsesContinuationByScopeHost, materializeLatestResponsesContinuationByScope as materializeLatestResponsesContinuationByScopeHost, rebindResponsesConversationRequestId as rebindResponsesConversationRequestIdHost, clearResponsesConversationByRequestId as clearResponsesConversationByRequestIdHost, finalizeResponsesConversationRequestRetention as finalizeResponsesConversationRequestRetentionHost, clearAllResponsesConversationState as clearAllResponsesConversationStateHost, resetResponsesConversationStateForRestartSimulation as resetResponsesConversationStateForRestartSimulationHost, clearUnresolvedResponsesConversationRequests as clearUnresolvedResponsesConversationRequestsHost, } from "./responses-conversation-store-host.js";
export async function writeSnapshotViaHooks(channelOrOptions, payload) {
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
    writeSnapshotViaHooksNative(options);
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
function nativeJsonBinding() {
    return getRouterHotpathJsonBindingSync();
}
function requireNativeJsonFunction(capability) {
    const fn = nativeJsonBinding()[capability];
    if (typeof fn !== "function") {
        throw new Error(`[llmswitch-bridge] ${capability} not available`);
    }
    return fn;
}
async function collectSseBodyText(source) {
    const chunks = [];
    for await (const chunk of source) {
        chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    }
    return chunks.join("");
}
function buildJsonFromSseWithNative(input) {
    const fn = requireNativeJsonFunction("buildJsonFromSseJson");
    const raw = fn(JSON.stringify({
        protocol: input.protocol,
        body_text: input.bodyText,
        request_id: input.requestId,
        model: input.model,
        config: input.config ?? {},
    }));
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("[llmswitch-bridge] buildJsonFromSseJson returned invalid result");
    }
    return parsed;
}
export async function buildResponsesJsonFromSseStreamWithNative(input) {
    const bodyText = await collectSseBodyText(input.stream);
    return buildJsonFromSseWithNative({
        protocol: "openai-responses",
        bodyText,
        requestId: input.requestId,
        model: input.model,
        config: input.config ?? {},
    });
}
function reportProviderRuntimeIngressWithNative(capability, event) {
    const fn = requireNativeJsonFunction(capability);
    return JSON.parse(fn(JSON.stringify(event)));
}
export async function preloadCriticalBridgeRuntimeModules() {
    const loaded = [];
    shouldRecordSnapshotsNative();
    loaded.push("native/router-hotpath/snapshot-hooks");
    await resumeLatestResponsesContinuationByScopeHost({ payload: {}, entryKind: "responses" });
    loaded.push("bridge/responses-conversation-store-host");
    requireNativeJsonFunction("buildJsonFromSseJson");
    loaded.push("native-json/sse-runtime");
    requireNativeJsonFunction("reportProviderErrorToRouterPolicyJson");
    requireNativeJsonFunction("reportProviderSuccessToRouterPolicyJson");
    loaded.push("native-json/provider-runtime-ingress");
    return { loaded };
}
export async function reportProviderErrorToRouterPolicy(event) {
    return reportProviderRuntimeIngressWithNative("reportProviderErrorToRouterPolicyJson", event);
}
export async function reportProviderSuccessToRouterPolicy(event) {
    return reportProviderRuntimeIngressWithNative("reportProviderSuccessToRouterPolicyJson", event);
}
//# sourceMappingURL=runtime-integrations.js.map
