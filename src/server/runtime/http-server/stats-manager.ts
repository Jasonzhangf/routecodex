import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildInfo } from '../../../build-info.js';
import {
  buildHistoricalProviderRow,
  buildSessionProviderRow,
  composeBucketKey,
  computeProviderTotals,
  extractToolCalls,
  formatProviderLabel,
  logHistoricalFromMemory,
  logProviderSummaryTable,
  logToolSummary,
  mergeSnapshotIntoHistorical,
  snapshotTools
} from './stats-manager-internals.js';

type UsageShape = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type ProviderSample = {
  providerKey?: string;
  providerType?: string;
  model?: string;
  startTime: number;
};

export interface ProviderStatsBucket {
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

export type StatsPersistOptions = {
  logPath?: string;
  reason?: string;
};

const DEFAULT_STATS_LOG_PATH = path.join(os.homedir(), '.routecodex', 'logs', 'provider-stats.jsonl');

function resolveBoolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function isStatsEnabledByDefault(): boolean {
  return resolveBoolFromEnv(
    process.env.ROUTECODEX_STATS_ENABLED ?? process.env.RCC_STATS_ENABLED,
    buildInfo.mode !== 'release'
  );
}

function isStatsVerboseEnabled(enabled: boolean): boolean {
  return resolveBoolFromEnv(
    process.env.ROUTECODEX_STATS_VERBOSE ?? process.env.RCC_STATS_VERBOSE,
    enabled && buildInfo.mode !== 'release'
  );
}

export class StatsManager {
  private readonly inflight = new Map<string, ProviderSample>();
  private readonly buckets = new Map<string, ProviderStatsBucket>();
  private readonly toolBuckets = new Map<string, ToolStatsBucket>();
  private readonly toolBucketsByProvider = new Map<string, Map<string, ToolStatsBucket>>();
  private readonly toolProviderTotals = new Map<string, {
    providerKey: string;
    model?: string;
    totalCalls: number;
    totalResponses: number;
  }>();
  private totalToolCalls = 0;
  private totalToolResponses = 0;
  private readonly enabled: boolean;
  private readonly verboseLogging: boolean;
  private statsLogPath: string;
  private historicalBuckets = new Map<string, ProviderStatsBucket>();
  private historicalToolAggregate = new Map<string, ToolStatsBucket>();
  private historicalToolByProvider = new Map<string, {
    providerKey: string;
    model?: string;
    totalCalls: number;
    totalResponses: number;
    byToolName: Map<string, ToolStatsBucket>;
  }>();
  private historicalSnapshotCount = 0;
  private historicalSampleCount = 0;
  private historicalLoaded = false;

  constructor() {
    this.enabled = isStatsEnabledByDefault();
    this.verboseLogging = isStatsVerboseEnabled(this.enabled);
    this.statsLogPath = this.resolveLogPath();
    if (this.enabled) {
      this.loadHistoricalFromDisk(this.statsLogPath, true);
    }
  }

  recordRequestStart(requestId: string): void {
    if (!this.enabled || !requestId) {
      return;
    }
    this.inflight.set(requestId, { startTime: Date.now() });
  }

  bindProvider(requestId: string, meta: { providerKey?: string; providerType?: string; model?: string }): void {
    if (!this.enabled || !requestId) {
      return;
    }
    const sample = this.inflight.get(requestId);
    if (sample) {
      if (meta.providerKey) {sample.providerKey = meta.providerKey;}
      if (meta.providerType) {sample.providerType = meta.providerType;}
      if (meta.model) {sample.model = meta.model;}
      return;
    }
    this.inflight.set(requestId, { startTime: Date.now(), ...meta });
  }

  recordCompletion(requestId: string, options?: { usage?: UsageShape; error?: boolean }): void {
    if (!this.enabled || !requestId) {
      return;
    }
    const sample = this.inflight.get(requestId);
    this.inflight.delete(requestId);
    if (!sample?.providerKey) {
      return;
    }
    const key = composeBucketKey(sample.providerKey, sample.model);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      const now = Date.now();
      bucket = {
        providerKey: sample.providerKey,
        providerType: sample.providerType,
        model: sample.model,
        requestCount: 0,
        errorCount: 0,
        totalLatencyMs: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalOutputTokens: 0,
        firstRequestAt: sample.startTime ?? now,
        lastRequestAt: now
      } satisfies ProviderStatsBucket;
      this.buckets.set(key, bucket);
    }
    bucket.requestCount += 1;
    if (options?.error) {
      bucket.errorCount += 1;
    }
    const latency = Date.now() - (sample.startTime ?? Date.now());
    bucket.totalLatencyMs += latency;
    bucket.lastRequestAt = Date.now();
    if (options?.usage) {
      const usage = options.usage;
      bucket.totalPromptTokens += usage.prompt_tokens ?? 0;
      bucket.totalCompletionTokens += usage.completion_tokens ?? 0;
      bucket.totalOutputTokens += usage.total_tokens ?? 0;
    }
  }

