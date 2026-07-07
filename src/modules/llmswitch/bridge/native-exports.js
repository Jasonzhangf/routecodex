/**
 * Native Binding Exports Bridge
 *
 * Thin wrappers around llmswitch-core native bindings.
 */
// feature_id: responses.direct_tool_shape_contract
// canonical_builders: evaluate_responses_direct_route_decision_json, has_declared_apply_patch_tool_json
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveCorePackageDir } from '../core-loader.js';
import { importCoreDist, requireCoreDist } from './module-loader.js';
function parseServertoolCliRouteHintCandidate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const record = value;
    const routeHint = typeof record.routeHint === 'string' && record.routeHint.trim()
        ? record.routeHint.trim()
        : typeof record.route_hint === 'string' && record.route_hint.trim()
            ? record.route_hint.trim()
            : undefined;
    return routeHint || undefined;
}
function readServertoolCliRouteHintFromRequestValue(value) {
    if (typeof value === 'string' && value.trim()) {
        try {
            return parseServertoolCliRouteHintCandidate(JSON.parse(value));
        }
        catch {
            return undefined;
        }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const record = value;
    for (const candidate of [
        record.output,
        record.content,
        record.text,
        record.outputText,
    ]) {
        const routeHint = readServertoolCliRouteHintFromRequestValue(candidate);
        if (routeHint) {
            return routeHint;
        }
    }
    return parseServertoolCliRouteHintCandidate(record);
}
let cachedSharedSemantics;
let cachedSharedSemanticsSync;
let cachedRespSemantics;
let cachedFailurePolicyModule;
let cachedHubBridgePolicySemantics;
let cachedHubBridgePolicySemanticsSync;
let cachedRouterHotpathJsonBindingSync;
let cachedHubVrNodeContracts;
let sharedBindingsChecked;
let respBindingsChecked;
function buildFailurePolicyModuleFromRouterHotpathBinding(binding) {
    if (typeof binding.classifyProviderFailureJson !== 'function'
        || typeof binding.resolveProviderRetryExecutionPolicyJson !== 'function') {
        return null;
    }
    return {
        classifyProviderFailure: (statusCode, errorCode, upstreamCode, isNetworkError) => JSON.parse(String(binding.classifyProviderFailureJson(statusCode, errorCode, upstreamCode, isNetworkError))),
        resolveProviderRetryExecutionPolicyNative: (input) => JSON.parse(String(binding.resolveProviderRetryExecutionPolicyJson(JSON.stringify(input)))),
        getNetworkErrorCodes: () => {
            const fn = binding.networkErrorSetJson;
            if (typeof fn !== 'function') {
                throw new Error('[llmswitch-bridge] networkErrorSetJson not available');
            }
            return JSON.parse(String(fn()));
        },
    };
}
function getFailurePolicyModule() {
    if (cachedFailurePolicyModule !== undefined) {
        if (!cachedFailurePolicyModule) {
            throw new Error('[llmswitch-bridge] native-failure-policy not available');
        }
        return cachedFailurePolicyModule;
    }
    try {
        cachedFailurePolicyModule = requireCoreDist('native/router-hotpath/native-failure-policy');
    }
    catch {
        try {
            cachedFailurePolicyModule = buildFailurePolicyModuleFromRouterHotpathBinding(getRouterHotpathJsonBindingSync());
        }
        catch {
            cachedFailurePolicyModule = null;
        }
    }
    if (!cachedFailurePolicyModule) {
        throw new Error('[llmswitch-bridge] native-failure-policy not available');
    }
    return cachedFailurePolicyModule;
}
function getHubVrNodeContracts() {
    if (cachedHubVrNodeContracts !== undefined) {
        if (!cachedHubVrNodeContracts) {
            throw new Error('[llmswitch-bridge] native-hub-vr-node-contracts not available');
        }
        return cachedHubVrNodeContracts;
    }
    try {
        cachedHubVrNodeContracts = requireCoreDist('native/router-hotpath/native-hub-vr-node-contracts');
    }
    catch {
        cachedHubVrNodeContracts = null;
    }
    if (!cachedHubVrNodeContracts) {
        throw new Error('[llmswitch-bridge] native-hub-vr-node-contracts not available');
    }
    return cachedHubVrNodeContracts;
}
async function assertSharedBindings() {
    if (sharedBindingsChecked) {
        return;
    }
    const shared = await getSharedConversionSemantics();
    const missing = [];
    if (typeof shared.mapChatToolsToBridgeWithNative !== 'function') {
        missing.push('mapChatToolsToBridgeJson');
    }
    if (typeof shared.injectMcpToolsForChatWithNative !== 'function') {
        missing.push('injectMcpToolsForChatJson');
    }
    if (typeof shared.injectMcpToolsForResponsesWithNative !== 'function') {
        missing.push('injectMcpToolsForResponsesJson');
    }
    if (typeof shared.normalizeAssistantTextToToolCallsWithNative !== 'function') {
        missing.push('normalizeAssistantTextToToolCallsJson');
    }
    if (typeof shared.captureReqInboundResponsesContextSnapshotWithNative !== 'function') {
        missing.push('captureReqInboundResponsesContextSnapshotJson');
    }
    if (typeof shared.planResponsesHandlerEntryWithNative !== 'function') {
        missing.push('planResponsesHandlerEntryJson');
    }
    if (missing.length > 0) {
        throw new Error(`[llmswitch-bridge] native shared bindings missing: ${missing.join(', ')}`);
    }
    sharedBindingsChecked = true;
}
async function assertRespBindings() {
    if (respBindingsChecked) {
        return;
    }
    const resp = await getRespSemantics();
    const missing = [];
    if (typeof resp.buildAnthropicResponseFromChatWithNative !== 'function') {
        missing.push('buildAnthropicResponseFromChatJson');
    }
    if (missing.length > 0) {
        throw new Error(`[llmswitch-bridge] native resp bindings missing: ${missing.join(', ')}`);
    }
    respBindingsChecked = true;
}
async function getSharedConversionSemantics() {
    if (cachedSharedSemantics !== undefined) {
        if (!cachedSharedSemantics) {
            throw new Error('[llmswitch-bridge] native-shared-conversion-semantics not available');
        }
        return cachedSharedSemantics;
    }
    try {
        cachedSharedSemantics = await importCoreDist('native/router-hotpath/native-shared-conversion-semantics');
    }
    catch {
        cachedSharedSemantics = null;
    }
    if (!cachedSharedSemantics) {
        throw new Error('[llmswitch-bridge] native-shared-conversion-semantics not available');
    }
    return cachedSharedSemantics;
}
function getSharedConversionSemanticsSync() {
    if (cachedSharedSemanticsSync !== undefined) {
        if (!cachedSharedSemanticsSync) {
            throw new Error('[llmswitch-bridge] native-shared-conversion-semantics not available');
        }
        return cachedSharedSemanticsSync;
    }
    try {
        cachedSharedSemanticsSync = requireCoreDist('native/router-hotpath/native-shared-conversion-semantics');
    }
    catch {
        cachedSharedSemanticsSync = null;
    }
    if (!cachedSharedSemanticsSync) {
        throw new Error('[llmswitch-bridge] native-shared-conversion-semantics not available');
    }
    return cachedSharedSemanticsSync;
}
async function getRespSemantics() {
    if (cachedRespSemantics !== undefined) {
        if (!cachedRespSemantics) {
            throw new Error('[llmswitch-bridge] native-hub-pipeline-resp-semantics not available');
        }
        return cachedRespSemantics;
    }
    try {
        cachedRespSemantics = await importCoreDist('native/router-hotpath/native-hub-pipeline-resp-semantics');
    }
    catch {
        cachedRespSemantics = null;
    }
    if (!cachedRespSemantics) {
        throw new Error('[llmswitch-bridge] native-hub-pipeline-resp-semantics not available');
    }
    return cachedRespSemantics;
}
async function getHubBridgePolicySemantics() {
    if (cachedHubBridgePolicySemantics !== undefined) {
        if (!cachedHubBridgePolicySemantics) {
            throw new Error('[llmswitch-bridge] native-hub-bridge-policy-semantics not available');
        }
        return cachedHubBridgePolicySemantics;
    }
    try {
        cachedHubBridgePolicySemantics = await importCoreDist('native/router-hotpath/native-hub-bridge-policy-semantics');
    }
    catch {
        cachedHubBridgePolicySemantics = null;
    }
    if (!cachedHubBridgePolicySemantics) {
        throw new Error('[llmswitch-bridge] native-hub-bridge-policy-semantics not available');
    }
    return cachedHubBridgePolicySemantics;
}
function getHubBridgePolicySemanticsSync() {
    if (cachedHubBridgePolicySemanticsSync !== undefined) {
        if (!cachedHubBridgePolicySemanticsSync) {
            throw new Error('[llmswitch-bridge] native-hub-bridge-policy-semantics not available');
        }
        return cachedHubBridgePolicySemanticsSync;
    }
    try {
        cachedHubBridgePolicySemanticsSync = requireCoreDist('native/router-hotpath/native-hub-bridge-policy-semantics');
    }
    catch {
        cachedHubBridgePolicySemanticsSync = null;
    }
    if (!cachedHubBridgePolicySemanticsSync) {
        throw new Error('[llmswitch-bridge] native-hub-bridge-policy-semantics not available');
    }
    return cachedHubBridgePolicySemanticsSync;
}
export function getRouterHotpathJsonBindingSync() {
    if (cachedRouterHotpathJsonBindingSync !== undefined) {
        if (!cachedRouterHotpathJsonBindingSync) {
            throw new Error('[llmswitch-bridge] router_hotpath_napi native binding not available');
        }
        return cachedRouterHotpathJsonBindingSync;
    }
    try {
        const packageDir = resolveCorePackageDir('ts');
        const candidates = [
            path.join(packageDir, 'rust-core', 'target', 'release', 'router_hotpath_napi.node'),
            path.join(packageDir, 'rust-core', 'target', 'debug', 'router_hotpath_napi.node'),
            path.join(packageDir, 'dist', 'native', 'router_hotpath_napi.node'),
            path.join(packageDir, 'router_hotpath_napi.node'),
        ];
        const requireFromPackage = createRequire(path.join(packageDir, 'package.json'));
        for (const candidate of candidates) {
            try {
                const loaded = requireFromPackage(candidate);
                if (loaded && typeof loaded === 'object') {
                    cachedRouterHotpathJsonBindingSync = loaded;
                    return cachedRouterHotpathJsonBindingSync;
                }
            }
            catch {
                // try the next canonical native artifact location
            }
        }
    }
    catch {
        cachedRouterHotpathJsonBindingSync = null;
    }
    cachedRouterHotpathJsonBindingSync = null;
    throw new Error('[llmswitch-bridge] router_hotpath_napi native binding not available');
}
function stringifyNativeJsonArg(capability, value) {
    try {
        return JSON.stringify(value) ?? 'null';
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error ?? 'unknown');
        throw new Error(`[llmswitch-bridge] ${capability} JSON stringify failed: ${detail}`);
    }
}
function invokeRouterHotpathJsonCapability(capability, args) {
    const binding = getRouterHotpathJsonBindingSync();
    const fn = binding[capability];
    if (typeof fn !== 'function') {
        throw new Error(`[llmswitch-bridge] ${String(capability)} not available`);
    }
    const encodedArgs = args.map((arg) => stringifyNativeJsonArg(String(capability), arg));
    const raw = fn(...encodedArgs);
    if (raw instanceof Error) {
        throw new Error(`[llmswitch-bridge] ${String(capability)} native error: ${raw.message || 'unknown error'}`);
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.message === 'string') {
        throw new Error(`[llmswitch-bridge] ${String(capability)} native error: ${String(raw.message)}`);
    }
    if (typeof raw !== 'string' || raw.length === 0) {
        throw new Error(`[llmswitch-bridge] ${String(capability)} returned non-string or empty result`);
    }
    try {
        return JSON.parse(raw);
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error ?? 'unknown');
        throw new Error(`[llmswitch-bridge] ${String(capability)} JSON parse failed: ${detail}`);
    }
}
function assertNativeObject(capability, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`[llmswitch-bridge] ${String(capability)} returned invalid payload`);
    }
    return value;
}
function getChatProcessNodeResultSemantics() {
    return getRouterHotpathJsonBindingSync();
}
export async function mapChatToolsToBridgeJson(rawTools) {
    await assertSharedBindings();
    const mod = await getSharedConversionSemantics();
    const fn = mod.mapChatToolsToBridgeWithNative;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] mapChatToolsToBridgeJson not available');
    }
    return fn(rawTools);
}
export async function injectMcpToolsForChatJson(tools, discoveredServers) {
    await assertSharedBindings();
    const mod = await getSharedConversionSemantics();
    const fn = mod.injectMcpToolsForChatWithNative;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] injectMcpToolsForChatJson not available');
    }
    return fn(Array.isArray(tools) ? tools : [], Array.isArray(discoveredServers) ? discoveredServers : []);
}
export async function injectMcpToolsForResponsesJson(tools, discoveredServers) {
    await assertSharedBindings();
    const mod = await getSharedConversionSemantics();
    const fn = mod.injectMcpToolsForResponsesWithNative;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] injectMcpToolsForResponsesJson not available');
    }
    return fn(Array.isArray(tools) ? tools : [], Array.isArray(discoveredServers) ? discoveredServers : []);
}
export async function normalizeAssistantTextToToolCallsJson(message, options) {
    await assertSharedBindings();
    const mod = await getSharedConversionSemantics();
    const fn = mod.normalizeAssistantTextToToolCallsWithNative;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] normalizeAssistantTextToToolCallsJson not available');
    }
    return fn(message, options);
}
export function captureReqInboundResponsesContextSnapshotJson(input) {
    const mod = getSharedConversionSemanticsSync();
    const fn = mod.captureReqInboundResponsesContextSnapshotWithNative;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] captureReqInboundResponsesContextSnapshotJson not available');
    }
    return fn(input);
}
export function stripResponsesStoredContextInputMediaNative(inputEntries, placeholderText = '[Image omitted]') {
    const mod = getSharedConversionSemanticsSync();
    const fn = mod.stripResponsesStoredContextInputMediaWithNative;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] stripResponsesStoredContextInputMediaNative not available');
    }
    return fn(inputEntries, placeholderText);
}
export async function captureReqInboundResponsesContextSnapshot(input) {
    await assertSharedBindings();
    const mod = await getSharedConversionSemantics();
    const fn = mod.captureReqInboundResponsesContextSnapshotWithNative;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] captureReqInboundResponsesContextSnapshotJson not available');
    }
    return fn(input);
}
export async function planResponsesHandlerEntry(payload, entryEndpoint, responseIdFromPath) {
    await assertSharedBindings();
    const mod = await getSharedConversionSemantics();
    const fn = mod.planResponsesHandlerEntryWithNative;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] planResponsesHandlerEntryJson not available');
    }
    return fn(payload, entryEndpoint, responseIdFromPath);
}
export async function materializeProviderOwnedSubmitContext(input) {
    await assertSharedBindings();
    const mod = await getSharedConversionSemantics();
    const fn = mod.materializeProviderOwnedSubmitContextWithNative;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] materializeProviderOwnedSubmitContextJson not available');
    }
    return fn(input.payload);
}
export async function planResponsesRequestContext(input) {
    await assertSharedBindings();
    const mod = await getSharedConversionSemantics();
    const fn = mod.planResponsesRequestContextWithNative;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] planResponsesRequestContextJson not available');
    }
    return fn(input);
}
export async function planResponsesContinuationRequestAction(input) {
    await assertSharedBindings();
    const mod = await getSharedConversionSemantics();
    const fn = mod.planResponsesContinuationRequestActionWithNative;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] planResponsesContinuationRequestActionJson not available');
    }
    return fn(input);
}
export async function buildAnthropicResponseFromChatJson(chatResponse, aliasMap) {
    await assertRespBindings();
    const mod = await getRespSemantics();
    const fn = mod.buildAnthropicResponseFromChatWithNative;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] buildAnthropicResponseFromChatJson not available');
    }
    return fn(chatResponse, aliasMap);
}
export async function sanitizeProviderOutboundPayload(input) {
    const mod = await getHubBridgePolicySemantics();
    const fn = mod.sanitizeProviderOutboundPayloadWithNative;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] sanitizeProviderOutboundPayloadWithNative not available');
    }
    return fn(input);
}
export function hasDeclaredApplyPatchToolNative(payload) {
    const parsed = invokeRouterHotpathJsonCapability('hasDeclaredApplyPatchToolJson', [payload ?? null]);
    const row = assertNativeObject('hasDeclaredApplyPatchToolJson', parsed);
    return row.hasDeclaredApplyPatchTool === true;
}
export function evaluateSingletonRoutePoolExhaustionNative(input) {
    const parsed = invokeRouterHotpathJsonCapability('evaluateSingletonRoutePoolExhaustionJson', [
        {
            pipelineError: input.pipelineError ?? null,
            initialRoutePoolLen: typeof input.initialRoutePoolLen === 'number' && Number.isFinite(input.initialRoutePoolLen)
                ? Math.max(0, Math.floor(input.initialRoutePoolLen))
                : undefined,
            explicitSingletonPool: input.explicitSingletonPool === true,
            excludedProviderCount: Math.max(0, Math.floor(input.excludedProviderCount || 0)),
        }
    ]);
    return assertNativeObject('evaluateSingletonRoutePoolExhaustionJson', parsed);
}
export function resolveErrorErr05RouteAvailabilityDecisionNative(input) {
    const excludedProviderKeys = input.excludedProviderKeys instanceof Set
        ? Array.from(input.excludedProviderKeys)
        : Array.isArray(input.excludedProviderKeys) ? input.excludedProviderKeys : [];
    const parsed = invokeRouterHotpathJsonCapability('resolveErrorErr05RouteAvailabilityDecisionJson', [
        {
            routeName: typeof input.routeName === 'string' ? input.routeName : undefined,
            routePool: Array.isArray(input.routePool) ? input.routePool : [],
            routeTiers: Array.isArray(input.routeTiers) ? input.routeTiers : [],
            defaultRouteTiers: Array.isArray(input.defaultRouteTiers) ? input.defaultRouteTiers : [],
            excludedProviderKeys,
            providerKey: typeof input.providerKey === 'string' ? input.providerKey : undefined,
            routingDecisionRoutePoolPresent: input.routingDecisionRoutePoolPresent === true,
        }
    ]);
    return assertNativeObject('resolveErrorErr05RouteAvailabilityDecisionJson', parsed);
}
export function planPrimaryExhaustedToDefaultPoolNative(input) {
    const parsed = invokeRouterHotpathJsonCapability('planPrimaryExhaustedToDefaultPoolJson', [
        {
            route: String(input.route || ''),
            tiers: Array.isArray(input.tiers) ? input.tiers : [],
            exhaustedTargets: Array.isArray(input.exhaustedTargets) ? input.exhaustedTargets : [],
            knownTargets: Array.isArray(input.knownTargets) ? input.knownTargets : [],
        }
    ]);
    return assertNativeObject('planPrimaryExhaustedToDefaultPoolJson', parsed);
}
export function convertResponsesRequestToChatNative(payload, options) {
    const parsed = invokeRouterHotpathJsonCapability('runResponsesOpenaiRequestCodecJson', [
        payload,
        options ?? {},
    ]);
    return assertNativeObject('runResponsesOpenaiRequestCodecJson', parsed);
}
export function evaluateResponsesDirectRouteDecisionNative(input) {
    const parsed = invokeRouterHotpathJsonCapability('evaluateResponsesDirectRouteDecisionJson', [
        input.payload ?? {},
        input.metadata ?? {},
        input.inboundProtocol ?? '',
        input.applyPatchMode ?? '',
    ]);
    return assertNativeObject('evaluateResponsesDirectRouteDecisionJson', parsed);
}
export function buildResponsesPayloadFromChatNative(payload, context) {
    const parsed = invokeRouterHotpathJsonCapability('buildResponsesPayloadFromChatJson', [
        payload ?? null,
        context ?? null,
    ]);
    return assertNativeObject('buildResponsesPayloadFromChatJson', parsed);
}
export function projectResponsesClientPayloadForClientNative(args) {
    const parsed = invokeRouterHotpathJsonCapability('projectResponsesClientPayloadForClientJson', [
        args.payload ?? null,
        Array.isArray(args.toolsRaw) ? args.toolsRaw : [],
        args.metadata ?? null,
        args.context ?? null,
    ]);
    return assertNativeObject('projectResponsesClientPayloadForClientJson', parsed);
}
export function planResponsesJsonClientDispatchNative(input) {
    const parsed = invokeRouterHotpathJsonCapability('planResponsesJsonClientDispatchJson', [
        input ?? null,
    ]);
    return assertNativeObject('planResponsesJsonClientDispatchJson', parsed);
}
export function projectResponsesSseFrameForClientNative(args) {
    const parsed = invokeRouterHotpathJsonCapability('projectResponsesSseFrameForClientJson', [
        args.frame ?? '',
        args.eventName ?? null,
        args.data ?? null,
        Array.isArray(args.toolsRaw) ? args.toolsRaw : [],
        args.metadata ?? {},
        args.state ?? {
            pendingApplyPatchArgumentDeltas: {},
            applyPatchCallIds: [],
            emittedApplyPatchDoneCallIds: [],
        },
    ]);
    return assertNativeObject('projectResponsesSseFrameForClientJson', parsed);
}
export function projectSseErrorEventPayloadNative(args) {
    const parsed = invokeRouterHotpathJsonCapability('projectSseErrorEventPayloadJson', [
        {
            requestId: args.requestId,
            status: Number.isFinite(args.status) ? Math.floor(args.status) : args.status,
            message: args.message,
            code: args.code,
            error: args.error,
        }
    ]);
    const row = assertNativeObject('projectSseErrorEventPayloadJson', parsed);
    const error = row.error;
    if (row.type !== 'error'
        || typeof row.status !== 'number'
        || !error
        || typeof error !== 'object'
        || Array.isArray(error)
        || typeof error.message !== 'string'
        || typeof error.code !== 'string'
        || typeof error.request_id !== 'string') {
        throw new Error('[llmswitch-bridge] projectSseErrorEventPayloadJson returned invalid payload');
    }
    return row;
}
export function describeHubPipelineContractsNative() {
    const fn = getHubVrNodeContracts().describeHubPipelineContractsWithNative;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] describeHubPipelineContractsWithNative not available');
    }
    return fn();
}
export function describeVirtualRouterContractsNative() {
    const fn = getHubVrNodeContracts().describeVirtualRouterContractsWithNative;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] describeVirtualRouterContractsWithNative not available');
    }
    return fn();
}
export function describeMetaCarrierContractsNative() {
    const fn = getHubVrNodeContracts().describeMetaCarrierContractsWithNative;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] describeMetaCarrierContractsWithNative not available');
    }
    return fn();
}
export function describePipelineContractNative(nodeId) {
    const fn = getHubVrNodeContracts().describePipelineContractWithNative;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] describePipelineContractWithNative not available');
    }
    return fn(nodeId);
}
export function validatePipelineNodeContractBoundaryNative(nodeId, before, after) {
    const fn = getHubVrNodeContracts().validatePipelineNodeContractBoundaryWithNative;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] validatePipelineNodeContractBoundaryWithNative not available');
    }
    return fn(nodeId, before, after);
}
export function classifyProviderFailure(statusCode, errorCode, upstreamCode, isNetworkError) {
    const fn = getFailurePolicyModule().classifyProviderFailure;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] classifyProviderFailure not available');
    }
    return fn(statusCode, errorCode, upstreamCode, isNetworkError);
}
export function deriveFinishReasonNative(body) {
    const fn = getChatProcessNodeResultSemantics().deriveFinishReasonJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] deriveFinishReasonJson not available');
    }
    const raw = fn(JSON.stringify(body ?? null));
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : undefined;
}
export function isToolCallContinuationResponseNative(body) {
    const fn = getChatProcessNodeResultSemantics().isToolCallContinuationResponseJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] isToolCallContinuationResponseJson not available');
    }
    return Boolean(fn(JSON.stringify(body ?? null)));
}
export function isEmptyClientResponsePayloadNative(body) {
    const fn = getChatProcessNodeResultSemantics().isEmptyClientResponsePayloadJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] isEmptyClientResponsePayloadJson not available');
    }
    return Boolean(fn(JSON.stringify(body ?? null)));
}

