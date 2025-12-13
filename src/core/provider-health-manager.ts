export type ProviderBlockInfo = {
  reason: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
};

type RateLimitState = {
  count: number;
  lastHit: number;
};

export class ProviderHealthManager {
  private readonly blocked = new Map<string, ProviderBlockInfo>();
  private readonly rateLimitHits = new Map<string, RateLimitState>();

  public block(providerKey: string | undefined, reason: string, metadata?: Record<string, unknown>): void {
    if (!providerKey) {
      return;
    }
    if (this.blocked.has(providerKey)) {
      return;
    }
    this.blocked.set(providerKey, { reason, timestamp: Date.now(), metadata });
    this.rateLimitHits.delete(providerKey);
    try {
      console.warn(`[ProviderHealth] Blocked ${providerKey}: ${reason}`);
    } catch {
      /* ignore logging failures */
    }
  }

  public isBlocked(providerKey: string | undefined): boolean {
    if (!providerKey) {
      return false;
    }
    return this.blocked.has(providerKey);
  }

  public getBlockInfo(providerKey: string | undefined): ProviderBlockInfo | undefined {
    if (!providerKey) {
      return undefined;
    }
    return this.blocked.get(providerKey);
  }

  public clear(providerKey: string | undefined): void {
    if (!providerKey) {
      return;
    }
    this.blocked.delete(providerKey);
    this.rateLimitHits.delete(providerKey);
  }

  public recordRateLimitHit(providerKey: string | undefined): number {
    if (!providerKey) {
      return 0;
    }
    const state = this.rateLimitHits.get(providerKey) ?? { count: 0, lastHit: 0 };
    state.count += 1;
    state.lastHit = Date.now();
    this.rateLimitHits.set(providerKey, state);
    return state.count;
  }

  public resetRateLimit(providerKey: string | undefined): void {
    if (!providerKey) {
      return;
    }
    this.rateLimitHits.delete(providerKey);
  }
}

let sharedProviderHealthManager: ProviderHealthManager | null = null;

export function setProviderHealthManager(manager: ProviderHealthManager): void {
  sharedProviderHealthManager = manager;
}

export function getProviderHealthManager(): ProviderHealthManager {
  if (!sharedProviderHealthManager) {
    sharedProviderHealthManager = new ProviderHealthManager();
  }
  return sharedProviderHealthManager;
}
