import { homedir } from 'node:os';

import type { ManagerContext, ManagerModule } from '../../types.js';
import type { AntigravityQuotaSnapshot } from '../../../providers/core/runtime/antigravity-quota-client.js';
import * as llmsBridge from '../../../modules/llmswitch/bridge.js';
import type { StaticQuotaConfig } from '../../../modules/llmswitch/bridge.js';
import {
  assertCoreQuotaManagerApis,
  type CoreQuotaManager
} from './antigravity-quota-core.js';
import {
  buildAntigravitySnapshotKey,
  computeResetAt,
  extractAntigravityAlias,
  isAntigravityModelProtected,
  parseAntigravityProviderKey,
  parseAntigravitySnapshotKey,
  readProtectedModelsFromTokenFile
} from './antigravity-quota-helpers.js';
import {
  createQuotaStore,
  loadAntigravitySnapshotFromDisk,
  saveAntigravitySnapshotToDisk,
  type QuotaRecordLike,
  type QuotaStorePersistenceStatus
} from './antigravity-quota-persistence.js';
import {
  applyAntigravityQuotaToCore,
  refreshAllAntigravityQuotas,
  syncAntigravityTokensFromDisk,
  type AntigravityTokenRegistration
} from './antigravity-quota-sync.js';
import {
  getSnapshotRecordByAliasAndModel,
  handleQuotaPersistenceIssue,
  reconcileProtectedStates,
  scheduleNextRefresh as scheduleNextQuotaRefresh,
  subscribeToProviderCenters as subscribeQuotaProviderCenters
} from './antigravity-quota-runtime.js';

export interface QuotaRecord {
  remainingFraction: number | null;
  resetAt?: number;
  fetchedAt: number;
}

const ANTIGRAVITY_PROTECTED_REASON = 'protected';

