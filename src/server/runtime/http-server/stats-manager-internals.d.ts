export { buildHistoricalProviderRow, buildSessionProviderRow, formatIso, formatProviderLabel, logProviderSummaryTable } from './stats-manager-table.js';
export type UsageShapeLike = {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
};
export type ProviderStatsBucketLike = {
    providerKey: string;
    providerType?: string;
    model?: string;
    requestCount: number;
    errorCount: number;
    totalLatencyMs: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalOutputTokens: number;
    firstRequestAt: number;
    lastRequestAt: number;
};
export type ProviderStatsViewLike = ProviderStatsBucketLike & {
    averageLatencyMs: number;
    averagePromptTokens: number;
    averageCompletionTokens: number;
    averageOutputTokens: number;
};
export type ToolStatsBucketLike = {
    toolName: string;
    callCount: number;
    responseCount: number;
    firstSeenAt: number;
    lastSeenAt: number;
};
export type ToolStatsSnapshotLike = {
    totalCalls: number;
    totalResponses: number;
    byToolName: Record<string, ToolStatsBucketLike>;
    byProviderKey: Record<string, {
        providerKey: string;
        model?: string;
        totalCalls: number;
        totalResponses: number;
        byToolName: Record<string, ToolStatsBucketLike>;
    }>;
};
export type StatsSnapshotLike = {
    generatedAt: number;
    uptimeMs: number;
    totals: ProviderStatsViewLike[];
    tools?: ToolStatsSnapshotLike;
};
type HistoricalToolProviderBucket = {
    providerKey: string;
    model?: string;
    totalCalls: number;
    totalResponses: number;
    byToolName: Map<string, ToolStatsBucketLike>;
};
export declare function composeBucketKey(providerKey: string, model?: string, entryPort?: number): string;
export declare function computeProviderTotals(buckets: Map<string, ProviderStatsBucketLike>): ProviderStatsViewLike[];
export declare function snapshotTools(options: {
    totalToolCalls: number;
    totalToolResponses: number;
    toolBuckets: Map<string, ToolStatsBucketLike>;
    toolBucketsByProvider: Map<string, Map<string, ToolStatsBucketLike>>;
    toolProviderTotals: Map<string, {
        providerKey: string;
        model?: string;
        totalCalls: number;
        totalResponses: number;
    }>;
}): ToolStatsSnapshotLike | undefined;
export declare function logToolSummary(snapshot: ToolStatsSnapshotLike | undefined, formatLabel: (providerKey?: string, model?: string) => string): void;
export declare function logHistoricalToolSummary(toolAggregate: Map<string, ToolStatsBucketLike>, toolByProvider: Map<string, HistoricalToolProviderBucket>, formatLabel: (providerKey?: string, model?: string) => string): void;
export declare function mergeToolAggregate(toolAggregate: Map<string, ToolStatsBucketLike>, toolByProvider: Map<string, HistoricalToolProviderBucket>, tools: ToolStatsSnapshotLike): void;
export declare function extractToolCalls(payload: unknown): Array<{
    name: string;
    id?: string;
}>;
export declare function mergeSnapshotIntoHistorical(options: {
    snapshot?: StatsSnapshotLike | null;
    historicalBuckets: Map<string, ProviderStatsBucketLike>;
    historicalToolAggregate: Map<string, ToolStatsBucketLike>;
    historicalToolByProvider: Map<string, HistoricalToolProviderBucket>;
    historicalSnapshotCount: number;
    historicalSampleCount: number;
}): {
    historicalSnapshotCount: number;
    historicalSampleCount: number;
};
export declare function logHistoricalFromMemory(options: {
    historicalBuckets: Map<string, ProviderStatsBucketLike>;
    historicalSnapshotCount: number;
    historicalSampleCount: number;
    historicalToolAggregate: Map<string, ToolStatsBucketLike>;
    historicalToolByProvider: Map<string, HistoricalToolProviderBucket>;
}): void;
