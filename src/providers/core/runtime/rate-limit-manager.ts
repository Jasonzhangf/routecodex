import type { ProviderContext } from '../api/provider-types.js';

const DEFAULT_BACKOFF_SCHEDULE = [10_000, 30_000, 60_000];
const DEFAULT_SERIES_BLACKLIST_MS = 5 * 60_000;

type SeriesName = 'claude' | 'gemini-pro' | 'gemini-flash' | 'default';

interface BucketState {
  consecutive429: number;
  last429At: number;
  cooldownUntil?: number;
}

export class RateLimitCooldownError extends Error {
  statusCode = 429;
  code = 'HTTP_429';
  retryable = true;
  details?: Record<string, unknown>;

  constructor(message: string, waitMs?: number) {
    super(message);
    if (waitMs && Number.isFinite(waitMs)) {
      this.details = { retryAfterMs: waitMs };
    }
  }
}

export class RateLimitBackoffManager {
  private readonly buckets = new Map<string, BucketState>();
  private readonly seriesBlacklist = new Map<string, number>();

  constructor(
    private readonly schedule: number[] = DEFAULT_BACKOFF_SCHEDULE,
    private readonly seriesBlacklistDurationMs: number = DEFAULT_SERIES_BLACKLIST_MS
  ) {}

  shouldThrottle(providerKey?: string, model?: string): { blocked: boolean; reason?: string; waitMs?: number } {
    if (!providerKey) {
      return { blocked: false };
    }
    const now = Date.now();
    const seriesKey = this.buildSeriesKey(providerKey, model);
    if (seriesKey) {
      const blacklistUntil = this.seriesBlacklist.get(seriesKey);
      if (blacklistUntil && blacklistUntil > now) {
        return {
          blocked: true,
          reason: 'series-blacklist',
          waitMs: blacklistUntil - now
        };
      }
      if (blacklistUntil && blacklistUntil <= now) {
        this.seriesBlacklist.delete(seriesKey);
      }
    }

    const bucketKey = this.buildBucketKey(providerKey, model);
    if (!bucketKey) {
      return { blocked: false };
    }
    const state = this.buckets.get(bucketKey);
    if (state?.cooldownUntil && state.cooldownUntil > now) {
      return {
        blocked: true,
        reason: 'provider-cooldown',
        waitMs: state.cooldownUntil - now
      };
    }
    if (state?.cooldownUntil && state.cooldownUntil <= now) {
      state.cooldownUntil = undefined;
      this.buckets.set(bucketKey, state);
    }
    return { blocked: false };
  }

  record429(providerKey?: string, model?: string): { cooldownMs: number; consecutive: number; seriesBlacklisted: boolean } {
    const bucketKey = this.buildBucketKey(providerKey, model);
    if (!bucketKey) {
      return { cooldownMs: this.schedule[0] ?? 10_000, consecutive: 1, seriesBlacklisted: false };
    }
    const now = Date.now();
    const prev = this.buckets.get(bucketKey);
    const nextCount = prev ? prev.consecutive429 + 1 : 1;
    const scheduleIdx = Math.min(nextCount - 1, this.schedule.length - 1);
    const cooldownMs = this.schedule[scheduleIdx] ?? this.schedule[this.schedule.length - 1];
    const nextState: BucketState = {
      consecutive429: nextCount,
      last429At: now,
      cooldownUntil: now + cooldownMs
    };
    this.buckets.set(bucketKey, nextState);

    let seriesBlacklisted = false;
    if (nextCount >= this.schedule.length) {
      const seriesKey = this.buildSeriesKey(providerKey, model);
      if (seriesKey) {
        this.seriesBlacklist.set(seriesKey, now + this.seriesBlacklistDurationMs);
        seriesBlacklisted = true;
      }
    }

    return {
      cooldownMs,
      consecutive: nextCount,
      seriesBlacklisted
    };
  }

  reset(providerKey?: string, model?: string): void {
    const bucketKey = this.buildBucketKey(providerKey, model);
    if (bucketKey) {
      this.buckets.delete(bucketKey);
    }
  }

  buildThrottleError(context: Pick<ProviderContext, 'providerKey' | 'model'>): RateLimitCooldownError | null {
    const result = this.shouldThrottle(context.providerKey, context.model);
    if (!result.blocked) {
      return null;
    }
    const reason = result.reason === 'series-blacklist' ? 'series temporarily blocked due to repeated 429' : 'provider cooling down after 429';
    return new RateLimitCooldownError(reason, result.waitMs);
  }

  private buildBucketKey(providerKey?: string, model?: string): string | undefined {
    if (!providerKey) {
      return undefined;
    }
    const normalizedModel = typeof model === 'string' && model.trim().length ? model.trim().toLowerCase() : 'default';
    return `${providerKey}::${normalizedModel}`;
  }

  private buildSeriesKey(providerKey?: string, model?: string): string | undefined {
    if (!providerKey) {
      return undefined;
    }
    const series = this.resolveSeries(model);
    return `${providerKey}::series::${series}`;
  }

  private resolveSeries(model?: string): SeriesName {
    if (!model) {
      return 'default';
    }
    const lower = model.toLowerCase();
    if (lower.includes('claude') || lower.includes('opus')) {
      return 'claude';
    }
    if (lower.includes('flash')) {
      return 'gemini-flash';
    }
    if (lower.includes('gemini') || lower.includes('pro')) {
      return 'gemini-pro';
    }
    return 'default';
  }
}
