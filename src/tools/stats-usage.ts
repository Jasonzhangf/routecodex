import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { ProviderUsageEvent } from '../modules/llmswitch/bridge.js';

const STATS_DIR = path.join(os.homedir(), '.routecodex', 'stats');
const REQUEST_EVENTS_FILE = path.join(STATS_DIR, 'request-events.log');

export type UsageBucket = {
  requestCount: number;
  successCount: number;
  errorCount: number;
  latencyMs: { sum: number; min: number; max: number };
  tokens: { prompt: number; completion: number; total: number };
};

export type DailyUsage = {
  byProviderKey: Record<string, UsageBucket>;
  byRoute: Record<string, UsageBucket>;
  byPool: Record<string, UsageBucket>;
  byEndpoint: Record<string, UsageBucket>;
};

export type TimeSeriesUsage = {
  days: Record<string, DailyUsage>;
  weeks: Record<string, DailyUsage>;
};

export type UsageTimeSeriesQuery = {
  fromMs?: number;
  toMs?: number;
};

function createEmptyBucket(): UsageBucket {
  return {
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    latencyMs: { sum: 0, min: Number.POSITIVE_INFINITY, max: 0 },
    tokens: { prompt: 0, completion: 0, total: 0 }
  };
}

function createEmptyDailyUsage(): DailyUsage {
  return {
    byProviderKey: {},
    byRoute: {},
    byPool: {},
    byEndpoint: {}
  };
}

function applyEventToBucket(bucket: UsageBucket, ev: ProviderUsageEvent): void {
  bucket.requestCount += 1;
  if (ev.success) {
    bucket.successCount += 1;
  } else {
    bucket.errorCount += 1;
  }
  if (typeof ev.latencyMs === 'number' && Number.isFinite(ev.latencyMs) && ev.latencyMs >= 0) {
    bucket.latencyMs.sum += ev.latencyMs;
    if (ev.latencyMs < bucket.latencyMs.min) {
      bucket.latencyMs.min = ev.latencyMs;
    }
    if (ev.latencyMs > bucket.latencyMs.max) {
      bucket.latencyMs.max = ev.latencyMs;
    }
  }
  if (typeof ev.promptTokens === 'number' && Number.isFinite(ev.promptTokens) && ev.promptTokens > 0) {
    bucket.tokens.prompt += ev.promptTokens;
  }
  if (
    typeof ev.completionTokens === 'number' &&
    Number.isFinite(ev.completionTokens) &&
    ev.completionTokens > 0
  ) {
    bucket.tokens.completion += ev.completionTokens;
  }
  if (typeof ev.totalTokens === 'number' && Number.isFinite(ev.totalTokens) && ev.totalTokens > 0) {
    bucket.tokens.total += ev.totalTokens;
  } else {
    const derived =
      (typeof ev.promptTokens === 'number' && Number.isFinite(ev.promptTokens) && ev.promptTokens > 0
        ? ev.promptTokens
        : 0) +
      (typeof ev.completionTokens === 'number' &&
      Number.isFinite(ev.completionTokens) &&
      ev.completionTokens > 0
        ? ev.completionTokens
        : 0);
    bucket.tokens.total += derived;
  }
}

function ensureDailyBucket(map: Record<string, DailyUsage>, key: string): DailyUsage {
  if (!map[key]) {
    map[key] = createEmptyDailyUsage();
  }
  return map[key];
}

