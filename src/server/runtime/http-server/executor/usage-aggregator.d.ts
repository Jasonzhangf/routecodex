/**
 * Usage Aggregator for request-executor
 *
 * Handles token usage extraction, normalization, and merging.
 */
import type { UsageMetrics } from '../stats-manager.js';
export { type UsageMetrics };
/**
 * Extract usage metrics from provider response
 */
export declare function extractUsageFromResult(result: {
    body?: unknown;
    status?: number;
    headers?: Record<string, string>;
    metadata?: Record<string, unknown>;
}, metadata?: Record<string, unknown>): UsageMetrics | undefined;
/**
 * Normalize usage metrics from various provider formats
 */
export declare function normalizeUsage(value: unknown, options?: {
    sourceProtocol?: string;
}): UsageMetrics | undefined;
/**
 * Merge multiple usage metrics
 */
export declare function mergeUsageMetrics(base?: UsageMetrics, delta?: UsageMetrics): UsageMetrics | undefined;
/**
 * Build usage log text for logging
 */
export declare function computeCacheHitRatio(usage?: UsageMetrics): number | undefined;
export declare function buildUsageLogText(usage?: UsageMetrics): string;
