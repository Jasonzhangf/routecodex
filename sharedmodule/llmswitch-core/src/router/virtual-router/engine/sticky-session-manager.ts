/**
 * Sticky Session Manager Module
 * 
 * Sticky session and alias lease management extracted from VirtualRouterEngine.
 */

import type { RouterMetadataInput } from '../types.js';

export interface AliasLease {
  sessionKey: string;
  lastSeenAt: number;
}

const DEFAULT_STICKY_SESSION_TTL_MS = 30 * 60_000;
const DEFAULT_STICKY_SESSION_MAX_ENTRIES = 4096;

function resolveStickySessionTtlMs(): number {
  const raw = process.env.ROUTECODEX_VR_STICKY_SESSION_TTL_MS ?? process.env.RCC_VR_STICKY_SESSION_TTL_MS;
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  if (Number.isFinite(parsed) && parsed >= 60_000) {
    return parsed;
  }
  return DEFAULT_STICKY_SESSION_TTL_MS;
}

function resolveStickySessionMaxEntries(): number {
  const raw =
    process.env.ROUTECODEX_VR_STICKY_SESSION_MAX_ENTRIES
    ?? process.env.RCC_VR_STICKY_SESSION_MAX_ENTRIES;
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  if (Number.isFinite(parsed) && parsed >= 16) {
    return parsed;
  }
  return DEFAULT_STICKY_SESSION_MAX_ENTRIES;
}

export class StickySessionManager {
  private aliasQueueStore: Map<string, string[]> = new Map();
  private antigravityAliasLeaseStore: Map<string, AliasLease> = new Map();
  private antigravitySessionAliasStore: Map<string, string> = new Map();
  private aliasQueueTouchedAt = new Map<string, number>();
  private sessionAliasTouchedAt = new Map<string, number>();
  private antigravityAliasReuseCooldownMs: number = 5 * 60_000;
  private readonly stickySessionTtlMs: number;
  private readonly stickySessionMaxEntries: number;

  constructor(aliasReuseCooldownMs?: number) {
    if (typeof aliasReuseCooldownMs === 'number' && aliasReuseCooldownMs > 0) {
      this.antigravityAliasReuseCooldownMs = aliasReuseCooldownMs;
    }
    this.stickySessionTtlMs = resolveStickySessionTtlMs();
    this.stickySessionMaxEntries = resolveStickySessionMaxEntries();
  }

  // Alias queue management
  getAliasQueue(alias: string): string[] | undefined {
    this.prune(Date.now());
    const queue = this.aliasQueueStore.get(alias);
    if (queue) {
      this.aliasQueueTouchedAt.set(alias, Date.now());
    }
    return queue;
  }

  setAliasQueue(alias: string, queue: string[]): void {
    const nowMs = Date.now();
    this.prune(nowMs);
    this.aliasQueueStore.set(alias, queue);
    this.aliasQueueTouchedAt.set(alias, nowMs);
    this.enforceAliasQueueBudget();
  }

  // Antigravity alias lease
  getAliasLease(alias: string): AliasLease | undefined {
    this.prune(Date.now());
    return this.antigravityAliasLeaseStore.get(alias);
  }

  setAliasLease(alias: string, lease: AliasLease): void {
    const nowMs = Date.now();
    this.prune(nowMs);
    this.antigravityAliasLeaseStore.set(alias, {
      ...lease,
      lastSeenAt:
        typeof lease?.lastSeenAt === 'number' && Number.isFinite(lease.lastSeenAt) && lease.lastSeenAt > 0
          ? lease.lastSeenAt
          : nowMs
    });
    this.enforceAliasLeaseBudget();
  }

  // Session alias mapping
  getSessionAlias(sessionKey: string): string | undefined {
    this.prune(Date.now());
    const alias = this.antigravitySessionAliasStore.get(sessionKey);
    if (alias) {
      this.sessionAliasTouchedAt.set(sessionKey, Date.now());
    }
    return alias;
  }

  setSessionAlias(sessionKey: string, alias: string): void {
    const nowMs = Date.now();
    this.prune(nowMs);
    this.antigravitySessionAliasStore.set(sessionKey, alias);
    this.sessionAliasTouchedAt.set(sessionKey, nowMs);
    this.enforceSessionAliasBudget();
  }

  // Cooldown resolution
  getAliasReuseCooldownMs(): number {
    return this.antigravityAliasReuseCooldownMs;
  }