function formatDayKey(timestamp: number): string {
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatWeekKey(timestamp: number): string {
  const d = new Date(timestamp);
  const onejan = new Date(d.getFullYear(), 0, 1);
  const dayMs = 24 * 60 * 60 * 1000;
  const dayOfYear = Math.floor((d.getTime() - onejan.getTime()) / dayMs) + 1;
  const week = Math.ceil(dayOfYear / 7);
  const year = d.getFullYear();
  const weekStr = `${week}`.padStart(2, '0');
  return `${year}-W${weekStr}`;
}

export async function loadUsageTimeSeries(query: UsageTimeSeriesQuery): Promise<TimeSeriesUsage> {
  const result: TimeSeriesUsage = { days: {}, weeks: {} };
  let content: string;
  try {
    content = await fs.readFile(REQUEST_EVENTS_FILE, 'utf8');
  } catch {
    return result;
  }
  if (!content) {
    return result;
  }
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let ev: ProviderUsageEvent | null = null;
    try {
      const parsed = JSON.parse(trimmed) as ProviderUsageEvent;
      if (parsed && typeof parsed === 'object' && typeof parsed.timestamp === 'number') {
        ev = parsed;
      }
    } catch {
      continue;
    }
    if (!ev) {
      continue;
    }
    const ts = ev.timestamp;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) {
      continue;
    }
    if (query.fromMs && ts < query.fromMs) {
      continue;
    }
    if (query.toMs && ts > query.toMs) {
      continue;
    }

    const dayKey = formatDayKey(ts);
    const weekKey = formatWeekKey(ts);

    const dayBucket = ensureDailyBucket(result.days, dayKey);
    const providerKey = ev.providerKey || 'unknown';
    const routeKey = ev.routeName || 'unknown';
    const poolKey = (ev as any).poolId || 'default';
    const endpointKey = ev.entryEndpoint || 'unknown';

    if (!dayBucket.byProviderKey[providerKey]) {
      dayBucket.byProviderKey[providerKey] = createEmptyBucket();
    }
    applyEventToBucket(dayBucket.byProviderKey[providerKey], ev);

    if (!dayBucket.byRoute[routeKey]) {
      dayBucket.byRoute[routeKey] = createEmptyBucket();
    }
    applyEventToBucket(dayBucket.byRoute[routeKey], ev);

    if (!dayBucket.byPool[poolKey]) {
      dayBucket.byPool[poolKey] = createEmptyBucket();
    }
    applyEventToBucket(dayBucket.byPool[poolKey], ev);

    if (!dayBucket.byEndpoint[endpointKey]) {
      dayBucket.byEndpoint[endpointKey] = createEmptyBucket();
    }
    applyEventToBucket(dayBucket.byEndpoint[endpointKey], ev);

    const weekBucket = ensureDailyBucket(result.weeks, weekKey);

    if (!weekBucket.byProviderKey[providerKey]) {
      weekBucket.byProviderKey[providerKey] = createEmptyBucket();
    }
    applyEventToBucket(weekBucket.byProviderKey[providerKey], ev);

    if (!weekBucket.byRoute[routeKey]) {
      weekBucket.byRoute[routeKey] = createEmptyBucket();
    }
    applyEventToBucket(weekBucket.byRoute[routeKey], ev);

    if (!weekBucket.byPool[poolKey]) {
      weekBucket.byPool[poolKey] = createEmptyBucket();
    }
    applyEventToBucket(weekBucket.byPool[poolKey], ev);

    if (!weekBucket.byEndpoint[endpointKey]) {
      weekBucket.byEndpoint[endpointKey] = createEmptyBucket();
    }
    applyEventToBucket(weekBucket.byEndpoint[endpointKey], ev);
  }
  return result;
}

export function summarizeUsage(
  timeSeries: TimeSeriesUsage,
  period: 'day' | 'week' | 'all',
  group: 'provider' | 'route' | 'pool' | 'endpoint'
): Record<string, UsageBucket> {
  const summary: Record<string, UsageBucket> = {};
  const source =
    period === 'day' ? timeSeries.days : period === 'week' ? timeSeries.weeks : timeSeries.days;

  const pickGroup = (daily: DailyUsage): Record<string, UsageBucket> => {
    if (group === 'provider') {return daily.byProviderKey;}
    if (group === 'route') {return daily.byRoute;}
    if (group === 'pool') {return daily.byPool;}
    return daily.byEndpoint;
  };

  for (const daily of Object.values(source)) {
    const map = pickGroup(daily);
    for (const [key, bucket] of Object.entries(map)) {
      if (!summary[key]) {
        summary[key] = createEmptyBucket();
      }
      const target = summary[key];
      target.requestCount += bucket.requestCount;
      target.successCount += bucket.successCount;
      target.errorCount += bucket.errorCount;
      target.latencyMs.sum += bucket.latencyMs.sum;
      if (bucket.latencyMs.min < target.latencyMs.min) {
        target.latencyMs.min = bucket.latencyMs.min;
      }
      if (bucket.latencyMs.max > target.latencyMs.max) {
        target.latencyMs.max = bucket.latencyMs.max;
      }
      target.tokens.prompt += bucket.tokens.prompt;
      target.tokens.completion += bucket.tokens.completion;
      target.tokens.total += bucket.tokens.total;
    }
  }
  return summary;
}