export function hasRequestedToolsInSemanticsNative(requestSemantics) {
    const fn = getChatProcessNodeResultSemantics().hasRequestedToolsInSemanticsJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] hasRequestedToolsInSemanticsJson not available');
    }
    return Boolean(fn(JSON.stringify(requestSemantics ?? null)));
}

export function isRequiredToolCallTurnNative(requestSemantics) {
    const fn = getChatProcessNodeResultSemantics().isRequiredToolCallTurnJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] isRequiredToolCallTurnJson not available');
    }
    return Boolean(fn(JSON.stringify(requestSemantics ?? null)));
}

export function isToolResultFollowupTurnNative(requestSemantics) {
    const fn = getChatProcessNodeResultSemantics().isToolResultFollowupTurnJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] isToolResultFollowupTurnJson not available');
    }
    return Boolean(fn(JSON.stringify(requestSemantics ?? null)));
}

export function isProviderNativeResumeContinuationNative(requestSemantics) {
    const fn = getChatProcessNodeResultSemantics().isProviderNativeResumeContinuationJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] isProviderNativeResumeContinuationJson not available');
    }
    return Boolean(fn(JSON.stringify(requestSemantics ?? null)));
}

export function detectRetryableEmptyAssistantResponseNative(body, requestSemantics) {
    const fn = getChatProcessNodeResultSemantics().detectRetryableEmptyAssistantResponseJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] detectRetryableEmptyAssistantResponseJson not available');
    }
    const raw = fn(JSON.stringify(body ?? null), JSON.stringify(requestSemantics ?? null));
    if (!raw) {
        return null;
    }
    const parsed = JSON.parse(raw);
    return parsed === null ? null : parsed;
}


