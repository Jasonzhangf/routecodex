type UsageShape = {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
};
export interface ProviderStatsBucket {
    providerKey: string;
    providerType?: string;
    model?: string;
    entryPort?: number;
    requestCount: number;
    errorCount: number;
    totalLatencyMs: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalOutputTokens: number;
    firstRequestAt: number;
    lastRequestAt: number;
}
export interface ProviderStatsView extends ProviderStatsBucket {
    averageLatencyMs: number;
    averagePromptTokens: number;
    averageCompletionTokens: number;
    averageOutputTokens: number;
}
export interface ToolStatsBucket {
    toolName: string;
    callCount: number;
    responseCount: number;
    firstSeenAt: number;
    lastSeenAt: number;
}
export interface ToolStatsSnapshot {
    totalCalls: number;
    totalResponses: number;
    byToolName: Record<string, ToolStatsBucket>;
    byProviderKey: Record<string, {
        providerKey: string;
        model?: string;
        totalCalls: number;
        totalResponses: number;
        byToolName: Record<string, ToolStatsBucket>;
    }>;
}
export interface StatsSnapshot {
    generatedAt: number;
    uptimeMs: number;
    totals: ProviderStatsView[];
    tools?: ToolStatsSnapshot;
}
export interface HistoricalStatsSnapshot {
    generatedAt: number;
    snapshotCount: number;
    sampleCount: number;
    totals: ProviderStatsView[];
}
export interface HistoricalPeriodBucket {
    period: string;
    requestCount: number;
    errorCount: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalOutputTokens: number;
}
export interface HistoricalPeriodsSnapshot {
    generatedAt: number;
    daily: HistoricalPeriodBucket[];
    weekly: HistoricalPeriodBucket[];
    monthly: HistoricalPeriodBucket[];
}
export type StatsPersistOptions = {
    logPath?: string;
    reason?: string;
};
export declare class StatsManager {
    private readonly inflight;
    private readonly buckets;
    private readonly toolBuckets;
    private readonly toolBucketsByProvider;
    private readonly toolProviderTotals;
    private totalToolCalls;
    private totalToolResponses;
    private readonly enabled;
    private readonly verboseLogging;
    private statsLogPath;
    private historicalBuckets;
    private historicalToolAggregate;
    private historicalToolByProvider;
    private historicalSnapshotCount;
    private historicalSampleCount;
    private historicalLoaded;
    private readonly dailyPeriods;
    private readonly weeklyPeriods;
    private readonly monthlyPeriods;
    private readonly persistIntervalMs;
    private readonly statsLogMaxBytes;
    private readonly statsLogMaxBackups;
    private readonly maxDailyPeriods;
    private readonly maxWeeklyPeriods;
    private readonly maxMonthlyPeriods;
    private readonly inflightTtlMs;
    private readonly inflightMaxEntries;
    private periodicPersistTimer;
    private persistSeq;
    private lastPeriodicSignature;
    private readonly persistSessionId;
    constructor();
    private pruneInflight;
    recordRequestStart(requestId: string): void;
    bindProvider(requestId: string, meta: {
        providerKey?: string;
        providerType?: string;
        model?: string;
        entryPort?: number;
    }): void;
    recordCompletion(requestId: string, options?: {
        usage?: UsageShape;
        error?: boolean;
    }): void;
    recordToolUsage(meta: {
        providerKey?: string;
        model?: string;
    }, payload: unknown): void;
    snapshot(uptimeMs: number): StatsSnapshot;
    logSummary(uptimeMs: number): StatsSnapshot;
    logFinalSummary(uptimeMs: number): {
        session: StatsSnapshot;
        historical: HistoricalStatsSnapshot;
    };
    persistSnapshot(snapshot: StatsSnapshot, options?: StatsPersistOptions): Promise<void>;
    logHistoricalSummary(options?: {
        logPath?: string;
    }): Promise<void>;
    snapshotHistorical(): HistoricalStatsSnapshot;
    snapshotHistoricalPeriods(): HistoricalPeriodsSnapshot;
    private ensureHistoricalLoaded;
    private startPeriodicPersistence;
    private persistPeriodicSnapshot;
    private buildSnapshotSignature;
    private mergeSnapshotIntoPeriods;
    private mergeSnapshotIntoHistorical;
    private loadHistoricalFromDisk;
    private normalizeLogPath;
    private resolveLogPath;
}
export type UsageMetrics = UsageShape;
export {};
