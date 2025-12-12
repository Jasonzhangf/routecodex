export interface RateLimiterOptions {
  limit: number;
  intervalMs: number;
}

export interface RateLimiterResult {
  allowed: boolean;
  retryAfterMs?: number;
}

export class SlidingWindowRateLimiter {
  private readonly timestamps: number[] = [];

  readonly limit: number;
  readonly intervalMs: number;

  constructor(options: RateLimiterOptions) {
    this.limit = Math.max(1, Number(options.limit) || 1);
    this.intervalMs = Math.max(1, Number(options.intervalMs) || 60_000);
  }

  tryAcquire(now: number = Date.now()): RateLimiterResult {
    const cutoff = now - this.intervalMs;
    while (this.timestamps.length && this.timestamps[0] <= cutoff) {
      this.timestamps.shift();
    }
    if (this.timestamps.length < this.limit) {
      this.timestamps.push(now);
      return { allowed: true };
    }
    const retryAfterMs = this.intervalMs - (now - this.timestamps[0]);
    return { allowed: false, retryAfterMs: retryAfterMs > 0 ? retryAfterMs : this.intervalMs };
  }
}