export function validateApplyPatchArgumentsNative(applyPatchArgsSource) {
    const fn = getRouterHotpathJsonBindingSync().validateApplyPatchArgumentsJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] validateApplyPatchArgumentsJson not available');
    }
    return JSON.parse(fn(JSON.stringify(applyPatchArgsSource ?? null)));
}
export function classifyEmptyResponseSignalNative(stage, body) {
    const fn = getChatProcessNodeResultSemantics().classifyEmptyResponseSignalJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] classifyEmptyResponseSignalJson not available');
    }
    const raw = fn(String(stage || ''), JSON.stringify(body ?? null));
    const parsed = JSON.parse(raw);
    if (parsed === null) {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('[llmswitch-bridge] classifyEmptyResponseSignalJson returned invalid payload');
    }
    return parsed;
}
export function detectToolExecutionFailuresNative(body) {
    const fn = getChatProcessNodeResultSemantics().detectToolExecutionFailuresJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] detectToolExecutionFailuresJson not available');
    }
    const raw = fn(JSON.stringify(body ?? null));
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
        throw new Error('[llmswitch-bridge] detectToolExecutionFailuresJson returned invalid payload');
    }
    return parsed;
}
export function resolveProviderResponseRequestSemanticsNative(processed, standardized, requestMetadata) {
    const fn = getChatProcessNodeResultSemantics().resolveProviderResponseRequestSemanticsJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] resolveProviderResponseRequestSemanticsJson not available');
    }
    const raw = fn(JSON.stringify(processed ?? null), JSON.stringify(standardized ?? null), JSON.stringify(requestMetadata ?? null));
    const parsed = JSON.parse(raw);
    if (parsed === null) {
        return undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('[llmswitch-bridge] resolveProviderResponseRequestSemanticsJson returned invalid payload');
    }
    return parsed;
}
export function updateResponsesContractProbeFromSseChunkNative(chunk, probe) {
    const fn = getChatProcessNodeResultSemantics().updateResponsesContractProbeFromSseChunkJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] updateResponsesContractProbeFromSseChunkJson not available');
    }
    const raw = fn(JSON.stringify(typeof chunk === 'string' ? chunk : String(chunk ?? '')), JSON.stringify(probe ?? {}));
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('[llmswitch-bridge] updateResponsesContractProbeFromSseChunkJson returned invalid payload');
    }
    return parsed;
}
export function updateResponsesSseTransportTerminalStateNative(input) {
    const fn = getChatProcessNodeResultSemantics().updateResponsesSseTransportTerminalStateJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] updateResponsesSseTransportTerminalStateJson not available');
    }
    const raw = fn(JSON.stringify(typeof input.chunk === 'string' ? input.chunk : String(input.chunk ?? '')), JSON.stringify(input.state ?? {}), input.flushRemainder === true);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('[llmswitch-bridge] updateResponsesSseTransportTerminalStateJson returned invalid payload');
    }
    const state = parsed.state;
    const sawTerminalEvent = parsed.sawTerminalEvent;
    if (!state || typeof state !== 'object' || Array.isArray(state) || typeof sawTerminalEvent !== 'boolean') {
        throw new Error('[llmswitch-bridge] updateResponsesSseTransportTerminalStateJson returned invalid shape');
    }
    return {
        state,
        observedTerminal: sawTerminalEvent,
    };
}
export function buildResponsesTerminalSseFramesFromProbeNative(probe, requestLabel) {
    const fn = getChatProcessNodeResultSemantics().buildResponsesTerminalSseFramesFromProbeJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] buildResponsesTerminalSseFramesFromProbeJson not available');
    }
    const raw = fn(JSON.stringify(probe ?? {}), String(requestLabel || 'unknown'));
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((frame) => typeof frame === 'string')) {
        throw new Error('[llmswitch-bridge] buildResponsesTerminalSseFramesFromProbeJson returned invalid payload');
    }
    return parsed;
}
export function extractServertoolCliResultRouteHintFromRequestNative(input) {
    const adapterContext = input.adapterContext && typeof input.adapterContext === 'object' && !Array.isArray(input.adapterContext)
        ? input.adapterContext
        : undefined;
    const rawRequestBody = adapterContext?.__raw_request_body
        && typeof adapterContext.__raw_request_body === 'object'
        && !Array.isArray(adapterContext.__raw_request_body)
        ? adapterContext.__raw_request_body
        : undefined;
    if (!rawRequestBody) {
        return undefined;
    }
    const toolOutputs = Array.isArray(rawRequestBody.tool_outputs) ? rawRequestBody.tool_outputs : [];
    for (const item of toolOutputs) {
        const routeHint = readServertoolCliRouteHintFromRequestValue(item);
        if (routeHint) {
            return routeHint;
        }
    }
    const inputItems = Array.isArray(rawRequestBody.input) ? rawRequestBody.input : [];
    for (const item of inputItems) {
        const routeHint = readServertoolCliRouteHintFromRequestValue(item);
        if (routeHint) {
            return routeHint;
        }
    }
    return undefined;
}
export function isBlockingRecoverableNative(classification, stage) {
    const fn = getFailurePolicyModule().isBlockingRecoverableNative;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] isBlockingRecoverableNative not available');
    }
    return fn(classification, stage);
}
export function shouldRetryNative(classification, attempt, maxAttempts) {
    const fn = getFailurePolicyModule().shouldRetryNative;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] shouldRetryNative not available');
    }
    return fn(classification, attempt, maxAttempts);
}
export function computeBackoffMsNative(classification, attempt) {
    const fn = getFailurePolicyModule().computeBackoffMsNative;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] computeBackoffMsNative not available');
    }
    return fn(classification, attempt);
}
export function resolveProviderRetryExecutionPolicyNative(input) {
    const fn = getFailurePolicyModule().resolveProviderRetryExecutionPolicyNative;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] resolveProviderRetryExecutionPolicyNative not available');
    }
    return fn(input);
}
export function getNetworkErrorCodes() {
    const fn = getFailurePolicyModule().getNetworkErrorCodes;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] getNetworkErrorCodes not available');
    }
    return fn();
}
export function normalizeExplicitRoutePoolNative(value) {
    const parsed = invokeRouterHotpathJsonCapability('normalizeExplicitRoutePoolJson', [value]);
    const result = assertNativeObject('normalizeExplicitRoutePoolJson', parsed);
    return Array.isArray(result.pool) ? result.pool : [];
}
export function mergeObservedRoutePoolChainNative(existing, observed) {
    const existingJson = existing !== null ? JSON.stringify(existing) : null;
    const observedJson = JSON.stringify(observed);
    const binding = getRouterHotpathJsonBindingSync();
    const fn = binding.mergeObservedRoutePoolChainJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] mergeObservedRoutePoolChainJson not available');
    }
    const raw = fn(existingJson, observedJson);
    if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
        return null;
    }
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
export function resolveEntryProtocolFromEndpointNative(entryEndpoint) {
    const binding = getRouterHotpathJsonBindingSync();
    const fn = binding.resolveEntryProtocolFromEndpointJson;
    if (typeof fn !== 'function') {
        throw new Error('[llmswitch-bridge] resolveEntryProtocolFromEndpointJson not available');
    }
    return fn(entryEndpoint);
}

