/**
 * QuotaManager SSOT Adapter (RouteCodex-X7E Phase 1)
 *
 * Provides a unified facade over the core QuotaManager for all quota operations.
 * - Routes all quota state mutations through core QuotaManager when available
 * - Falls back to legacy ProviderQuotaDaemonModule when core is unavailable
 * - Ensures admin snapshot reads return consistent unified view
 *
 * This is the **only** entry point for quota operations in the new path.
 * Legacy ProviderQuotaDaemonModule should not be used for new mutations.
 */

import type { ProviderErrorEvent, ProviderSuccessEvent } from '../../../modules/llmswitch/bridge.js';
import type { QuotaState, StaticQuotaConfig } from '../../quota/provider-quota-center.js';
import { x7eGate } from '../../../server/runtime/http-server/daemon-admin/routecodex-x7e-gate.js';

export interface QuotaViewEntry {
  providerKey: string;
  inPool: boolean;
  reason?: string;
  priorityTier?: number;
  cooldownUntil?: number | null;
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
  registerProviderStaticConfig(providerKey: string, config: StaticQuotaConfig): void;

  // Event handlers
  onProviderError(event: ProviderErrorEvent): void;
  onProviderSuccess(event: ProviderSuccessEvent): void;
  recordProviderUsage(event: { providerKey: string; requestedTokens?: number | null; timestampMs?: number }): void;

  // Queries
  getQuotaView(): (providerKey: string) => QuotaViewEntry | null;
  getAdminSnapshot(): Record<string, QuotaViewEntry>;
  refreshNow(): Promise<{ refreshedAt: number; tokenCount: number; recordCount: number }>;
}

export interface CoreQuotaManagerLike {
  hydrateFromStore?(): Promise<void>;
  registerProviderStaticConfig?(providerKey: string, cfg: StaticQuotaConfig): void;
  onProviderError?(ev: ProviderErrorEvent): void;
  onProviderSuccess?(ev: ProviderSuccessEvent): void;
  updateProviderPoolState?(options: {
    providerKey: string;
    inPool: boolean;
    reason?: string | null;
    cooldownUntil?: number | null;
    blacklistUntil?: number | null;
  }): void;
  disableProvider?(options: { providerKey: string; mode: 'cooldown' | 'blacklist'; durationMs: number; reason?: string }): void;
  recoverProvider?(providerKey: string): void;
  resetProvider?(providerKey: string): void;
  getQuotaView?(): (providerKey: string) => unknown;
  getSnapshot?(): unknown;
  persistNow?(): Promise<void>;
}

