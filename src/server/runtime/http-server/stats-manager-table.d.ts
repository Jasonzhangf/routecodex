import type { ProviderStatsBucketLike, ProviderStatsViewLike } from './stats-manager-internals.js';
export declare function buildSessionProviderRow(bucket: ProviderStatsViewLike): Record<string, string>;
export declare function buildHistoricalProviderRow(bucket: ProviderStatsBucketLike): Record<string, string>;
export declare function logProviderSummaryTable(rows: Array<Record<string, string>>, includeWindow: boolean): void;
export declare function formatProviderLabel(providerKey?: string, model?: string): string;
export declare function formatIso(value?: number): string;