// === SERVERTOOL ORCHESTRATION WRAPPERS (Phase 3) ===
// 63 wrappers: bridge native-chat-process-servertool-orchestration-semantics.ts -> native-exports.js

export function detectEmptyAssistantPayloadContractSignalWithNative(payload) {
  return invokeRouterHotpathJsonCapability('detectEmptyAssistantPayloadContractSignalJson', [payload]);
}

export function detectProviderResponseShapeWithNative(payload) {
  return invokeRouterHotpathJsonCapability('detectProviderResponseShapeJson', [payload]);
}

export function containsSyntheticRouteCodexControlTextWithNative(payload) {
  return invokeRouterHotpathJsonCapability('containsSyntheticRoutecodexControlTextJson', [payload]);
}

export function planChatWebSearchOperationsWithNative(input) {
  return invokeRouterHotpathJsonCapability('planChatWebSearchOperationsJson', [input]);
}

export function runServertoolResponseStageWithNative(payload, requestId) {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.runServertoolResponseStageJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] runServertoolResponseStageJson not available');
  }
  const payloadJson = JSON.stringify(payload);
  let raw;
  try {
    raw = fn(payloadJson, requestId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`[llmswitch-bridge] runServertoolResponseStageJson native error: ${detail}`);
  }
  if (raw instanceof Error) {
    throw new Error(`[llmswitch-bridge] runServertoolResponseStageJson native error: ${raw.message || 'unknown error'}`);
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.message === 'string') {
    throw new Error(`[llmswitch-bridge] runServertoolResponseStageJson native error: ${String(raw.message)}`);
  }
  if (typeof raw !== 'string') {
    throw new Error('[llmswitch-bridge] runServertoolResponseStageJson returned non-string result');
  }
  const rawText = raw.trimStart();
  if (rawText.startsWith('Error:')) {
    throw new Error(rawText);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`[llmswitch-bridge] runServertoolResponseStageJson JSON parse failed: ${detail}; raw=${raw}`);
  }
}

