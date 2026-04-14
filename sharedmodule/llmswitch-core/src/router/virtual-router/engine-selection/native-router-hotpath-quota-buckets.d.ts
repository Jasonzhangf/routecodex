export type QuotaBucketInputEntry = {
    key: string;
    order: number;
    hasQuota: boolean;
    inPool: boolean;
    cooldownUntil?: number;
    blacklistUntil?: number;
    priorityTier?: number;
    selectionPenalty?: number;
};
type QuotaBucketOutputEntry = {
    key: string;
    penalty: number;
    order: number;
};
export type QuotaBucketResult = {
    priorities: number[];
    buckets: Map<number, QuotaBucketOutputEntry[]>;
};
type HotpathMode = 'auto' | 'native-only';
export declare function buildQuotaBuckets(entries: QuotaBucketInputEntry[], nowMs: number): QuotaBucketResult;
export declare function buildQuotaBucketsWithMode(entries: QuotaBucketInputEntry[], nowMs: number, mode: HotpathMode | string): QuotaBucketResult;
export declare function getNativeRouterHotpathSource(): 'native' | 'unavailable';
export declare function resolveNativeModuleUrlFromEnv(): string | undefined;
export {};
