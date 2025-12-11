import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

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

export interface StatsSnapshot {
  generatedAt: number;
  uptimeMs: number;
  totals: ProviderStatsView[];
}

export type StatsPersistOptions = {
  logPath?: string;
  reason?: string;
};

const DEFAULT_STATS_LOG_PATH = path.join(os.homedir(), '.routecodex', 'logs', 'provider-stats.jsonl');

export class StatsManager {
  private readonly inflight = new Map<string, ProviderSample>();
  private readonly buckets = new Map<string, ProviderStatsBucket>();

  recordRequestStart(requestId: string): void {
    if (!requestId) {
      return;
    }
    this.inflight.set(requestId, {
      startTime: Date.now()
    });
  }

  bindProvider(
    requestId: string,
    meta: { providerKey?: string; providerType?: string; model?: string }
  ): void {
    if (!requestId) {
      return;
    }
    const sample = this.inflight.get(requestId);
    if (sample) {
      if (meta.providerKey) sample.providerKey = meta.providerKey;
      if (meta.providerType) sample.providerType = meta.providerType;
      if (meta.model) sample.model = meta.model;
      return;
    }
    this.inflight.set(requestId, {
      startTime: Date.now(),
      ...meta
    });
  }

  recordCompletion(
    requestId: string,
    options?: { usage?: UsageShape; error?: boolean }
  ): void {
    if (!requestId) {
      return;
    }
    const sample = this.inflight.get(requestId);
    this.inflight.delete(requestId);
    if (!sample?.providerKey) {
      return;
    }
    const key = this.composeBucketKey(sample.providerKey, sample.model);
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

  snapshot(uptimeMs: number): StatsSnapshot {
    const totals: ProviderStatsView[] = Array.from(this.buckets.values()).map(bucket => ({
      ...bucket,
      averageLatencyMs: bucket.requestCount ? bucket.totalLatencyMs / bucket.requestCount : 0,
      averagePromptTokens: bucket.requestCount ? bucket.totalPromptTokens / bucket.requestCount : 0,
      averageCompletionTokens: bucket.requestCount ? bucket.totalCompletionTokens / bucket.requestCount : 0,
      averageOutputTokens: bucket.requestCount ? bucket.totalOutputTokens / bucket.requestCount : 0
    }));
    return {
      generatedAt: Date.now(),
      uptimeMs,
      totals
    };
  }

  logSummary(uptimeMs: number): StatsSnapshot {
    const snapshot = this.snapshot(uptimeMs);
    if (!snapshot.totals.length) {
      console.log('[Stats] No provider activity recorded');
      return snapshot;
    }
    console.log(
      '[Stats] Provider summary (uptime=%d ms, samples=%d)',
      Math.round(snapshot.uptimeMs),
      snapshot.totals.reduce((sum, bucket) => sum + bucket.requestCount, 0)
    );
    for (const bucket of snapshot.totals) {
      console.log(
        '  %s / %s → requests=%d errors=%d avgLatency=%s ms avgTokens(in=%s/out=%s/total=%s)',
        bucket.providerKey,
        bucket.model ?? '-',
        bucket.requestCount,
        bucket.errorCount,
        bucket.averageLatencyMs.toFixed(1),
        bucket.averagePromptTokens.toFixed(1),
        bucket.averageCompletionTokens.toFixed(1),
        bucket.averageOutputTokens.toFixed(1)
      );
    }
    return snapshot;
  }

  async persistSnapshot(snapshot: StatsSnapshot, options?: StatsPersistOptions): Promise<void> {
    try {
      const logPath = this.resolveLogPath(options?.logPath);
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

  private composeBucketKey(providerKey: string, model?: string): string {
    return `${providerKey}|${model ?? '-'}`;
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
