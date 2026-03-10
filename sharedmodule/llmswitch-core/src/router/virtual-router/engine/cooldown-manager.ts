/**
 * Cooldown Manager Module
 * 
 * Manages provider cooldown TTLs and health snapshot persistence.
 */

import type { ProviderCooldownState, VirtualRouterHealthSnapshot, VirtualRouterHealthStore, ProviderHealthConfig } from '../types.js';

export class CooldownManager {
  private providerCooldowns: Map<string, number> = new Map();
  private healthStore?: VirtualRouterHealthStore;
  private healthConfig: ProviderHealthConfig | null = null;
  private quotaView?: (providerKey: string) => { selectionPenalty?: number } | undefined;

  constructor(deps?: {
    healthStore?: VirtualRouterHealthStore;
    healthConfig?: ProviderHealthConfig | null;
    quotaView?: (providerKey: string) => { selectionPenalty?: number } | undefined;
  }) {
    if (deps?.healthStore) this.healthStore = deps.healthStore;
    if (deps?.healthConfig !== undefined) this.healthConfig = deps.healthConfig;
    if (deps?.quotaView) this.quotaView = deps.quotaView;
  }

  updateDeps(deps: {
    healthStore?: VirtualRouterHealthStore | null;
    healthConfig?: ProviderHealthConfig | null;
    quotaView?: (providerKey: string) => { selectionPenalty?: number } | undefined | null;
  }): void {
    if ('healthStore' in deps) this.healthStore = deps.healthStore ?? undefined;
    if ('healthConfig' in deps) this.healthConfig = deps.healthConfig ?? null;
    if ('quotaView' in deps) {
      const prevQuotaEnabled = Boolean(this.quotaView);
      this.quotaView = deps.quotaView ?? undefined;
      const nextQuotaEnabled = Boolean(this.quotaView);
      // When quotaView is enabled, cooldown must be driven by quotaView only.
      if (!prevQuotaEnabled && nextQuotaEnabled) {
        this.providerCooldowns.clear();
      } else if (prevQuotaEnabled && !nextQuotaEnabled) {
        this.providerCooldowns.clear();
        this.restoreHealthFromStore();
      }
    }
  }

  markProviderCooldown(providerKey: string, cooldownMs: number | undefined): void {
    if (!providerKey) return;
    const ttl = typeof cooldownMs === 'number' ? Math.round(cooldownMs) : Number.NaN;
    if (!Number.isFinite(ttl) || ttl <= 0) return;
    this.providerCooldowns.set(providerKey, Date.now() + ttl);
    this.persistHealthSnapshot();
  }

  clearProviderCooldown(providerKey: string): void {
    if (!providerKey) return;
    if (this.providerCooldowns.delete(providerKey)) {
      this.persistHealthSnapshot();
    }
  }

  isProviderCoolingDown(providerKey: string): boolean {
    if (!providerKey) return false;
    const expiry = this.providerCooldowns.get(providerKey);
    if (!expiry) return false;
    if (Date.now() >= expiry) {
      this.providerCooldowns.delete(providerKey);
      return false;
    }
    return true;
  }

  restoreHealthFromStore(): void {
    if (!this.healthStore || typeof this.healthStore.loadInitialSnapshot !== 'function') return;
    // When quotaView is enabled, health/cooldown must be driven by quotaView only.
    if (this.quotaView) return;

    let snapshot: VirtualRouterHealthSnapshot | null = null;
    try {
      snapshot = this.healthStore.loadInitialSnapshot();
    } catch {
      snapshot = null;
    }
    if (!snapshot) return;

    const now = Date.now();
    const byKey = new Map<string, ProviderCooldownState>();
    for (const entry of snapshot.cooldowns || []) {
      if (!entry?.providerKey || !Number.isFinite(entry.cooldownExpiresAt) || entry.cooldownExpiresAt <= now) continue;
      byKey.set(entry.providerKey, entry);
      this.providerCooldowns.set(entry.providerKey, entry.cooldownExpiresAt);
    }
    // Note: Provider health manager's state is separate; we only restore local cooldowns.
  }

  buildHealthSnapshot(): VirtualRouterHealthSnapshot {
    const cooldowns: ProviderCooldownState[] = [];
    const now = Date.now();
    for (const [providerKey, expiry] of this.providerCooldowns.entries()) {
      if (!expiry || expiry <= now) continue;
      cooldowns.push({ providerKey, cooldownExpiresAt: expiry });
    }
    return { providers: [], cooldowns }; // providers part handled by health manager
  }

  persistHealthSnapshot(): void {
    if (!this.healthStore || typeof this.healthStore.persistSnapshot !== 'function') return;
    try {
      const snapshot = this.buildHealthSnapshot();
      this.healthStore.persistSnapshot(snapshot);
    } catch {
      // persistence failure does not affect routing
    }
  }

  clearAllCooldowns(): void {
    this.providerCooldowns.clear();
  }

  getCooldownMap(): Map<string, number> {
    return this.providerCooldowns;
  }
}
