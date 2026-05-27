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
import type { ProviderErrorEvent, ProviderSuccessEvent } from '../../../types/llmswitch-local-types.js';
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

export interface CoreQuotaManagerLike {
  hydrateFromStore?(): Promise<void>;
  registerProviderStaticConfig?(providerKey: string, cfg: StaticQuotaConfig): void;
  onProviderError?(ev: ProviderErrorEvent): void;
  onProviderSuccess?(ev: ProviderSuccessEvent): void;
  disableProvider?(options: { providerKey: string; mode: 'cooldown' | 'blacklist'; durationMs: number; reason?: string }): void;
  recoverProvider?(providerKey: string): void;
  resetProvider?(providerKey: string): void;
  getSnapshot?(): unknown;
  persistNow?(): Promise<void>;
}

export function createQuotaManagerAdapter(options: {
  coreManager: CoreQuotaManagerLike | null;
  rustHostMutator?: RustQuotaHostMutatorLike | null;
  quotaRoutingEnabled?: boolean;
}): QuotaManagerAdapter {
  const core = options.coreManager;
  const rustHostMutator = options.rustHostMutator ?? null;
  const hasCore = core !== null && x7eGate.phase1UnifiedQuota;
  const backend: 'core' | 'none' = hasCore ? 'core' : 'none';
  const quotaRoutingEnabled = options.quotaRoutingEnabled !== false;

  // Track provider static configs for bootstrap
  const staticConfigRegistry = new Map<string, StaticQuotaConfig>();

  async function init(): Promise<void> {
    if (hasCore && core?.hydrateFromStore) {
      await core.hydrateFromStore().catch((error) => {
        logQuotaAdapterNonBlockingError('hydrateFromStore', error);
      });
    }
  }

  async function start(): Promise<void> {
    // Core manager lifecycle is handled externally (created in QuotaManagerModule)
    // This adapter just ensures event subscriptions are ready
  }

  async function stop(): Promise<void> {
    if (hasCore && core?.persistNow) {
      await core.persistNow().catch((error) => {
        logQuotaAdapterNonBlockingError('persistNow(stop)', error);
      });
    }
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

    if (backend === 'core') {
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

    if (backend === 'core') {
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

    if (backend === 'core') {
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

    if (backend === 'core') {
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

    if (backend === 'core' && core?.registerProviderStaticConfig) {
      try {
        core.registerProviderStaticConfig(providerKey, config);
      } catch (error) {
        logQuotaAdapterNonBlockingError(`registerProviderStaticConfig:${providerKey}`, error);
      }
      return;
    }

  }

  function recordProviderUsage(event: { providerKey: string; requestedTokens?: number | null; timestampMs?: number }): void {
    if (!quotaRoutingEnabled) {
      return;
    }

    if (backend === 'core') {
      // Core handles usage internally via success/error events
      // This hook is for explicit usage tracking if needed
      return;
    }

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

    if (backend === 'core') {
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

      const getSnapshot = core?.getSnapshot;
      if (typeof getSnapshot === 'function') {
        return (providerKey: string) => {
          const key = typeof providerKey === 'string' ? providerKey.trim() : '';
          if (!key) {
            return null;
          }
          const snap = getSnapshot();
          const providers =
            snap && typeof snap === 'object' && (snap as Record<string, unknown>).providers && typeof (snap as Record<string, unknown>).providers === 'object'
              ? ((snap as Record<string, unknown>).providers as Record<string, unknown>)
              : null;
          const raw = providers?.[key];
          if (!raw || typeof raw !== 'object') {
            return null;
          }
          const r = raw as Record<string, unknown>;
          return {
            providerKey: String(r.providerKey ?? key),
            inPool: Boolean(r.inPool),
            reason: typeof r.reason === 'string' ? r.reason : undefined,
            priorityTier: typeof r.priorityTier === 'number' ? r.priorityTier : undefined,
            cooldownUntil: typeof r.cooldownUntil === 'number' ? r.cooldownUntil : null,
            cooldownKeepsPool: r.cooldownKeepsPool === true ? true : undefined,
            blacklistUntil: typeof r.blacklistUntil === 'number' ? r.blacklistUntil : null,
            authIssue: r.authIssue,
            authType: typeof r.authType === 'string' ? r.authType : undefined,
            consecutiveErrorCount: typeof r.consecutiveErrorCount === 'number' ? r.consecutiveErrorCount : 0
          };
        };
      }

    }

    return () => null;
  }

  function getAdminSnapshot(): Record<string, QuotaViewEntry> {
    const result: Record<string, QuotaViewEntry> = {};

    if (backend === 'core') {
      const rustSnapshot = readRustHostSnapshot();
      if (rustSnapshot) {
        return rustSnapshot;
      }
    }

    // Prefer core snapshot
    if (backend === 'core' && core?.getSnapshot) {
      const snap = core.getSnapshot();
      if (snap && typeof snap === 'object') {
        const providers = (snap as Record<string, unknown>).providers;
        if (providers && typeof providers === 'object') {
          for (const [key, value] of Object.entries(providers)) {
            if (!value || typeof value !== 'object') {
              continue;
            }
            const v = value as Record<string, unknown>;
            result[key] = {
              providerKey: String(v.providerKey ?? key),
              inPool: Boolean(v.inPool),
              reason: typeof v.reason === 'string' ? v.reason : undefined,
              priorityTier: typeof v.priorityTier === 'number' ? v.priorityTier : undefined,
              cooldownUntil: typeof v.cooldownUntil === 'number' ? v.cooldownUntil : null,
              blacklistUntil: typeof v.blacklistUntil === 'number' ? v.blacklistUntil : null,
              authIssue: v.authIssue,
              authType: typeof v.authType === 'string' ? v.authType : undefined,
              consecutiveErrorCount: typeof v.consecutiveErrorCount === 'number' ? v.consecutiveErrorCount : 0
            };
          }
          return result;
        }
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
      return backend === 'core';
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
