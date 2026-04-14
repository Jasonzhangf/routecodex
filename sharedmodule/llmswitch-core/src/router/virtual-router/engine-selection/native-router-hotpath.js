import { parseAntigravityPinnedAliasLookupPayload, parseAntigravityPinnedAliasUnpinPayload, parseAntigravityCacheSignaturePayload, parseAntigravityRequestSessionMetaPayload, parseAntigravitySessionIdPayload, parseClockClearDirectivePayload, parseChatProcessMediaAnalysisPayload, parseChatProcessMediaStripPayload, parseChatWebSearchIntentPayload, parseContinueExecutionInjectionPayload, parsePendingToolSyncPayload, parseProviderKeyPayload } from './native-router-hotpath-analysis.js';
import { isNativeDisabledByEnv, makeNativeRequiredError } from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBinding } from './native-router-hotpath-loader.js';
export { buildQuotaBuckets, buildQuotaBucketsWithMode, getNativeRouterHotpathSource, resolveNativeModuleUrlFromEnv } from './native-router-hotpath-quota-buckets.js';
function parseAntigravitySplitPayload(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.nonAntigravity) || typeof parsed.hasAntigravity !== 'boolean') {
            return null;
        }
        const nonAntigravity = parsed.nonAntigravity.filter((value) => typeof value === 'string');
        return {
            nonAntigravity,
            hasAntigravity: parsed.hasAntigravity
        };
    }
    catch {
        return null;
    }
}
function toErrorReason(error) {
    return error instanceof Error ? error.message : String(error ?? 'unknown');
}
function requireNativeFunction(capability, exportName) {
    if (isNativeDisabledByEnv()) {
        throw makeNativeRequiredError(capability, 'native disabled');
    }
    const binding = loadNativeRouterHotpathBinding();
    const fn = binding?.[exportName];
    if (typeof fn !== 'function') {
        throw makeNativeRequiredError(capability);
    }
    return fn;
}
function callNativeJson(capability, exportName, args, parse) {
    const fn = requireNativeFunction(capability, exportName);
    let raw;
    try {
        raw = fn(...args);
    }
    catch (error) {
        throw makeNativeRequiredError(capability, toErrorReason(error));
    }
    if (typeof raw !== 'string' || !raw) {
        throw makeNativeRequiredError(capability, 'empty result');
    }
    const parsed = parse(raw);
    if (!parsed) {
        throw makeNativeRequiredError(capability, 'invalid payload');
    }
    return parsed;
}
export function splitAntigravityTargets(targets) {
    const parsed = callNativeJson('splitAntigravityTargetsJson', 'splitAntigravityTargetsJson', [JSON.stringify(targets)], parseAntigravitySplitPayload);
    return { ...parsed, source: 'native' };
}
export function analyzePendingToolSync(messages, afterToolCallIds) {
    const parsed = callNativeJson('analyzePendingToolSyncJson', 'analyzePendingToolSyncJson', [JSON.stringify(messages), JSON.stringify(afterToolCallIds)], parsePendingToolSyncPayload);
    return { ...parsed, source: 'native' };
}
export function analyzeContinueExecutionInjection(messages, marker, targetText) {
    const normalizedMarker = typeof marker === 'string' ? marker.trim() : '';
    const normalizedTargetText = typeof targetText === 'string' ? targetText.trim() : '';
    const parsed = callNativeJson('analyzeContinueExecutionInjectionJson', 'analyzeContinueExecutionInjectionJson', [JSON.stringify(messages), normalizedMarker, normalizedTargetText], parseContinueExecutionInjectionPayload);
    return { ...parsed, source: 'native' };
}
export function stripClockClearDirectiveText(text) {
    const parsed = callNativeJson('stripClockClearDirectiveTextJson', 'stripClockClearDirectiveTextJson', [String(text || '')], parseClockClearDirectivePayload);
    return { ...parsed, source: 'native' };
}
export function analyzeChatProcessMedia(messages) {
    const parsed = callNativeJson('analyzeChatProcessMediaJson', 'analyzeChatProcessMediaJson', [JSON.stringify(messages)], parseChatProcessMediaAnalysisPayload);
    return { ...parsed, source: 'native' };
}
export function stripChatProcessHistoricalImages(messages, placeholderText) {
    const parsed = callNativeJson('stripChatProcessHistoricalImagesJson', 'stripChatProcessHistoricalImagesJson', [JSON.stringify(messages), String(placeholderText || '[Image omitted]')], parseChatProcessMediaStripPayload);
    return { ...parsed, source: 'native' };
}
export function analyzeChatWebSearchIntent(messages) {
    const parsed = callNativeJson('analyzeChatWebSearchIntentJson', 'analyzeChatWebSearchIntentJson', [JSON.stringify(messages)], parseChatWebSearchIntentPayload);
    return { ...parsed, source: 'native' };
}
export function analyzeProviderKey(providerKey) {
    const parsed = callNativeJson('parseProviderKeyJson', 'parseProviderKeyJson', [String(providerKey || '')], parseProviderKeyPayload);
    return { ...parsed, source: 'native' };
}
export function extractAntigravityGeminiSessionIdWithNative(payload) {
    const parsed = callNativeJson('extractAntigravityGeminiSessionIdJson', 'extractAntigravityGeminiSessionIdJson', [JSON.stringify(payload ?? null)], parseAntigravitySessionIdPayload);
    return parsed.sessionId;
}
export function lookupAntigravityPinnedAliasForSessionIdWithNative(sessionId, options) {
    const parsed = callNativeJson('lookupAntigravityPinnedAliasForSessionIdJson', 'lookupAntigravityPinnedAliasForSessionIdJson', [JSON.stringify({ sessionId: String(sessionId || ''), hydrate: options?.hydrate !== false })], parseAntigravityPinnedAliasLookupPayload);
    return parsed.alias;
}
export function unpinAntigravitySessionAliasForSessionIdWithNative(sessionId) {
    const parsed = callNativeJson('unpinAntigravitySessionAliasForSessionIdJson', 'unpinAntigravitySessionAliasForSessionIdJson', [JSON.stringify({ sessionId: String(sessionId || '') })], parseAntigravityPinnedAliasUnpinPayload);
    return parsed.changed;
}
export function cacheAntigravitySessionSignatureWithNative(input) {
    const parsed = callNativeJson('cacheAntigravitySessionSignatureJson', 'cacheAntigravitySessionSignatureJson', [JSON.stringify({
            aliasKey: String(input.aliasKey || ''),
            sessionId: String(input.sessionId || ''),
            signature: String(input.signature || ''),
            messageCount: typeof input.messageCount === 'number' ? Math.floor(input.messageCount) : undefined
        })], parseAntigravityCacheSignaturePayload);
    return parsed.ok;
}
export function getAntigravityRequestSessionMetaWithNative(requestId) {
    return callNativeJson('getAntigravityRequestSessionMetaJson', 'getAntigravityRequestSessionMetaJson', [JSON.stringify({ requestId: String(requestId || '') })], parseAntigravityRequestSessionMetaPayload);
}
export function resetAntigravitySignatureCachesWithNative() {
    const parsed = callNativeJson('resetAntigravitySignatureCachesJson', 'resetAntigravitySignatureCachesJson', ['{}'], parseAntigravityCacheSignaturePayload);
    return parsed.ok;
}
export function loadNativeRouterHotpathBindingForInternalUse() {
    return loadNativeRouterHotpathBinding();
}
//# sourceMappingURL=native-router-hotpath.js.map