export function planServertoolResponseStageGateWithNative(input) {
  return invokeRouterHotpathJsonCapability('planServertoolResponseStageGateJson', [input]);
}

export function getDefaultServertoolSkeletonDocumentWithNative() {
  return invokeRouterHotpathJsonCapability('getDefaultServertoolSkeletonDocumentJson', []);
}

export function planServertoolSkeletonDerivedConfigWithNative(input) {
  return invokeRouterHotpathJsonCapability('planServertoolSkeletonDerivedConfigJson', [input]);
}

export function readServertoolPrimaryAutoHookIdsWithNative(input) {
  const derivedConfig = planServertoolSkeletonDerivedConfigWithNative(input);
  const autoHookQueueConfig = derivedConfig.autoHookQueueConfig;
  if (!autoHookQueueConfig || typeof autoHookQueueConfig !== 'object' || Array.isArray(autoHookQueueConfig)) {
    throw new Error('[llmswitch-bridge] readServertoolPrimaryAutoHookIdsWithNative: missing autoHookQueueConfig');
  }
  const optionalPrimaryOrder = autoHookQueueConfig.optionalPrimaryOrder;
  if (!Array.isArray(optionalPrimaryOrder)) {
    throw new Error('[llmswitch-bridge] readServertoolPrimaryAutoHookIdsWithNative: missing optionalPrimaryOrder');
  }
  return optionalPrimaryOrder.filter((entry) => typeof entry === 'string');
}

