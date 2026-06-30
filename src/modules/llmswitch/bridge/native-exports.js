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
let cachedChatProcessNodeResultSemantics;
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
    if (typeof raw !== 'string' || raw.length === 0) {
        throw new Error(`[llmswitch-bridge] ${String(capability)} returned empty result`);
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
    if (cachedChatProcessNodeResultSemantics !== undefined) {
        if (!cachedChatProcessNodeResultSemantics) {
            throw new Error('[llmswitch-bridge] native-chat-process-node-result-semantics not available');
        }
        return cachedChatProcessNodeResultSemantics;
    }
    try {
        cachedChatProcessNodeResultSemantics =
            getRouterHotpathJsonBindingSync();
    }
    catch {
        cachedChatProcessNodeResultSemantics = null;
    }
    if (!cachedChatProcessNodeResultSemantics) {
        throw new Error('[llmswitch-bridge] native-chat-process-node-result-semantics not available');
    }
    return cachedChatProcessNodeResultSemantics;
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