  recordToolUsage(meta: { providerKey?: string; model?: string }, payload: unknown): void {
    if (!this.enabled) {
      return;
    }
    const providerKey = typeof meta.providerKey === 'string' && meta.providerKey.trim() ? meta.providerKey.trim() : '';
    if (!providerKey) {
      return;
    }
    const toolCalls = extractToolCalls(payload);
    if (!toolCalls.length) {
      return;
    }
    const now = Date.now();
    this.totalToolCalls += toolCalls.length;
    this.totalToolResponses += 1;

    const providerBucketKey = composeBucketKey(providerKey, meta.model);
    const providerTotals = this.toolProviderTotals.get(providerBucketKey) ?? {
      providerKey,
      model: meta.model,
      totalCalls: 0,
      totalResponses: 0
    };
    providerTotals.totalCalls += toolCalls.length;
    providerTotals.totalResponses += 1;
    this.toolProviderTotals.set(providerBucketKey, providerTotals);

    const providerTools = this.toolBucketsByProvider.get(providerBucketKey) ?? new Map<string, ToolStatsBucket>();
    this.toolBucketsByProvider.set(providerBucketKey, providerTools);

    const uniqueNames = new Set<string>();
    for (const tool of toolCalls) {
      const name = tool.name;
      if (!name) {
        continue;
      }
      uniqueNames.add(name);
      const globalBucket = this.toolBuckets.get(name) ?? {
        toolName: name,
        callCount: 0,
        responseCount: 0,
        firstSeenAt: now,
        lastSeenAt: now
      };
      globalBucket.callCount += 1;
      globalBucket.lastSeenAt = now;
      this.toolBuckets.set(name, globalBucket);

      const providerBucket = providerTools.get(name) ?? {
        toolName: name,
        callCount: 0,
        responseCount: 0,
        firstSeenAt: now,
        lastSeenAt: now
      };
      providerBucket.callCount += 1;
      providerBucket.lastSeenAt = now;
      providerTools.set(name, providerBucket);
    }

    for (const name of uniqueNames) {
      const globalBucket = this.toolBuckets.get(name);
      if (globalBucket) {
        globalBucket.responseCount += 1;
        globalBucket.lastSeenAt = now;
      }
      const providerBucket = providerTools.get(name);
      if (providerBucket) {
        providerBucket.responseCount += 1;
        providerBucket.lastSeenAt = now;
      }
    }
  }

  snapshot(uptimeMs: number): StatsSnapshot {
    if (!this.enabled) {
      return { generatedAt: Date.now(), uptimeMs, totals: [] };
    }
    const totals = computeProviderTotals(this.buckets) as ProviderStatsView[];
    const tools = snapshotTools({
      totalToolCalls: this.totalToolCalls,
      totalToolResponses: this.totalToolResponses,
      toolBuckets: this.toolBuckets,
      toolBucketsByProvider: this.toolBucketsByProvider,
      toolProviderTotals: this.toolProviderTotals
    }) as ToolStatsSnapshot | undefined;
    return { generatedAt: Date.now(), uptimeMs, totals, ...(tools ? { tools } : {}) };
  }

  logSummary(uptimeMs: number): StatsSnapshot {
    const snapshot = this.snapshot(uptimeMs);
    if (!this.enabled) {
      return snapshot;
    }
    this.ensureHistoricalLoaded();
    const merged = mergeSnapshotIntoHistorical({
      snapshot,
      historicalBuckets: this.historicalBuckets,
      historicalToolAggregate: this.historicalToolAggregate,
      historicalToolByProvider: this.historicalToolByProvider,
      historicalSnapshotCount: this.historicalSnapshotCount,
      historicalSampleCount: this.historicalSampleCount
    });
    this.historicalSnapshotCount = merged.historicalSnapshotCount;
    this.historicalSampleCount = merged.historicalSampleCount;

    if (!this.verboseLogging) {
      return snapshot;
    }
    if (!snapshot.totals.length) {
      console.log('[Stats] No provider activity recorded');
      return snapshot;
    }
    console.log(
      '\n[Stats][session] Provider summary (uptime=%d ms · samples=%d)',
      Math.round(snapshot.uptimeMs),
      snapshot.totals.reduce((sum, bucket) => sum + bucket.requestCount, 0)
    );
    logProviderSummaryTable(snapshot.totals.map((bucket) => buildSessionProviderRow(bucket)), false);
    logToolSummary(snapshot.tools, formatProviderLabel);
    return snapshot;
  }