export function buildServertoolDispatchPlanInputWithNative(input) {
  return invokeRouterHotpathJsonCapability('buildServertoolDispatchPlanInputJson', [input]);
}

export function buildServertoolOutcomePlanInputWithNative(input) {
  return invokeRouterHotpathJsonCapability('buildServertoolOutcomePlanInputJson', [input]);
}

export function planServertoolHandlerContractWithNative(input) {
  return invokeRouterHotpathJsonCapability('planServertoolHandlerContractJson', [input]);
}

export function normalizeServertoolRegistrationSpecWithNative(input) {
  return invokeRouterHotpathJsonCapability('normalizeServertoolRegistrationSpecJson', [input]);
}

export function resolveServertoolToolSpecWithNative(input) {
  return invokeRouterHotpathJsonCapability('resolveServertoolToolSpecJson', [input]);
}

export function planServertoolBuiltinHandlerEntryWithNative(input) {
  return invokeRouterHotpathJsonCapability('planServertoolBuiltinHandlerEntryJson', [input]);
}

export function resolveServertoolBuiltinHandlerEntryWithNative(input) {
  return invokeRouterHotpathJsonCapability('resolveServertoolBuiltinHandlerEntryJson', [input]);
}

export function planServertoolBuiltinHandlerNamesWithNative(input) {
  return invokeRouterHotpathJsonCapability('planServertoolBuiltinHandlerNamesJson', [input]);
}

export function planServertoolBuiltinAutoHandlerEntriesWithNative(input) {
  return invokeRouterHotpathJsonCapability('planServertoolBuiltinAutoHandlerEntriesJson', [input]);
}

export function planServertoolBuiltinHandlerRecordEntriesWithNative(input) {
  return invokeRouterHotpathJsonCapability('planServertoolBuiltinHandlerRecordEntriesJson', [input]);
}

export function planServertoolRegistryLookupFromSkeletonWithNative(input) {
  return invokeRouterHotpathJsonCapability('planServertoolRegistryLookupFromSkeletonJson', [input]);
}

export function resolveServertoolRegistryHandlerWithNative(input) {
  return invokeRouterHotpathJsonCapability('resolveServertoolRegistryHandlerJson', [input]);
}

export function resolveServertoolRegisteredNameWithNative(input) {
  return invokeRouterHotpathJsonCapability('resolveServertoolRegisteredNameJson', [input]);
}

export function resolveServertoolProgressToolNameWithNative(input) {
  return invokeRouterHotpathJsonCapability('resolveServertoolProgressToolNameJson', [input]);
}

export function shouldUseServertoolGoldProgressHighlightWithNative(input) {
  return invokeRouterHotpathJsonCapability('shouldUseServertoolGoldProgressHighlightJson', [input]);
}

export function resolveServertoolProgressStageWithNative(input) {
  return invokeRouterHotpathJsonCapability('resolveServertoolProgressStageJson', [input]);
}

export function normalizeServertoolProgressResultWithNative(input) {
  return invokeRouterHotpathJsonCapability('normalizeServertoolProgressResultJson', [input]);
}

export function normalizeServertoolProgressTokenWithNative(input) {
  return invokeRouterHotpathJsonCapability('normalizeServertoolProgressTokenJson', [input]);
}

export function normalizeServertoolProgressFlowIdWithNative(input) {
  return invokeRouterHotpathJsonCapability('normalizeServertoolProgressFlowIdJson', [input]);
}

export function buildServertoolMatchSkippedProgressEventWithNative(input) {
  return invokeRouterHotpathJsonCapability('buildServertoolMatchSkippedProgressEventJson', [input]);
}

export function buildServertoolAutoHookTraceProgressEventWithNative(input) {
  return invokeRouterHotpathJsonCapability('buildServertoolAutoHookTraceProgressEventJson', [input]);
}

export function buildServertoolStopEntryProgressEventWithNative(input) {
  return invokeRouterHotpathJsonCapability('buildServertoolStopEntryProgressEventJson', [input]);
}

export function buildServertoolStopCompareProgressEventWithNative(input) {
  return invokeRouterHotpathJsonCapability('buildServertoolStopCompareProgressEventJson', [input]);
}

export function planServertoolToolCallDispatchWithNative(input) {
  return invokeRouterHotpathJsonCapability('planServertoolToolCallDispatchJson', [input]);
}

export function planServertoolOutcomeWithNative(input) {
  return invokeRouterHotpathJsonCapability('planServertoolOutcomeJson', [input]);
}

export function planServertoolNoopOutcomeWithNative(input) {
  return invokeRouterHotpathJsonCapability('planServertoolNoopOutcomeJson', [input]);
}

export function planServertoolAutoHookQueuesWithNative(input) {
  return invokeRouterHotpathJsonCapability('planServertoolAutoHookQueuesJson', [input]);
}

export function planServertoolAutoHookQueueItemsWithNative(input) {
  return invokeRouterHotpathJsonCapability('planServertoolAutoHookQueueItemsJson', [input]);
}

export function runServertoolOrchestrationMutationWithNative(input) {
  return invokeRouterHotpathJsonCapability('runServertoolOrchestrationMutationJson', [input]);
}

export function planServertoolFollowupRuntimeWithNative(flowId) {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.planServertoolFollowupRuntimeJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] planServertoolFollowupRuntimeJson not available');
  }
  const raw = fn(flowId);
  return JSON.parse(raw);
}

export function extractCapturedChatSeedWithNative(captured) {
  return invokeRouterHotpathJsonCapability('extractCapturedChatSeedJson', [captured]);
}

export function buildServertoolReq04FollowupPayloadWithNative(adapterContext) {
  return invokeRouterHotpathJsonCapability('buildServertoolReq04FollowupPayloadJson', [adapterContext]);
}

export function resolveFollowupModelWithNative(seedModel, adapterContext) {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.resolveFollowupModelJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] resolveFollowupModelJson not available');
  }
  const raw = fn(JSON.stringify(seedModel), JSON.stringify(adapterContext));
  return raw;
}

