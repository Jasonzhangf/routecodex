import { loadNativeRouterHotpathBinding, resolveNativeModuleUrlFromEnv as resolveNativeModuleUrlFromEnvInLoader } from './native-router-hotpath-loader.js';
function coerceNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function parseNativePayload(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.priorities) || !Array.isArray(parsed.buckets)) {
            return null;
        }
        const buckets = new Map();
        for (const tier of parsed.buckets) {
            const priority = coerceNumber(tier.priority);
            if (priority === undefined) {
                continue;
            }
            const entriesRaw = Array.isArray(tier.entries)
                ? tier.entries
                : [];
            const entries = [];
            for (const item of entriesRaw) {
                if (!item || typeof item !== 'object' || Array.isArray(item)) {
                    continue;
                }
                const row = item;
                const key = typeof row.key === 'string' ? row.key : '';
                const penalty = coerceNumber(row.penalty) ?? 0;
                const order = coerceNumber(row.order) ?? 0;
                if (!key) {
                    continue;
                }
                entries.push({ key, penalty, order });
            }
            buckets.set(priority, entries);
        }
        const priorities = parsed.priorities
            .map((value) => coerceNumber(value))
            .filter((value) => value !== undefined)
            .sort((a, b) => a - b);
        return { priorities, buckets };
    }
    catch {
        return null;
    }
}
function computeQuotaBucketsNative(entries, nowMs) {
    const binding = loadNativeRouterHotpathBinding();
    const fn = binding?.computeQuotaBucketsJson;
    if (typeof fn !== 'function') {
        return null;
    }
    try {
        const resultJson = fn(JSON.stringify(entries), nowMs);
        if (typeof resultJson !== 'string' || !resultJson) {
            return null;
        }
        return parseNativePayload(resultJson);
    }
    catch {
        return null;
    }
}
export function buildQuotaBuckets(entries, nowMs) {
    return buildQuotaBucketsWithMode(entries, nowMs, 'auto');
}
export function buildQuotaBucketsWithMode(entries, nowMs, mode) {
    if (mode !== 'auto' && mode !== 'native-only') {
        throw new Error(`[virtual-router-native-hotpath] unsupported hotpath mode: ${String(mode)}`);
    }
    const nativeResult = computeQuotaBucketsNative(entries, nowMs);
    if (nativeResult) {
        return nativeResult;
    }
    throw new Error('[virtual-router-native-hotpath] native router hotpath is required but unavailable');
}
export function getNativeRouterHotpathSource() {
    const binding = loadNativeRouterHotpathBinding();
    if (typeof binding?.computeQuotaBucketsJson === 'function') {
        return 'native';
    }
    return 'unavailable';
}
export function resolveNativeModuleUrlFromEnv() {
    return resolveNativeModuleUrlFromEnvInLoader();
}
//# sourceMappingURL=native-router-hotpath-quota-buckets.js.map