export class QuotaManagerModule implements ManagerModule {
  readonly id = 'quota';
  private snapshot: Record<string, QuotaRecord> = {};
  private antigravityTokens: Map<string, AntigravityTokenRegistration> = new Map();
  private antigravityProtectedModels: Map<string, Set<string>> = new Map();
  private registeredProviderKeys: Set<string> = new Set();
  private refreshTimer: NodeJS.Timeout | null = null;
  private quotaRoutingEnabled = true;
  private refreshFailures = 0;
  private refreshDisabled = false;
  private providerErrorUnsub: (() => void) | null = null;
  private providerSuccessUnsub: (() => void) | null = null;
  private quotaStorePersistenceStatus: QuotaStorePersistenceStatus = 'unknown';
  private quotaStoreLastUnbindReason: string | null = null;
  private coreQuotaManager: CoreQuotaManager | null = null;
  private quotaStorePath: string | null = null;
  private resolveHomeDir(): string {
    const envHome = typeof process.env.HOME === 'string' ? process.env.HOME.trim() : '';
    if (envHome) {
      return envHome;
    }
    return homedir();
  }
  async init(context: ManagerContext): Promise<void> {
    this.snapshot = loadAntigravitySnapshotFromDisk(() => this.resolveHomeDir()) as Record<string, QuotaRecord>;
    this.quotaRoutingEnabled = context.quotaRoutingEnabled !== false;
    try {
      await this.syncAntigravityTokensFromDisk();
    } catch {
      // best-effort; never block server init
    }
    if (!this.quotaRoutingEnabled) {
      this.coreQuotaManager = null;
      return;
    }
    const store = createQuotaStore({
      resolveHomeDir: () => this.resolveHomeDir(),
      onStorePath: (filePath: string) => {
        this.quotaStorePath = filePath;
      },
      onStatus: (status: QuotaStorePersistenceStatus) => {
        this.quotaStorePersistenceStatus = status;
        if (status === 'loaded') {
          this.quotaStoreLastUnbindReason = null;
        }
      },
      onSessionUnbindIssue: (reason: string) => {
        this.handleSessionUnbindForQuotaPersistenceIssue(reason);
      }
    });
    this.coreQuotaManager = (await llmsBridge.createCoreQuotaManager({ store })) as any;
    assertCoreQuotaManagerApis(this.coreQuotaManager as any);
    if (this.coreQuotaManager && typeof this.coreQuotaManager.hydrateFromStore === 'function') {
      await this.coreQuotaManager.hydrateFromStore().catch(() => {});
    }
    if (this.quotaStorePersistenceStatus === 'missing' || this.quotaStorePersistenceStatus === 'load_error') {
      this.handleSessionUnbindForQuotaPersistenceIssue(`quota_store_${this.quotaStorePersistenceStatus}`);
    }
    try {
      const nowMs = Date.now();
      for (const [key, record] of Object.entries(this.snapshot)) {
        const parsed = parseAntigravitySnapshotKey(key);
        if (!parsed) {
          continue;
        }
        applyAntigravityQuotaToCore({
          coreQuotaManager: this.coreQuotaManager,
          providerKey: `antigravity.${parsed.alias}.${parsed.modelId}`,
          record,
          nowMs,
          protectedReason: ANTIGRAVITY_PROTECTED_REASON,
          isProviderProtected: (providerKey: string) => this.isAntigravityProviderProtected(providerKey)
        });
      }
      this.reconcileProtectedStatesForRegisteredProviders();
    } catch {
      // ignore snapshot apply failures
    }
  }
  start(): Promise<void> | void {
    if (!this.quotaRoutingEnabled) {
      return;
    }
    try {
      void this.subscribeToProviderCenters();
    } catch {
      // ignore subscription failures
    }
    const refreshPromise = this.refreshAllAntigravityQuotas()
      .then((result) => {
        if (result.attempted > 0 && result.successCount === 0) {
          this.refreshFailures = 1;
        } else if (result.successCount > 0) {
          this.refreshFailures = 0;
        }
      })
      .catch(() => {
        // ignore startup refresh failures
      });
    void this.scheduleNextRefresh().catch(() => {
      // ignore scheduling failures
    });
    if (process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'test') {
      return refreshPromise;
    }
    return;
  }
  async stop(): Promise<void> {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.providerErrorUnsub) {
      try {
        this.providerErrorUnsub();
      } catch {
        // ignore
      }
      this.providerErrorUnsub = null;
    }
    if (this.providerSuccessUnsub) {
      try {
        this.providerSuccessUnsub();
      } catch {
        // ignore
      }
      this.providerSuccessUnsub = null;
    }
    try {
      if (this.coreQuotaManager && typeof this.coreQuotaManager.persistNow === 'function') {
        await this.coreQuotaManager.persistNow();
      }
    } catch {
      // ignore persistence failures
    }
    void this.saveSnapshotToDisk().catch(() => {
      // best-effort; ignore persistence errors
    });
  }
  async refreshNow(): Promise<{ refreshedAt: number; tokenCount: number; recordCount: number }> {
    const refreshedAt = Date.now();
    try {
      const result = await this.refreshAllAntigravityQuotas();
      if (result.successCount > 0) {
        this.refreshFailures = 0;
        this.refreshDisabled = false;
      }
    } catch {
      // ignore refresh failures
    }
    try {
      void this.scheduleNextRefresh();
    } catch {
      // ignore scheduling failures
    }
    return {
      refreshedAt,
      tokenCount: this.antigravityTokens.size,
      recordCount: Object.keys(this.snapshot).length
    };
  }
  async reset(): Promise<{ refreshedAt: number; tokenCount: number; recordCount: number }> {
    return await this.refreshNow();
  }
  registerAntigravityToken(alias: string, tokenFile: string, apiBase: string): void {
    const cleanAlias = alias.trim();
    const cleanToken = tokenFile.trim();
    const cleanBase = apiBase.trim();
    if (!cleanAlias || !cleanToken || !cleanBase) {
      return;
    }
    this.antigravityTokens.set(cleanAlias, {
      alias: cleanAlias,
      tokenFile: cleanToken,
      apiBase: cleanBase
    });
    void readProtectedModelsFromTokenFile(cleanToken)
      .then((protectedModels) => {
        if (protectedModels.size > 0) {
          this.antigravityProtectedModels.set(cleanAlias, protectedModels);
        } else {
          this.antigravityProtectedModels.delete(cleanAlias);
        }
        this.reconcileProtectedStatesForRegisteredProviders();
      })
      .catch(() => {
        // best-effort only
      });
  }
  updateAntigravityQuota(alias: string, quota: AntigravityQuotaSnapshot): void {
    const aliasId = alias.trim();
    if (!aliasId) {
      return;
    }
    const now = Date.now();
    const next: Record<string, QuotaRecord> = { ...this.snapshot };
    for (const [modelId, info] of Object.entries(quota.models)) {
      const key = buildAntigravitySnapshotKey(aliasId, modelId);
      const record: QuotaRecord = {
        remainingFraction: Number.isFinite(info.remainingFraction) ? info.remainingFraction : null,
        fetchedAt: quota.fetchedAt
      };
      const resetAt = computeResetAt(info.resetTimeRaw);
      if (resetAt) {
        record.resetAt = resetAt;
      }
      next[key] = record;
      applyAntigravityQuotaToCore({
        coreQuotaManager: this.coreQuotaManager,
        providerKey: `antigravity.${aliasId}.${modelId}`,
        record,
        nowMs: now,
        protectedReason: ANTIGRAVITY_PROTECTED_REASON,
        isProviderProtected: (providerKey: string) => this.isAntigravityProviderProtected(providerKey)
      });
    }
    this.snapshot = next;
    void this.saveSnapshotToDisk().catch(() => {
      // best-effort; ignore persistence errors
    });
  }
  hasQuotaForAntigravity(providerKey: string, modelId?: string): boolean {
    const alias = extractAntigravityAlias(providerKey);
    if (!alias || !modelId) {
      return true;
    }
    if (this.isAntigravityModelProtected(alias, modelId)) {
      return false;
    }
    const key = buildAntigravitySnapshotKey(alias, modelId);
    const record = this.snapshot[key];
    if (!record) {
      return false;
    }
    const now = Date.now();
    if (record.resetAt && record.resetAt <= now) {
      return false;
    }
    if (record.remainingFraction === null) {
      return false;
    }
    return record.remainingFraction > 0;
  }
  getRawSnapshot(): Record<string, QuotaRecord> {
    return { ...this.snapshot };
  }
  getQuotaView(): (providerKey: string) => unknown {
    const mgr = this.coreQuotaManager;
    if (!mgr || typeof mgr.getQuotaView !== 'function') {
      return () => null;
    }
    try {
      return mgr.getQuotaView();
    } catch {
      return () => null;
    }
  }
  getQuotaViewReadOnly(): (providerKey: string) => unknown {
    return this.getQuotaView();
  }
  getAdminSnapshot(): Record<string, unknown> {
    const mgr = this.coreQuotaManager;
    const snap = mgr && typeof mgr.getSnapshot === 'function' ? (mgr.getSnapshot() as any) : null;
    const providers =
      snap && typeof snap === 'object' && snap.providers && typeof snap.providers === 'object'
        ? (snap.providers as Record<string, unknown>)
        : {};
    return providers;
  }
  getCoreQuotaManager(): typeof this.coreQuotaManager | null {
    return this.quotaRoutingEnabled ? (this.coreQuotaManager as typeof this.coreQuotaManager) : null;
  }
  registerProviderStaticConfig(
    providerKey: string,
    config: { authType?: string | null; priorityTier?: number | null; apikeyDailyResetTime?: string | null } = {}
  ): void {
    const key = typeof providerKey === 'string' ? providerKey.trim() : '';
    if (!key) return;
    const authType = typeof config.authType === 'string' ? config.authType.trim().toLowerCase() : '';
    const priorityTier =
      typeof config.priorityTier === 'number' && Number.isFinite(config.priorityTier)
        ? Math.floor(config.priorityTier)
        : undefined;
    const apikeyDailyResetTime =
      typeof config.apikeyDailyResetTime === 'string' && config.apikeyDailyResetTime.trim().length
        ? config.apikeyDailyResetTime.trim()
        : undefined;
    const cfg: StaticQuotaConfig = {
      ...(priorityTier !== undefined ? { priorityTier } : {}),
      ...(authType === 'apikey' || authType === 'oauth' ? { authType: authType as any } : {}),
      ...(apikeyDailyResetTime ? { apikeyDailyResetTime } : {})
    };
    this.registeredProviderKeys.add(key);
    try {
      this.coreQuotaManager?.registerProviderStaticConfig?.(key, cfg);
      this.reconcileProtectedStatesForRegisteredProviders();
    } catch {
      // ignore
    }
  }
  async disableProvider(options: {
    providerKey: string;
    mode: 'cooldown' | 'blacklist';
    durationMs: number;
  }): Promise<unknown> {
    const mgr = this.coreQuotaManager;
    if (!mgr) {
      throw new Error('core quota manager not available');
    }
    (mgr as any).disableProvider({ ...options });
    await mgr.persistNow?.().catch(() => {});
    return { ok: true };
  }
  async recoverProvider(providerKey: string): Promise<unknown> {
    const mgr = this.coreQuotaManager;
    if (!mgr) {
      throw new Error('core quota manager not available');
    }
    (mgr as any).recoverProvider(providerKey);
    await mgr.persistNow?.().catch(() => {});
    return { ok: true };
  }
  async resetProvider(providerKey: string): Promise<unknown> {
    const mgr = this.coreQuotaManager;
    if (!mgr) {
      throw new Error('core quota manager not available');
    }
    (mgr as any).resetProvider(providerKey);
    await mgr.persistNow?.().catch(() => {});
    return { ok: true };
  }
  private isAntigravityModelProtected(alias: string, modelId: string): boolean {
    return isAntigravityModelProtected(this.antigravityProtectedModels, alias, modelId);
  }
  private isAntigravityProviderProtected(providerKey: string): boolean {
    const parsed = parseAntigravityProviderKey(providerKey);
    if (!parsed) {
      return false;
    }
    return this.isAntigravityModelProtected(parsed.alias, parsed.modelId);
  }
  private reconcileProtectedStatesForRegisteredProviders(): void {
    reconcileProtectedStates({
      coreQuotaManager: this.coreQuotaManager,
      protectedReason: ANTIGRAVITY_PROTECTED_REASON,
      registeredProviderKeys: this.registeredProviderKeys,
      adminSnapshot: this.getAdminSnapshot(),
      isModelProtected: (alias: string, modelId: string) => this.isAntigravityModelProtected(alias, modelId),
      getSnapshotRecord: (alias: string, modelId: string) =>
        getSnapshotRecordByAliasAndModel(this.snapshot, alias, modelId),
      applyQuotaRecord: (providerKey: string, record: QuotaRecordLike) => {
        applyAntigravityQuotaToCore({
          coreQuotaManager: this.coreQuotaManager,
          providerKey,
          record,
          nowMs: Date.now(),
          protectedReason: ANTIGRAVITY_PROTECTED_REASON,
          isProviderProtected: (key: string) => this.isAntigravityProviderProtected(key)
        });
      }
    });
  }
  private async refreshAllAntigravityQuotas(): Promise<{ attempted: number; successCount: number; failureCount: number }> {
    return await refreshAllAntigravityQuotas({
      tokens: this.antigravityTokens,
      syncTokensFromDisk: async () => {
        await this.syncAntigravityTokensFromDisk();
      },
      updateAntigravityQuota: (alias: string, quota: AntigravityQuotaSnapshot) => {
        this.updateAntigravityQuota(alias, quota);
      }
    });
  }
  private handleSessionUnbindForQuotaPersistenceIssue(reason: string): void {
    this.quotaStoreLastUnbindReason = handleQuotaPersistenceIssue({
      reason,
      lastReason: this.quotaStoreLastUnbindReason,
      quotaStorePath: this.quotaStorePath,
      clearSessionAliasPins: () => llmsBridge.clearAntigravitySessionAliasPins?.({ hydrate: true })
    });
  }
  private async subscribeToProviderCenters(): Promise<void> {
    const { providerErrorUnsub, providerSuccessUnsub } = await subscribeQuotaProviderCenters({
      bridge: llmsBridge,
      coreQuotaManager: this.coreQuotaManager
    });
    this.providerErrorUnsub = providerErrorUnsub;
    this.providerSuccessUnsub = providerSuccessUnsub;
  }
  private async scheduleNextRefresh(): Promise<void> {
    this.refreshTimer = scheduleNextQuotaRefresh({
      currentTimer: this.refreshTimer,
      getRefreshDisabled: () => this.refreshDisabled,
      getRefreshFailures: () => this.refreshFailures,
      refreshAllAntigravityQuotas: () => this.refreshAllAntigravityQuotas(),
      onRefreshFailuresChange: (nextFailures: number) => {
        this.refreshFailures = nextFailures;
      },
      onRefreshDisabledChange: (nextDisabled: boolean) => {
        this.refreshDisabled = nextDisabled;
      },
      onReschedule: () => {
        void this.scheduleNextRefresh().catch(() => {
          // ignore reschedule failure
        });
      }
    });
  }
  private async syncAntigravityTokensFromDisk(): Promise<void> {
    const result = await syncAntigravityTokensFromDisk({
      currentTokens: this.antigravityTokens,
      currentSnapshot: this.snapshot as Record<string, QuotaRecordLike>,
      parseSnapshotKey: parseAntigravitySnapshotKey,
      readProtectedModelsFromTokenFile
    });
    this.antigravityTokens = result.tokens;
    this.antigravityProtectedModels = result.protectedModels;
    this.snapshot = result.snapshot as Record<string, QuotaRecord>;
    if (result.snapshotChanged) {
      void this.saveSnapshotToDisk().catch(() => {
        // best-effort; ignore persistence errors
      });
    }
    this.reconcileProtectedStatesForRegisteredProviders();
  }
  private async saveSnapshotToDisk(): Promise<void> {
    await saveAntigravitySnapshotToDisk(
      () => this.resolveHomeDir(),
      this.snapshot as Record<string, QuotaRecordLike>
    );
  }
}