export function normalizeFollowupParametersWithNative(parameters) {
  return invokeRouterHotpathJsonCapability('normalizeFollowupParametersJson', [parameters]);
}

export function extractAssistantFollowupMessageWithNative(finalChatResponse) {
  return invokeRouterHotpathJsonCapability('extractAssistantFollowupMessageJson', [finalChatResponse]);
}

export function applyFollowupDeltaPlanWithNative(input) {
  return invokeRouterHotpathJsonCapability('applyFollowupDeltaPlanJson', [input]);
}

export function buildServertoolToolOutputPayloadWithNative(input) {
  return invokeRouterHotpathJsonCapability('buildServertoolToolOutputPayloadJson', [input]);
}

export function buildServertoolHandlerErrorToolOutputPayloadWithNative(input) {
  return invokeRouterHotpathJsonCapability('buildServertoolHandlerErrorToolOutputPayloadJson', [input]);
}

export function collectServertoolAdditionalClientToolCallsWithNative(input) {
  return invokeRouterHotpathJsonCapability('collectServertoolAdditionalClientToolCallsJson', [input]);
}

export function isServertoolClientExecCliProjectionToolCallWithNative(input) {
  return invokeRouterHotpathJsonCapability('isServertoolClientExecCliProjectionToolCallJson', [input]);
}

export function webSearchIsGeminiEngineWithNative(providerKey) {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.webSearchIsGeminiEngine;
  if (typeof fn !== 'function') {
    return false;
  }
  const raw = fn(JSON.stringify(providerKey));
  return raw === 'true';
}

export function webSearchIsQwenEngineWithNative(providerKey) {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.webSearchIsQwenEngine;
  if (typeof fn !== 'function') {
    return false;
  }
  const raw = fn(JSON.stringify(providerKey));
  return raw === 'true';
}

export function webSearchIsGlmEngineWithNative(providerKey) {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.webSearchIsGlmEngine;
  if (typeof fn !== 'function') {
    return false;
  }
  const raw = fn(JSON.stringify(providerKey));
  return raw === 'true';
}

export function webSearchNormalizeResultCountWithNative(valueJson) {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.webSearchNormalizeResultCountJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] webSearchNormalizeResultCountJson not available');
  }
  const raw = fn(valueJson);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('[llmswitch-bridge] webSearchNormalizeResultCountJson: invalid result');
  }
  return n;
}

export function webSearchBuildSystemPromptWithNative(targetCount) {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.webSearchBuildSystemPrompt;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] webSearchBuildSystemPrompt not available');
  }
  const raw = fn(targetCount);
  return raw;
}

export function webSearchSanitizeBackendErrorWithNative(message) {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.webSearchSanitizeBackendErrorJson;
  if (typeof fn !== 'function') {
    return message;
  }
  const raw = fn(message);
  return raw;
}

export function webSearchCollectHitsWithNative(chatResponseJson, targetCount) {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.webSearchCollectHitsJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] webSearchCollectHitsJson not available');
  }
  const raw = fn(chatResponseJson, targetCount);
  return raw;
}

export function webSearchFormatHitsSummaryWithNative(hitsJson) {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.webSearchFormatHitsSummaryJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] webSearchFormatHitsSummaryJson not available');
  }
  const raw = fn(hitsJson);
  return raw;
}

export function webSearchLimitHitsWithNative(hitsJson) {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.webSearchLimitHitsJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] webSearchLimitHitsJson not available');
  }
  const raw = fn(hitsJson);
  return raw;
}

export function webSearchExtractAssistantMessageWithNative(chatResponseJson) {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.webSearchExtractAssistantMessageJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] webSearchExtractAssistantMessageJson not available');
  }
  const raw = fn(chatResponseJson);
  return raw;
}

export function webSearchBuildToolMessagesWithNative(chatResponseJson) {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.webSearchBuildToolMessagesJson;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] webSearchBuildToolMessagesJson not available');
  }
  const raw = fn(chatResponseJson);
  return raw;
}

export function visionBuildAnalysisPayloadWithNative(sourceJson) {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.visionBuildAnalysisPayloadJson;
  if (typeof fn !== 'function') {
    return 'null';
  }
  try {
    const raw = fn(sourceJson);
    return typeof raw === 'string' ? raw : 'null';
  } catch {
    return 'null';
  }
}

export function visionBuildPinnedMetadataWithNative(adapterContextJson, payloadJson) {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.visionBuildPinnedMetadataJson;
  if (typeof fn !== 'function') {
    return 'null';
  }
  try {
    const raw = fn(adapterContextJson, payloadJson);
    return typeof raw === 'string' ? raw : 'null';
  } catch {
    return 'null';
  }
}

