import {
  loadNativeRouterHotpathBinding,
  resolveNativeModuleUrlFromEnv as resolveNativeModuleUrlFromEnvInLoader
} from './native-router-hotpath-loader.js';

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

type QuotaBucketOutputTier = {
  priority: number;
  entries: QuotaBucketOutputEntry[];
};

type QuotaBucketOutputPayload = {
  priorities: number[];
  buckets: QuotaBucketOutputTier[];
};

export type QuotaBucketResult = {
  priorities: number[];
  buckets: Map<number, QuotaBucketOutputEntry[]>;
};

type HotpathMode = 'auto' | 'native-only';

function coerceNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseNativePayload(raw: string): QuotaBucketResult | null {
  try {
    const parsed = JSON.parse(raw) as QuotaBucketOutputPayload;
    if (!parsed || !Array.isArray(parsed.priorities) || !Array.isArray(parsed.buckets)) {
      return null;
    }
    const buckets = new Map<number, QuotaBucketOutputEntry[]>();
    for (const tier of parsed.buckets) {
      const priority = coerceNumber((tier as { priority?: unknown }).priority);
      if (priority === undefined) {
        continue;
      }
      const entriesRaw = Array.isArray((tier as { entries?: unknown }).entries)
        ? ((tier as { entries: unknown[] }).entries as unknown[])
        : [];
      const entries: QuotaBucketOutputEntry[] = [];
      for (const item of entriesRaw) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          continue;
        }
        const row = item as Record<string, unknown>;
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
      .filter((value): value is number => value !== undefined)
      .sort((a, b) => a - b);
    return { priorities, buckets };
  } catch {
    return null;
  }
}

function computeQuotaBucketsNative(entries: QuotaBucketInputEntry[], nowMs: number): QuotaBucketResult | null {
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
  } catch {
    return null;
  }
}

export function buildQuotaBuckets(entries: QuotaBucketInputEntry[], nowMs: number): QuotaBucketResult {
  return buildQuotaBucketsWithMode(entries, nowMs, 'auto');
}

export function buildQuotaBucketsWithMode(
  entries: QuotaBucketInputEntry[],
  nowMs: number,
  mode: HotpathMode | string
): QuotaBucketResult {
  if (mode !== 'auto' && mode !== 'native-only') {
    throw new Error(
      `[virtual-router-native-hotpath] unsupported hotpath mode: ${String(mode)}`
    );
  }

  const nativeResult = computeQuotaBucketsNative(entries, nowMs);
  if (nativeResult) {
    return nativeResult;
  }

  throw new Error(
    '[virtual-router-native-hotpath] native router hotpath is required but unavailable'
  );
}

export function getNativeRouterHotpathSource(): 'native' | 'unavailable' {
  const binding = loadNativeRouterHotpathBinding();
  if (typeof binding?.computeQuotaBucketsJson === 'function') {
    return 'native';
  }
  return 'unavailable';
}

export function resolveNativeModuleUrlFromEnv(): string | undefined {
  return resolveNativeModuleUrlFromEnvInLoader();
}