  // Hydrate from external store (placeholder for future persistence)
  hydrateFromStore(store: Map<string, AliasLease>): void {
    const nowMs = Date.now();
    this.prune(nowMs);
    for (const [alias, lease] of store.entries()) {
      this.antigravityAliasLeaseStore.set(alias, {
        ...lease,
        lastSeenAt:
          typeof lease?.lastSeenAt === 'number' && Number.isFinite(lease.lastSeenAt) && lease.lastSeenAt > 0
            ? lease.lastSeenAt
            : nowMs
      });
    }
    this.enforceAliasLeaseBudget();
  }

  // Get all stores for persistence
  getAllStores(): {
    aliasQueueStore: Map<string, string[]>;
    aliasLeaseStore: Map<string, AliasLease>;
    sessionAliasStore: Map<string, string>;
  } {
    this.prune(Date.now());
    return {
      aliasQueueStore: this.aliasQueueStore,
      aliasLeaseStore: this.antigravityAliasLeaseStore,
      sessionAliasStore: this.antigravitySessionAliasStore
    };
  }

  private prune(nowMs: number): void {
    for (const [alias, touchedAtMs] of this.aliasQueueTouchedAt.entries()) {
      if (nowMs - touchedAtMs >= this.stickySessionTtlMs) {
        this.aliasQueueTouchedAt.delete(alias);
        this.aliasQueueStore.delete(alias);
      }
    }
    const expiredAliases = new Set<string>();
    for (const [alias, lease] of this.antigravityAliasLeaseStore.entries()) {
      const lastSeenAt =
        typeof lease?.lastSeenAt === 'number' && Number.isFinite(lease.lastSeenAt)
          ? lease.lastSeenAt
          : 0;
      if (nowMs - lastSeenAt >= this.stickySessionTtlMs) {
        expiredAliases.add(alias);
        this.antigravityAliasLeaseStore.delete(alias);
      }
    }
    if (expiredAliases.size > 0) {
      for (const [sessionKey, alias] of this.antigravitySessionAliasStore.entries()) {
        if (!expiredAliases.has(alias)) {
          continue;
        }
        this.antigravitySessionAliasStore.delete(sessionKey);
        this.sessionAliasTouchedAt.delete(sessionKey);
      }
    }
    for (const [sessionKey, touchedAtMs] of this.sessionAliasTouchedAt.entries()) {
      if (nowMs - touchedAtMs >= this.stickySessionTtlMs) {
        this.sessionAliasTouchedAt.delete(sessionKey);
        this.antigravitySessionAliasStore.delete(sessionKey);
      }
    }
    this.enforceAliasQueueBudget();
    this.enforceAliasLeaseBudget();
    this.enforceSessionAliasBudget();
  }

  private enforceAliasQueueBudget(): void {
    this.evictTouchedMapBudget(this.aliasQueueTouchedAt, (key) => {
      this.aliasQueueStore.delete(key);
    });
  }

  private enforceAliasLeaseBudget(): void {
    if (this.antigravityAliasLeaseStore.size <= this.stickySessionMaxEntries) {
      return;
    }
    const sorted = Array.from(this.antigravityAliasLeaseStore.entries()).sort(
      (a, b) => a[1].lastSeenAt - b[1].lastSeenAt
    );
    while (this.antigravityAliasLeaseStore.size > this.stickySessionMaxEntries && sorted.length > 0) {
      const [alias] = sorted.shift()!;
      this.antigravityAliasLeaseStore.delete(alias);
      for (const [sessionKey, mappedAlias] of this.antigravitySessionAliasStore.entries()) {
        if (mappedAlias !== alias) {
          continue;
        }
        this.antigravitySessionAliasStore.delete(sessionKey);
        this.sessionAliasTouchedAt.delete(sessionKey);
      }
    }
  }

  private enforceSessionAliasBudget(): void {
    this.evictTouchedMapBudget(this.sessionAliasTouchedAt, (key) => {
      this.antigravitySessionAliasStore.delete(key);
    });
  }

  private evictTouchedMapBudget(
    touchedAtMap: Map<string, number>,
    onDelete: (key: string) => void
  ): void {
    if (touchedAtMap.size <= this.stickySessionMaxEntries) {
      return;
    }
    const sorted = Array.from(touchedAtMap.entries()).sort((a, b) => a[1] - b[1]);
    while (touchedAtMap.size > this.stickySessionMaxEntries && sorted.length > 0) {
      const [key] = sorted.shift()!;
      touchedAtMap.delete(key);
      onDelete(key);
    }
  }
}