export function createQuotaManagerAdapter(options: {
  coreManager: CoreQuotaManagerLike | null;
  legacyDaemon?: {
    disableProvider?(options: { providerKey: string; mode: 'cooldown' | 'blacklist'; durationMs: number }): Promise<unknown>;
    recoverProvider?(providerKey: string): Promise<unknown>;
    resetProvider?(providerKey: string): Promise<unknown>;
    registerProviderStaticConfig?(providerKey: string, config: StaticQuotaConfig): void;
    onProviderError?(event: ProviderErrorEvent): void;
    onProviderSuccess?(event: ProviderSuccessEvent): void;
    recordProviderUsage?(event: { providerKey: string; requestedTokens?: number | null; timestampMs?: number }): void;
    getQuotaView?(): (providerKey: string) => QuotaViewEntry | null;
    getAdminSnapshot?(): Record<string, QuotaState>;
    refreshNow?(): Promise<{ refreshedAt: number; tokenCount: number; recordCount: number }>;
  } | null;
  quotaRoutingEnabled?: boolean;
}): QuotaManagerAdapter {
  const core = options.coreManager;
  const legacy = options.legacyDaemon;
  const hasCore = core !== null && x7eGate.phase1UnifiedQuota;
  const quotaRoutingEnabled = options.quotaRoutingEnabled !== false;

  // Track provider static configs for bootstrap
  const staticConfigRegistry = new Map<string, StaticQuotaConfig>();

  async function init(): Promise<void> {
    if (hasCore && core?.hydrateFromStore) {
      await core.hydrateFromStore().catch(() => {});
    }
  }

  async function start(): Promise<void> {
    // Core manager lifecycle is handled externally (created in QuotaManagerModule)
    // This adapter just ensures event subscriptions are ready
  }

  async function stop(): Promise<void> {
    if (hasCore && core?.persistNow) {
      await core.persistNow().catch(() => {});
    }
  }

  function withFallback<T>(
    coreFn: () => T | undefined | Promise<T>,
    legacyFn: () => T | undefined | Promise<T>,
    defaultValue: T
  ): T | Promise<T> {
    if (hasCore) {
      const result = coreFn();
      if (result !== undefined && result !== null) {
        return result;
      }
    }
    if (legacy) {
      const result = legacyFn();
      if (result !== undefined && result !== null) {
        return result;
      }
    }
    return defaultValue;
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

    if (hasCore && core?.disableProvider) {
      core.disableProvider({ providerKey, mode, durationMs, reason: mode === 'blacklist' ? 'operator' : 'auto' });
      if (core.persistNow) {
        await core.persistNow().catch(() => {});
      }
      return { ok: true, providerKey, mode, source: 'core' };
    }

    if (legacy?.disableProvider) {
      return await legacy.disableProvider({ providerKey, mode, durationMs });
    }

    return { ok: false, reason: 'no_quota_manager_available' };
  }

  async function recoverProvider(providerKey: string): Promise<unknown> {
    if (!quotaRoutingEnabled) {
      return { ok: false, reason: 'quota_routing_disabled' };
    }

    if (hasCore && core?.recoverProvider) {
      core.recoverProvider(providerKey);
      if (core.persistNow) {
        await core.persistNow().catch(() => {});
      }
      return { ok: true, providerKey, source: 'core' };
    }

    if (legacy?.recoverProvider) {
      return await legacy.recoverProvider(providerKey);
    }

    return { ok: false, reason: 'no_quota_manager_available' };
  }

  async function resetProvider(providerKey: string): Promise<unknown> {
    if (!quotaRoutingEnabled) {
      return { ok: false, reason: 'quota_routing_disabled' };
    }

    if (hasCore && core?.resetProvider) {
      core.resetProvider(providerKey);
      if (core.persistNow) {
        await core.persistNow().catch(() => {});
      }
      return { ok: true, providerKey, source: 'core' };
    }

    if (legacy?.resetProvider) {
      return await legacy.resetProvider(providerKey);
    }

    return { ok: false, reason: 'no_quota_manager_available' };
  }

  function registerProviderStaticConfig(providerKey: string, config: StaticQuotaConfig): void {
    if (!quotaRoutingEnabled) {
      return;
    }

    staticConfigRegistry.set(providerKey, config);

    if (hasCore && core?.registerProviderStaticConfig) {
      try {
        core.registerProviderStaticConfig(providerKey, config);
      } catch {
        // ignore
      }
      return;
    }

    if (legacy?.registerProviderStaticConfig) {
      legacy.registerProviderStaticConfig(providerKey, config);
    }
  }

  function onProviderError(event: ProviderErrorEvent): void {
    if (!quotaRoutingEnabled) {
      return;
    }

    if (hasCore && core?.onProviderError) {
      try {
        core.onProviderError(event);
      } catch {
        // ignore
      }
      return;
    }

    if (legacy?.onProviderError) {
      legacy.onProviderError(event);
    }
  }

  function onProviderSuccess(event: ProviderSuccessEvent): void {
    if (!quotaRoutingEnabled) {
      return;
    }

    if (hasCore && core?.onProviderSuccess) {
      try {
        core.onProviderSuccess(event);
      } catch {
        // ignore
      }
      return;
    }

    if (legacy?.onProviderSuccess) {
      legacy.onProviderSuccess(event);
    }
  }

  function recordProviderUsage(event: { providerKey: string; requestedTokens?: number | null; timestampMs?: number }): void {
    if (!quotaRoutingEnabled) {
      return;
    }

    if (hasCore) {
      // Core handles usage internally via success/error events
      // This hook is for explicit usage tracking if needed
      return;
    }

    if (legacy?.recordProviderUsage) {
      legacy.recordProviderUsage(event);
    }
  }

  function getQuotaView(): (providerKey: string) => QuotaViewEntry | null {
    if (!quotaRoutingEnabled) {
      return () => null;
    }

    if (hasCore && core?.getQuotaView) {
      const coreView = core.getQuotaView();
      return (providerKey: string) => {
        const raw = coreView(providerKey);
        if (!raw || typeof raw !== 'object') {
          return null;
        }
        const r = raw as Record<string, unknown>;
        return {
          providerKey: String(r.providerKey ?? providerKey),
          inPool: Boolean(r.inPool),
          reason: typeof r.reason === 'string' ? r.reason : undefined,
          priorityTier: typeof r.priorityTier === 'number' ? r.priorityTier : undefined,
          cooldownUntil: typeof r.cooldownUntil === 'number' ? r.cooldownUntil : null,
          blacklistUntil: typeof r.blacklistUntil === 'number' ? r.blacklistUntil : null,
          authIssue: r.authIssue,
          authType: typeof r.authType === 'string' ? r.authType : undefined,
          consecutiveErrorCount: typeof r.consecutiveErrorCount === 'number' ? r.consecutiveErrorCount : 0
        };
      };
    }

    if (legacy?.getQuotaView) {
      return legacy.getQuotaView();
    }

    return () => null;
  }

  function getAdminSnapshot(): Record<string, QuotaViewEntry> {
    const result: Record<string, QuotaViewEntry> = {};

    // Prefer core snapshot
    if (hasCore && core?.getSnapshot) {
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

    // Fall back to legacy
    if (legacy?.getAdminSnapshot) {
      const legacySnap = legacy.getAdminSnapshot();
      for (const [key, state] of Object.entries(legacySnap)) {
        result[key] = {
          providerKey: state.providerKey ?? key,
          inPool: state.inPool,
          reason: state.reason,
          priorityTier: state.priorityTier,
          cooldownUntil: state.cooldownUntil,
          blacklistUntil: state.blacklistUntil,
          authIssue: state.authIssue,
          authType: state.authType,
          consecutiveErrorCount: state.consecutiveErrorCount ?? 0
        };
      }
    }

    return result;
  }

  async function refreshNow(): Promise<{ refreshedAt: number; tokenCount: number; recordCount: number }> {
    if (legacy?.refreshNow) {
      return await legacy.refreshNow();
    }

    const snapshot = getAdminSnapshot();
    return {
      refreshedAt: Date.now(),
      tokenCount: 0,
      recordCount: Object.keys(snapshot).length
    };
  }

  return {
    get isUnified() {
      return hasCore;
    },
    init,
    start,
    stop,
    disableProvider,
    recoverProvider,
    resetProvider,
    registerProviderStaticConfig,
    onProviderError,
    onProviderSuccess,
    recordProviderUsage,
    getQuotaView,
    getAdminSnapshot,
    refreshNow
  };
}
