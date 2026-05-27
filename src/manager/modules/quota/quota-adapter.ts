/**
 * QuotaManager SSOT Adapter (RouteCodex-X7E Phase 1)
 *
 * Provides a unified facade over the core QuotaManager for all quota operations.
 * - Routes all quota state mutations through Rust/core single path
 * - No per-call fallback switching between core and legacy
 * - Ensures admin snapshot reads return consistent unified view
 *
 * This is the **only** entry point for quota operations in the new path.
 * Legacy ProviderQuotaDaemonModule must not be used by host runtime mutations.
 */

import type { StaticQuotaConfig } from '../../quota/provider-quota-center.js';
import { x7eGate } from '../../../server/runtime/http-server/daemon-admin/routecodex-x7e-gate.js';

function logQuotaAdapterNonBlockingError(operation: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[quota-adapter] ${operation} failed (non-blocking): ${message}`);
}

function rustQuotaMutatorUnavailableResult() {
  return { ok: false, reason: 'rust_quota_host_mutator_unavailable' as const };
}

export interface QuotaViewEntry {
  providerKey: string;
  inPool: boolean;
  reason?: string;
  priorityTier?: number;
  selectionPenalty?: number;
  lastErrorAtMs?: number | null;
  cooldownUntil?: number | null;
  cooldownKeepsPool?: boolean;
  blacklistUntil?: number | null;
  authIssue?: unknown;
  authType?: string;
  consecutiveErrorCount?: number;
}

export interface QuotaManagerAdapter {
  readonly isUnified: boolean;

  // Lifecycle
  init(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;

  // State mutations (write through to core when available)
  disableProvider(options: { providerKey: string; mode: 'cooldown' | 'blacklist'; durationMs: number }): Promise<unknown>;
  recoverProvider(providerKey: string): Promise<unknown>;
  resetProvider(providerKey: string): Promise<unknown>;
  clearCooldown(providerKey: string): Promise<unknown>;
  restoreNow(providerKey: string): Promise<unknown>;
  setQuota(options: { providerKey: string; quota: number; reason?: string }): Promise<unknown>;
  registerProviderStaticConfig(providerKey: string, config: StaticQuotaConfig): void;
  recordProviderUsage(event: { providerKey: string; requestedTokens?: number | null; timestampMs?: number }): void;

  // Queries
  getQuotaView(): (providerKey: string) => QuotaViewEntry | null;
  getAdminSnapshot(): Record<string, QuotaViewEntry>;
  refreshNow(): Promise<{ refreshedAt: number; tokenCount: number; recordCount: number }>;
}

export interface RustQuotaHostMutatorLike {
  getStatus?(): { quotaHostSnapshot?: unknown } | null;
  resetProviderQuota?(providerKey: string): unknown;
  recoverProviderQuota?(providerKey: string): unknown;
  disableProviderQuota?(providerKey: string, mode: 'cooldown' | 'blacklist', durationMs: number): unknown;
}

export function createQuotaManagerAdapter(options: {
  rustHostMutator?: RustQuotaHostMutatorLike | null;
  quotaRoutingEnabled?: boolean;
}): QuotaManagerAdapter {
  const rustHostMutator = options.rustHostMutator ?? null;
  const hasRustUnified = rustHostMutator !== null && x7eGate.phase1UnifiedQuota;
  const backend: 'rust' | 'none' = hasRustUnified ? 'rust' : 'none';
  const quotaRoutingEnabled = options.quotaRoutingEnabled !== false;

  // Track provider static configs for bootstrap
  const staticConfigRegistry = new Map<string, StaticQuotaConfig>();

  async function init(): Promise<void> {
    return;
  }

  async function start(): Promise<void> {
    // Core manager lifecycle is handled externally (created in QuotaManagerModule)
    // This adapter just ensures event subscriptions are ready
  }

  async function stop(): Promise<void> {
    return;
  }

  async function disableProvider(options: {
    providerKey: string;
    mode: 'cooldown' | 'blacklist';
    durationMs: number;
  }): Promise<unknown> {
    if (!quotaRoutingEnabled) {
      return { ok: false, reason: 'quota_routing_disabled' };
    }

    const providerKey = options.providerKey;
    const mode = options.mode;
    const durationMs = options.durationMs;

    if (backend === 'rust') {
      if (typeof rustHostMutator?.disableProviderQuota === 'function') {
        await Promise.resolve(rustHostMutator.disableProviderQuota(providerKey, mode, durationMs));
        return { ok: true, providerKey, mode, source: 'rust' };
      }
      return rustQuotaMutatorUnavailableResult();
    }

    return { ok: false, reason: 'no_quota_manager_available' };
  }

  async function recoverProvider(providerKey: string): Promise<unknown> {
    if (!quotaRoutingEnabled) {
      return { ok: false, reason: 'quota_routing_disabled' };
    }

    if (backend === 'rust') {
      if (typeof rustHostMutator?.recoverProviderQuota === 'function') {
        await Promise.resolve(rustHostMutator.recoverProviderQuota(providerKey));
        return { ok: true, providerKey, source: 'rust' };
      }
      return rustQuotaMutatorUnavailableResult();
    }

    return { ok: false, reason: 'no_quota_manager_available' };
  }

  async function resetProvider(providerKey: string): Promise<unknown> {
    if (!quotaRoutingEnabled) {
      return { ok: false, reason: 'quota_routing_disabled' };
    }

    if (backend === 'rust') {
      if (typeof rustHostMutator?.resetProviderQuota === 'function') {
        await Promise.resolve(rustHostMutator.resetProviderQuota(providerKey));
        return { ok: true, providerKey, source: 'rust' };
      }
      return rustQuotaMutatorUnavailableResult();
    }

    return { ok: false, reason: 'no_quota_manager_available' };
  }

  async function clearCooldown(providerKey: string): Promise<unknown> {
    return await recoverProvider(providerKey);
  }

  async function restoreNow(providerKey: string): Promise<unknown> {
    return await resetProvider(providerKey);
  }

  async function setQuota(options: { providerKey: string; quota: number; reason?: string }): Promise<unknown> {
    if (!quotaRoutingEnabled) {
      return { ok: false, reason: 'quota_routing_disabled' };
    }
    const providerKey = typeof options.providerKey === 'string' ? options.providerKey.trim() : '';
    const quota = Number(options.quota);
    const depletedReason =
      typeof options.reason === 'string' && options.reason.trim().length
        ? options.reason.trim()
        : 'quotaDepleted';

    if (!providerKey || !Number.isFinite(quota)) {
      return { ok: false, reason: 'providerKey_and_quota_required' };
    }

    if (backend === 'rust') {
      if (quota > 0 && typeof rustHostMutator?.recoverProviderQuota === 'function') {
        await Promise.resolve(rustHostMutator.recoverProviderQuota(providerKey));
        return { ok: true, providerKey, quota, inPool: true, reason: 'active', source: 'rust' };
      }
      if (quota <= 0 && typeof rustHostMutator?.disableProviderQuota === 'function') {
        await Promise.resolve(rustHostMutator.disableProviderQuota(providerKey, 'cooldown', 5 * 60_000));
        return { ok: true, providerKey, quota, inPool: false, reason: depletedReason, source: 'rust' };
      }
      return rustQuotaMutatorUnavailableResult();
    }

    return { ok: false, reason: 'no_quota_manager_available' };
  }

  function registerProviderStaticConfig(providerKey: string, config: StaticQuotaConfig): void {
    if (!quotaRoutingEnabled) {
      return;
    }

    staticConfigRegistry.set(providerKey, config);

    return;
  }

  function recordProviderUsage(event: { providerKey: string; requestedTokens?: number | null; timestampMs?: number }): void {
    if (!quotaRoutingEnabled) {
      return;
    }

    return;
  }


  function readRustHostSnapshot(): Record<string, QuotaViewEntry> | null {
    if (typeof rustHostMutator?.getStatus !== 'function') {
      return null;
    }
    try {
      const status = rustHostMutator.getStatus();
      const snapshot = Array.isArray(status?.quotaHostSnapshot) ? status.quotaHostSnapshot : null;
      if (!snapshot || snapshot.length === 0) {
        return null;
      }
      const out: Record<string, QuotaViewEntry> = {};
      for (const entry of snapshot) {
        if (!entry || typeof entry !== 'object') {
          continue;
        }
        const v = entry as Record<string, unknown>;
        const providerKey = typeof v.providerKey === 'string' ? v.providerKey : '';
        if (!providerKey) {
          continue;
        }
        out[providerKey] = {
          providerKey,
          inPool: Boolean(v.inPool),
          reason: typeof v.reason === 'string' ? v.reason : undefined,
          priorityTier: typeof v.priorityTier === 'number' ? v.priorityTier : undefined,
          selectionPenalty: typeof v.selectionPenalty === 'number' ? v.selectionPenalty : undefined,
          lastErrorAtMs: typeof v.lastErrorAtMs === 'number' ? v.lastErrorAtMs : null,
          cooldownUntil: typeof v.cooldownUntil === 'number' ? v.cooldownUntil : null,
          cooldownKeepsPool: v.cooldownKeepsPool === true ? true : undefined,
          blacklistUntil: typeof v.blacklistUntil === 'number' ? v.blacklistUntil : null,
          authIssue: v.authIssue,
          authType: typeof v.authType === 'string' ? v.authType : undefined,
          consecutiveErrorCount: typeof v.consecutiveErrorCount === 'number' ? v.consecutiveErrorCount : 0
        };
      }
      return Object.keys(out).length > 0 ? out : null;
    } catch (error) {
      logQuotaAdapterNonBlockingError('readRustHostSnapshot', error);
      return null;
    }
  }

  function getQuotaView(): (providerKey: string) => QuotaViewEntry | null {
    if (!quotaRoutingEnabled) {
      return () => null;
    }

    if (backend === 'rust') {
      const rustSnapshot = readRustHostSnapshot();
      if (rustSnapshot) {
        return (providerKey: string) => {
          const key = typeof providerKey === 'string' ? providerKey.trim() : '';
          if (!key) {
            return null;
          }
          return rustSnapshot[key] ?? null;
        };
      }

    }

    return () => null;
  }

  function getAdminSnapshot(): Record<string, QuotaViewEntry> {
    const result: Record<string, QuotaViewEntry> = {};

    if (backend === 'rust') {
      const rustSnapshot = readRustHostSnapshot();
      if (rustSnapshot) {
        return rustSnapshot;
      }
    }

    return result;
  }

  async function refreshNow(): Promise<{ refreshedAt: number; tokenCount: number; recordCount: number }> {
    const snapshot = getAdminSnapshot();
    return {
      refreshedAt: Date.now(),
      tokenCount: 0,
      recordCount: Object.keys(snapshot).length
    };
  }

  return {
    get isUnified() {
      return backend === 'rust';
    },
    init,
    start,
    stop,
    disableProvider,
    recoverProvider,
    resetProvider,
    clearCooldown,
    restoreNow,
    setQuota,
    registerProviderStaticConfig,
    recordProviderUsage,
    getQuotaView,
    getAdminSnapshot,
    refreshNow
  };
}
