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

export class StickySessionManager {
  private aliasQueueStore: Map<string, string[]> = new Map();
  private antigravityAliasLeaseStore: Map<string, AliasLease> = new Map();
  private antigravitySessionAliasStore: Map<string, string> = new Map();
  private antigravityAliasReuseCooldownMs: number = 5 * 60_000;

  constructor(aliasReuseCooldownMs?: number) {
    if (typeof aliasReuseCooldownMs === 'number' && aliasReuseCooldownMs > 0) {
      this.antigravityAliasReuseCooldownMs = aliasReuseCooldownMs;
    }
  }

  // Alias queue management
  getAliasQueue(alias: string): string[] | undefined {
    return this.aliasQueueStore.get(alias);
  }

  setAliasQueue(alias: string, queue: string[]): void {
    this.aliasQueueStore.set(alias, queue);
  }

  // Antigravity alias lease
  getAliasLease(alias: string): AliasLease | undefined {
    return this.antigravityAliasLeaseStore.get(alias);
  }

  setAliasLease(alias: string, lease: AliasLease): void {
    this.antigravityAliasLeaseStore.set(alias, lease);
  }

  // Session alias mapping
  getSessionAlias(sessionKey: string): string | undefined {
    return this.antigravitySessionAliasStore.get(sessionKey);
  }

  setSessionAlias(sessionKey: string, alias: string): void {
    this.antigravitySessionAliasStore.set(sessionKey, alias);
  }

  // Cooldown resolution
  getAliasReuseCooldownMs(): number {
    return this.antigravityAliasReuseCooldownMs;
  }

  // Hydrate from external store (placeholder for future persistence)
  hydrateFromStore(store: Map<string, AliasLease>): void {
    for (const [alias, lease] of store.entries()) {
      this.antigravityAliasLeaseStore.set(alias, lease);
    }
  }

  // Get all stores for persistence
  getAllStores(): {
    aliasQueueStore: Map<string, string[]>;
    aliasLeaseStore: Map<string, AliasLease>;
    sessionAliasStore: Map<string, string>;
  } {
    return {
      aliasQueueStore: this.aliasQueueStore,
      aliasLeaseStore: this.antigravityAliasLeaseStore,
      sessionAliasStore: this.antigravitySessionAliasStore
    };
  }
}
