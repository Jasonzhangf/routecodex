export { buildQuotaBuckets, buildQuotaBucketsWithMode, getNativeRouterHotpathSource, resolveNativeModuleUrlFromEnv, type QuotaBucketInputEntry, type QuotaBucketResult } from './native-router-hotpath-quota-buckets.js';
export declare function splitAntigravityTargets(targets: string[]): {
    nonAntigravity: string[];
    hasAntigravity: boolean;
    source: 'native';
};
export declare function analyzePendingToolSync(messages: unknown[], afterToolCallIds: string[]): {
    ready: boolean;
    insertAt: number;
    source: 'native';
};
export declare function analyzeContinueExecutionInjection(messages: unknown[], marker: string, targetText: string): {
    hasDirective: boolean;
    source: 'native';
};
export declare function stripClockClearDirectiveText(text: string): {
    hadClear: boolean;
    next: string;
    source: 'native';
};
export declare function analyzeChatProcessMedia(messages: unknown[]): {
    stripIndices: number[];
    containsCurrentTurnImage: boolean;
    source: 'native';
};
export declare function stripChatProcessHistoricalImages(messages: unknown[], placeholderText: string): {
    changed: boolean;
    messages: unknown[];
    source: 'native';
};
export declare function analyzeChatWebSearchIntent(messages: unknown[]): {
    hasIntent: boolean;
    googlePreferred: boolean;
    source: 'native';
};
export declare function analyzeProviderKey(providerKey: string): {
    providerId: string | null;
    alias: string | null;
    keyIndex?: number;
    source: 'native';
};
export declare function extractAntigravityGeminiSessionIdWithNative(payload: unknown): string;
export declare function lookupAntigravityPinnedAliasForSessionIdWithNative(sessionId: string, options?: {
    hydrate?: boolean;
}): string | undefined;
export declare function unpinAntigravitySessionAliasForSessionIdWithNative(sessionId: string): boolean;
export declare function cacheAntigravitySessionSignatureWithNative(input: {
    aliasKey: string;
    sessionId: string;
    signature: string;
    messageCount?: number;
}): boolean;
export declare function getAntigravityRequestSessionMetaWithNative(requestId: string): {
    aliasKey?: string;
    sessionId?: string;
    messageCount?: number;
};
export declare function resetAntigravitySignatureCachesWithNative(): boolean;
export declare function loadNativeRouterHotpathBindingForInternalUse(): unknown;
