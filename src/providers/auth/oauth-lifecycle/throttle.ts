/**
 * Throttle Helpers
 *
 * Rate limiting utilities for OAuth operations.
 */

const inFlightMap: Map<string, Promise<void>> = new Map();
const lastRunAtMap: Map<string, number> = new Map();
let interactiveTailPromise: Promise<void> = Promise.resolve();

export function keyFor(providerType: string, tokenFile?: string): string {
  return `${providerType}::${tokenFile || ''}`;
}

export function shouldThrottle(k: string, ms = 60_000): boolean {
  const t = lastRunAtMap.get(k) || 0;
  return Date.now() - t < ms;
}

export function updateThrottle(k: string): void {
  lastRunAtMap.set(k, Date.now());
}

export const inFlight = {
  has: (key: string) => inFlightMap.has(key),
  get: (key: string) => inFlightMap.get(key),
  set: (key: string, promise: Promise<void>) => inFlightMap.set(key, promise),
  delete: (key: string) => inFlightMap.delete(key)
};

export const lastRunAt = {
  get: (key: string) => lastRunAtMap.get(key),
  set: (key: string, value: number) => lastRunAtMap.set(key, value)
};

export const interactiveTail = {
  get current(): Promise<void> {
    return interactiveTailPromise;
  },
  set next(p: Promise<void>) {
    interactiveTailPromise = p;
  }
};