export function visionExtractOriginalUserPromptWithNative(messagesJson) {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.visionExtractOriginalUserPromptJson;
  if (typeof fn !== 'function') {
    return '';
  }
  try {
    const raw = fn(messagesJson);
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

export function readFollowupClientInjectSourceWithNative(adapterContext) {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.readFollowupClientInjectSourceJson;
  if (typeof fn !== 'function') {
    return '';
  }
  try {
    const ctxJson = JSON.stringify(adapterContext);
    const raw = fn(ctxJson);
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

// === SERVERTOOL CORE BRIDGE WRAPPERS (Phase 4) ===
// 50 wrappers: inline native-only functions through router-hotpath JSON capabilities.

export function extractTextFromChatLikeWithNative(input) {
  return invokeRouterHotpathJsonCapability('extractServertoolTextFromChatLikeJson', [input]);
}

export function inspectStopGatewaySignalWithNative(input) {
  return invokeRouterHotpathJsonCapability('inspectStopGatewaySignal', [input]);
}

export function normalizeStopGatewayContextWithNative(input) {
  return invokeRouterHotpathJsonCapability('normalizeStopGatewayContextJson', [input]);
}

export function extractStopMessageBlockedReportFromMessagesWithNative(input) {
  return invokeRouterHotpathJsonCapability('extractStopMessageBlockedReportFromMessagesJson', [input]);
}

export function normalizeStopMessageCompareContextWithNative(input) {
  return invokeRouterHotpathJsonCapability('normalizeStopMessageCompareContextJson', [input]);
}

export function formatStopMessageCompareContextWithNative(input) {
  return invokeRouterHotpathJsonCapability('formatStopMessageCompareContextJson', [input]);
}

export function evaluateLoopGuardWithNative(input) {
  return invokeRouterHotpathJsonCapability('evaluateLoopGuard', [input]);
}

export function calculateBudgetWithNative(observed, stop_eligible, snapshot, default_config) {
  const binding = getRouterHotpathJsonBindingSync();
  const fn = binding.calculateBudget;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] calculateBudget not available');
  }
  const resultJson = fn(
    observed,
    stop_eligible,
    snapshot ? JSON.stringify(snapshot) : undefined,
    default_config ? JSON.stringify(default_config) : undefined
  );
  if (typeof resultJson !== 'string') {
    throw new Error('[llmswitch-bridge] calculateBudget returned non-string');
  }
  return JSON.parse(resultJson);
}

export function planBudgetStateUpdateWithNative(input) {
  return invokeRouterHotpathJsonCapability('planBudgetStateUpdateJson', [input]);
}

export function resolveStopMessageSessionScopeWithNative(input) {
  return invokeRouterHotpathJsonCapability('resolveStopMessageSessionScopeJson', [input]);
}

export function resolveServertoolStickyKeyWithNative(input) {
  return invokeRouterHotpathJsonCapability('resolveServertoolStickyKeyJson', [input]);
}

export function resolveServertoolStateKeyWithNative(input) {
  return invokeRouterHotpathJsonCapability('resolveServertoolStateKeyJson', [input]);
}

export function resolveRuntimeStopMessageStateWithNative(input) {
  return invokeRouterHotpathJsonCapability('resolveRuntimeStopMessageStateJson', [input]);
}

export function readRuntimeStopMessageStageModeWithNative(input) {
  return invokeRouterHotpathJsonCapability('readRuntimeStopMessageStageModeJson', [input]);
}

export function normalizeStopMessageStageModeValueWithNative(input) {
  return invokeRouterHotpathJsonCapability('normalizeStopMessageStageModeValueJson', [input]);
}

export function hasArmedStopMessageStateWithNative(input) {
  return invokeRouterHotpathJsonCapability('hasArmedStopMessageStateJson', [input]);
}

export function planStopMessageRoutingSnapshotWithNative(input) {
  return invokeRouterHotpathJsonCapability('planStopMessageRoutingSnapshotJson', [input]);
}

export function planStopMessageRoutingStateApplyWithNative(input) {
  return invokeRouterHotpathJsonCapability('planStopMessageRoutingStateApplyJson', [input]);
}

export function planStopMessageRoutingStateClearWithNative(input) {
  return invokeRouterHotpathJsonCapability('planStopMessageRoutingStateClearJson', [input]);
}

export function buildClientExecCliProjectionOutputWithNative(input) {
  return invokeRouterHotpathJsonCapability('buildClientExecCliProjectionOutputJson', [input]);
}

export function parseServertoolCliProjectionToolArgumentsWithNative(input) {
  return invokeRouterHotpathJsonCapability('parseServertoolCliProjectionToolArgumentsJson', [input]);
}

export function normalizeStoplessTriggerHintForMetadataWithNative(input) {
  return invokeRouterHotpathJsonCapability('normalizeStoplessTriggerHintForMetadataJson', [input]);
}

export function planStoplessLearnedNoteWriteWithNative(input) {
  return invokeRouterHotpathJsonCapability('planStoplessLearnedNoteWriteJson', [input]);
}

export function validateServertoolHookSkeletonPhaseWithNative(input) {
  return invokeRouterHotpathJsonCapability('validateServertoolHookSkeletonPhaseJson', [input]);
}

export function planServertoolHookScheduleWithNative(input) {
  return invokeRouterHotpathJsonCapability('planServertoolHookScheduleJson', [input]);
}

export function buildClientVisibleProjectionShellWithNative(input) {
  return invokeRouterHotpathJsonCapability('buildClientVisibleProjectionShellJson', [input]);
}

export function buildServertoolCliProjectionExecutionContextWithNative(input) {
  return invokeRouterHotpathJsonCapability('buildServertoolCliProjectionExecutionContextJson', [input]);
}

export function buildServertoolCliProjectionRuntimeBranchWithNative(input) {
  return invokeRouterHotpathJsonCapability('buildServertoolCliProjectionRuntimeBranchJson', [input]);
}

export function validateClientExecCommandResultWithNative(input) {
  return invokeRouterHotpathJsonCapability('validateClientExecCommandResultJson', [input]);
}

export function resolveRuntimeStopMessageStateFromMetadataCenterWithNative(input) {
  return invokeRouterHotpathJsonCapability('resolveRuntimeStopMessageStateFromMetadataCenterJson', [input]);
}

export function resolveBdWorkingDirectoryForRecordWithNative(input) {
  return invokeRouterHotpathJsonCapability('resolveBdWorkingDirectoryForRecordJson', [input]);
}

export function resolveStopMessageFollowupProviderKeyWithNative(input) {
  return invokeRouterHotpathJsonCapability('resolveStopMessageFollowupProviderKeyJson', [input]);
}

export function resolveClientConnectionStateWithNative(input) {
  return invokeRouterHotpathJsonCapability('resolveClientConnectionStateJson', [input]);
}

export function hasCompactionFlagWithNative(input) {
  return invokeRouterHotpathJsonCapability('hasCompactionFlagJson', [input]);
}

export function resolveEntryEndpointWithNative(input) {
  return invokeRouterHotpathJsonCapability('resolveEntryEndpointJson', [input]);
}

export function resolveDefaultStopMessageSnapshotWithNative(input) {
  return invokeRouterHotpathJsonCapability('resolveDefaultStopMessageSnapshotJson', [input]);
}

export function resolveImplicitGeminiStopMessageSnapshotWithNative(input) {
  return invokeRouterHotpathJsonCapability('resolveImplicitGeminiStopMessageSnapshotJson', [input]);
}

export function readServertoolLoopStateWithNative(input) {
  return invokeRouterHotpathJsonCapability('readServertoolLoopStateJson', [input]);
}

export function planServertoolLoopStateWithNative(input) {
  return invokeRouterHotpathJsonCapability('planServertoolLoopStateJson', [input]);
}

export function parseServertoolTimeoutMsWithNative(input) {
  return invokeRouterHotpathJsonCapability('parseServertoolTimeoutMsJson', [input]);
}

export function planServertoolTimeoutWatcherWithNative(input) {
  return invokeRouterHotpathJsonCapability('planServertoolTimeoutWatcherJson', [input]);
}

export function isAdapterClientDisconnectedWithNative(input) {
  return invokeRouterHotpathJsonCapability('isAdapterClientDisconnectedJson', [input]);
}

export function planClientDisconnectWatcherWithNative(input) {
  return invokeRouterHotpathJsonCapability('planClientDisconnectWatcherJson', [input]);
}

export function createServertoolExecutionLoopStateWithNative(input) {
  return invokeRouterHotpathJsonCapability('createServertoolExecutionLoopStateJson', [input]);
}

export function readClientInjectOnlyWithNative(input) {
  return invokeRouterHotpathJsonCapability('readClientInjectOnlyJson', [input]);
}

export function normalizeClientInjectTextWithNative(input) {
  return invokeRouterHotpathJsonCapability('normalizeClientInjectTextJson', [input]);
}

export function compactFollowupErrorReasonWithNative(input) {
  return invokeRouterHotpathJsonCapability('compactFollowupErrorReasonJson', [input]);
}

export function resolveAdapterContextProviderKeyWithNative(input) {
  return invokeRouterHotpathJsonCapability('resolveAdapterContextProviderKeyJson', [input]);
}

export function extractCurrentAssistantReasoningStopArgumentsWithNative(input) {
  return invokeRouterHotpathJsonCapability('extractCurrentAssistantReasoningStopArgumentsJson', [input]);
}

export function stripStopSchemaControlTextWithNative(input) {
  return invokeRouterHotpathJsonCapability('stripStopSchemaControlTextJson', [input]);
}