  async persistSnapshot(snapshot: StatsSnapshot, options?: StatsPersistOptions): Promise<void> {
    if (!this.enabled) {
      return;
    }
    try {
      const logPath = this.normalizeLogPath(options?.logPath);
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      const record = {
        ...snapshot,
        reason: options?.reason ?? 'shutdown',
        pid: process.pid
      } satisfies StatsSnapshot & { reason: string; pid: number };
      await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf-8');
    } catch (error) {
      console.warn('[Stats] Failed to persist provider stats snapshot', error);
    }
  }

  async logHistoricalSummary(options?: { logPath?: string }): Promise<void> {
    if (!this.enabled || !this.verboseLogging) {
      return;
    }
    if (options?.logPath && options.logPath.trim()) {
      this.normalizeLogPath(options.logPath);
    } else {
      this.ensureHistoricalLoaded();
    }
    logHistoricalFromMemory({
      historicalBuckets: this.historicalBuckets,
      historicalSnapshotCount: this.historicalSnapshotCount,
      historicalSampleCount: this.historicalSampleCount,
      historicalToolAggregate: this.historicalToolAggregate,
      historicalToolByProvider: this.historicalToolByProvider
    });
  }

  snapshotHistorical(): HistoricalStatsSnapshot {
    if (!this.enabled) {
      return { generatedAt: Date.now(), snapshotCount: 0, sampleCount: 0, totals: [] };
    }
    this.ensureHistoricalLoaded();
    const totals = computeProviderTotals(this.historicalBuckets) as ProviderStatsView[];
    return {
      generatedAt: Date.now(),
      snapshotCount: this.historicalSnapshotCount,
      sampleCount: this.historicalSampleCount,
      totals
    };
  }

  private ensureHistoricalLoaded(): void {
    if (!this.enabled || this.historicalLoaded) {
      return;
    }
    this.loadHistoricalFromDisk(this.statsLogPath, true);
  }

  private loadHistoricalFromDisk(logPath: string, reset: boolean): void {
    if (reset) {
      this.historicalBuckets.clear();
      this.historicalToolAggregate.clear();
      this.historicalToolByProvider.clear();
      this.historicalSnapshotCount = 0;
      this.historicalSampleCount = 0;
    }
    try {
      const raw = fsSync.readFileSync(logPath, 'utf-8');
      const lines = raw.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as StatsSnapshot & { reason?: string; pid?: number };
          const merged = mergeSnapshotIntoHistorical({
            snapshot: record,
            historicalBuckets: this.historicalBuckets,
            historicalToolAggregate: this.historicalToolAggregate,
            historicalToolByProvider: this.historicalToolByProvider,
            historicalSnapshotCount: this.historicalSnapshotCount,
            historicalSampleCount: this.historicalSampleCount
          });
          this.historicalSnapshotCount = merged.historicalSnapshotCount;
          this.historicalSampleCount = merged.historicalSampleCount;
        } catch {
          continue;
        }
      }
    } catch {
      // File missing or unreadable -> treat as empty history.
    }
    this.historicalLoaded = true;
  }

  private normalizeLogPath(override?: string): string {
    if (override && override.trim()) {
      const normalized = override.trim();
      if (normalized !== this.statsLogPath) {
        this.statsLogPath = normalized;
        this.historicalLoaded = false;
        this.loadHistoricalFromDisk(this.statsLogPath, true);
      }
      return normalized;
    }
    return this.statsLogPath;
  }

  private resolveLogPath(explicit?: string): string {
    if (explicit && explicit.trim()) {
      return explicit.trim();
    }
    const envPath = process.env.ROUTECODEX_STATS_LOG || process.env.RCC_STATS_LOG;
    if (envPath && envPath.trim()) {
      return envPath.trim();
    }
    return DEFAULT_STATS_LOG_PATH;
  }
}

export type UsageMetrics = UsageShape;
