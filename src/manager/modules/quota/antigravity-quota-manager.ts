import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import fsAsync from 'node:fs/promises';

import type { ManagerContext, ManagerModule } from '../../types.js';
import {
  fetchAntigravityQuotaSnapshot,
  loadAntigravityAccessToken,
  type AntigravityQuotaSnapshot
} from '../../../providers/core/runtime/antigravity-quota-client.js';
import { scanProviderTokenFiles } from '../../../providers/auth/token-scanner/index.js';
import { resolveAntigravityApiBase } from '../../../providers/auth/antigravity-userinfo-helper.js';
import * as llmsBridge from '../../../modules/llmswitch/bridge.js';
import type { ProviderErrorEvent, ProviderSuccessEvent, StaticQuotaConfig, QuotaStoreSnapshot } from '../../../modules/llmswitch/bridge.js';
import { loadProviderQuotaSnapshot } from '../../quota/provider-quota-store.js';

export interface QuotaRecord {
  remainingFraction: number | null;
  resetAt?: number;
  fetchedAt: number;
}

interface AntigravityTokenRegistration {
  alias: string;
  tokenFile: string;
  apiBase: string;
}

type QuotaStorePersistenceStatus =
  | 'unknown'
  | 'loaded'
  | 'missing'
  | 'load_error'
  | 'save_error';

const ANTIGRAVITY_PROTECTED_REASON = 'protected';

type ParsedAntigravityProviderKey = {
  alias: string;
  modelId: string;
};

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

  private coreQuotaManager:
    | {
        hydrateFromStore?: () => Promise<void>;
        registerProviderStaticConfig?: (providerKey: string, cfg: StaticQuotaConfig) => void;
        onProviderError?: (ev: ProviderErrorEvent) => void;
        onProviderSuccess?: (ev: ProviderSuccessEvent) => void;
        updateProviderPoolState?: (options: {
          providerKey: string;
          inPool: boolean;
          reason?: string | null;
          cooldownUntil?: number | null;
          blacklistUntil?: number | null;
        }) => void;
        disableProvider?: (options: { providerKey: string; mode: 'cooldown' | 'blacklist'; durationMs: number; reason?: string }) => void;
        recoverProvider?: (providerKey: string) => void;
        resetProvider?: (providerKey: string) => void;
        getQuotaView?: () => (providerKey: string) => unknown;
        getSnapshot?: () => unknown;
        persistNow?: () => Promise<void>;
      }
    | null = null;

  private quotaStorePath: string | null = null;

  private resolveHomeDir(): string {
    const envHome = typeof process.env.HOME === 'string' ? process.env.HOME.trim() : '';
    if (envHome) {
      return envHome;
    }
    return homedir();
  }

  async init(context: ManagerContext): Promise<void> {
    this.snapshot = this.loadSnapshotFromDisk();
    this.quotaRoutingEnabled = context.quotaRoutingEnabled !== false;

    // IMPORTANT: prune persisted quota aliases using current token files on disk.
    // We must not “invent” aliases; admin UI should only show aliases that have a token file.
    // This is cheap (local fs read) and prevents stale entries like antigravity://a1/... lingering forever.
    try {
      await this.syncAntigravityTokensFromDisk();
    } catch {
      // best-effort; never block server init
    }

    // Core-owned quota manager: host provides only persistence I/O.
    // When quota routing is enabled, this must be available; otherwise Virtual Router quotaView becomes non-deterministic.
    if (!this.quotaRoutingEnabled) {
      this.coreQuotaManager = null;
      return;
    }
    const store = this.createQuotaStore();
    this.coreQuotaManager = (await llmsBridge.createCoreQuotaManager({ store })) as any;
    const mgrAny = this.coreQuotaManager as any;
    const missingApis =
      !mgrAny ||
      typeof mgrAny.getQuotaView !== 'function' ||
      typeof mgrAny.getSnapshot !== 'function' ||
      typeof mgrAny.updateProviderPoolState !== 'function' ||
      typeof mgrAny.resetProvider !== 'function' ||
      typeof mgrAny.recoverProvider !== 'function' ||
      typeof mgrAny.disableProvider !== 'function';
    if (missingApis) {
      const detail = {
        hasMgr: Boolean(mgrAny),
        getQuotaView: typeof mgrAny?.getQuotaView,
        getSnapshot: typeof mgrAny?.getSnapshot,
        updateProviderPoolState: typeof mgrAny?.updateProviderPoolState,
        resetProvider: typeof mgrAny?.resetProvider,
        recoverProvider: typeof mgrAny?.recoverProvider,
        disableProvider: typeof mgrAny?.disableProvider
      };
      throw new Error(`core quota manager missing expected APIs: ${JSON.stringify(detail)}`);
    }
    if (this.coreQuotaManager && typeof this.coreQuotaManager.hydrateFromStore === 'function') {
      await this.coreQuotaManager.hydrateFromStore().catch(() => {});
    }
    if (this.quotaStorePersistenceStatus === 'missing' || this.quotaStorePersistenceStatus === 'load_error') {
      this.handleSessionUnbindForQuotaPersistenceIssue(`quota_store_${this.quotaStorePersistenceStatus}`);
    }

    // Apply persisted Antigravity snapshot into the unified quota view (best-effort),
    // so restarts don't temporarily “forget” known depleted keys.
    try {
      const nowMs = Date.now();
      for (const [key, record] of Object.entries(this.snapshot)) {
        const parsed = this.parseAntigravitySnapshotKey(key);
        if (!parsed) {
          continue;
        }
        this.applyAntigravityQuotaToCore(`antigravity.${parsed.alias}.${parsed.modelId}`, record, nowMs);
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

    // Subscribe provider error/success streams -> core quota manager.
    try {
      void this.subscribeToProviderCenters();
    } catch {
      // ignore subscription failures
    }

    // IMPORTANT: startup must never block server initialization.
    // Run the initial refresh best-effort in the background; axios timeouts apply per request.
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

    // In Jest, await the refresh to keep unit tests deterministic.
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
      try { this.providerErrorUnsub(); } catch { /* ignore */ }
      this.providerErrorUnsub = null;
    }
    if (this.providerSuccessUnsub) {
      try { this.providerSuccessUnsub(); } catch { /* ignore */ }
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

  /**
   * Admin operation: force-refresh quota snapshots immediately (best-effort).
   * Exposed via daemon-admin endpoint `/quota/refresh`.
   */
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
    return { refreshedAt, tokenCount: this.antigravityTokens.size, recordCount: Object.keys(this.snapshot).length };
  }

  /**
   * daemon-admin "reset" semantics for quota module = refresh now.
   * Keeps module UX consistent across admin actions.
   */
  async reset(): Promise<{ refreshedAt: number; tokenCount: number; recordCount: number }> {
    return await this.refreshNow();
  }

  /**
   * 用于 antigravity：注册需要追踪配额的 alias/token。
   * 多次调用同一 alias 会覆盖最新配置。
   */
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
    void this.readProtectedModelsFromTokenFile(cleanToken)
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

  /**
   * 用于 antigravity：根据 alias+model 更新配额快照。
   */
  updateAntigravityQuota(alias: string, quota: AntigravityQuotaSnapshot): void {
    const aliasId = alias.trim();
    if (!aliasId) {
      return;
    }
    const now = Date.now();
    const next: Record<string, QuotaRecord> = { ...this.snapshot };
    for (const [modelId, info] of Object.entries(quota.models)) {
      const key = this.buildAntigravityKey(aliasId, modelId);
      const record: QuotaRecord = {
        remainingFraction: Number.isFinite(info.remainingFraction) ? info.remainingFraction : null,
        fetchedAt: quota.fetchedAt
      };
      const resetAt = this.computeResetAt(info.resetTimeRaw);
      // Keep resetAt even if it's already in the past so admin UI can inspect drift/staleness.
      // Routing gate still treats `resetAt <= now` as unknown quota and will block entry.
      if (resetAt) {
        record.resetAt = resetAt;
      }
      next[key] = record;
      const providerKey = `antigravity.${aliasId}.${modelId}`;
      // Unified quota routing: update pool state directly (quotaView becomes the single source of truth).
      this.applyAntigravityQuotaToCore(providerKey, record, now);
    }
    this.snapshot = next;
    void this.saveSnapshotToDisk().catch(() => {
      // best-effort; ignore persistence errors
    });
  }

  /**
   * 判断给定 providerKey+model 是否有可用配额（仅针对 antigravity 语义）。
   */
  hasQuotaForAntigravity(providerKey: string, modelId?: string): boolean {
    const alias = this.extractAntigravityAlias(providerKey);
    if (!alias || !modelId) {
      return true;
    }
    if (this.isAntigravityModelProtected(alias, modelId)) {
      return false;
    }
    const key = this.buildAntigravityKey(alias, modelId);
    const record = this.snapshot[key];
    if (!record) {
      // 没有任何配额记录时视为“无配额”，禁止进入路由池。
      return false;
    }
    const now = Date.now();
    // 如果已经超过 resetAt，但尚未刷新到新一轮配额，视为配额状态未知，同样禁止。
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

  /**
   * VirtualRouter consumes this via HubPipeline `quotaView` injection.
   */
  getQuotaView(): (providerKey: string) => unknown {
    const mgr = this.coreQuotaManager;
    if (!mgr || typeof mgr.getQuotaView !== 'function') {
      return () => null;
    }
    try {
      // IMPORTANT: call as a bound method; core quota manager uses `this.states`.
      return mgr.getQuotaView();
    } catch {
      return () => null;
    }
  }

  getQuotaViewReadOnly(): (providerKey: string) => unknown {
    // Current core quota view is already side-effect free for routing semantics;
    // keep the same view function to avoid duplicate logic.
    return this.getQuotaView();
  }

  getAdminSnapshot(): Record<string, unknown> {
    const mgr = this.coreQuotaManager;
    const snap = mgr && typeof mgr.getSnapshot === 'function' ? (mgr.getSnapshot() as any) : null;
    const providers = snap && typeof snap === 'object' && snap.providers && typeof snap.providers === 'object'
      ? (snap.providers as Record<string, unknown>)
      : {};
    return providers;
  }

  /**
   * X7E Phase 1: Expose core quota manager for adapter layer.
   * Returns null when quota routing is disabled (Phase 1 gate off).
   */
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
    const priorityTier = typeof config.priorityTier === 'number' && Number.isFinite(config.priorityTier)
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
      this.reconcileProtectedStateForProviderKey(key);
    } catch {
      // ignore
    }
  }

  async disableProvider(options: { providerKey: string; mode: 'cooldown' | 'blacklist'; durationMs: number }): Promise<unknown> {
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

  private buildAntigravityKey(alias: string, modelId: string): string {
    return `antigravity://${alias}/${modelId}`;
  }

  private parseAntigravitySnapshotKey(key: string): { alias: string; modelId: string } | null {
    const raw = typeof key === 'string' ? key.trim() : '';
    if (!raw.toLowerCase().startsWith('antigravity://')) {
      return null;
    }
    const rest = raw.slice('antigravity://'.length);
    const idx = rest.indexOf('/');
    if (idx <= 0) {
      return null;
    }
    const alias = rest.slice(0, idx).trim();
    const modelId = rest.slice(idx + 1).trim();
    if (!alias || !modelId) {
      return null;
    }
    return { alias, modelId };
  }

  private parseAntigravityProviderKey(providerKey?: string): ParsedAntigravityProviderKey | null {
    if (!providerKey || typeof providerKey !== 'string') {
      return null;
    }
    const trimmed = providerKey.trim();
    if (!trimmed.toLowerCase().startsWith('antigravity.')) {
      return null;
    }
    const segments = trimmed.split('.');
    if (segments.length < 3) {
      return null;
    }
    const alias = String(segments[1] || '').trim();
    const modelId = String(segments.slice(2).join('.') || '').trim();
    if (!alias || !modelId) {
      return null;
    }
    return { alias, modelId };
  }

  private normalizeProtectedModelFlag(raw: string): string[] {
    const normalized = raw.trim().toLowerCase();
    if (!normalized) {
      return [];
    }
    if (normalized.startsWith('gemini-3-pro-image') || normalized.includes('pro-image')) {
      return ['gemini-3-pro-image'];
    }
    if (normalized === 'gemini-pro' || normalized === 'gemini-3-pro-high') {
      return ['gemini-pro', 'gemini-3-pro-high'];
    }
    if (normalized === 'gemini-flash' || normalized === 'gemini-3-flash') {
      return ['gemini-flash', 'gemini-3-flash'];
    }
    if (
      normalized === 'claude' ||
      normalized.includes('claude') ||
      normalized.includes('sonnet') ||
      normalized.includes('opus') ||
      normalized.includes('haiku')
    ) {
      return ['claude'];
    }
    return [normalized];
  }

  private resolveProtectedModelCandidates(modelId: string): Set<string> {
    const normalized = String(modelId || '').trim().toLowerCase();
    const candidates = new Set<string>();
    if (!normalized) {
      return candidates;
    }
    candidates.add(normalized);
    if (normalized.startsWith('gemini-3-pro-image') || normalized.includes('pro-image')) {
      candidates.add('gemini-3-pro-image');
    }
    if (normalized.includes('flash')) {
      candidates.add('gemini-flash');
      candidates.add('gemini-3-flash');
    }
    if (normalized.includes('pro') && !normalized.includes('image')) {
      candidates.add('gemini-pro');
      candidates.add('gemini-3-pro-high');
    }
    if (
      normalized.includes('claude') ||
      normalized.includes('sonnet') ||
      normalized.includes('opus') ||
      normalized.includes('haiku')
    ) {
      candidates.add('claude');
    }
    return candidates;
  }

  private async readProtectedModelsFromTokenFile(tokenFile: string): Promise<Set<string>> {
    const out = new Set<string>();
    try {
      const raw = await fsAsync.readFile(tokenFile, 'utf8');
      const parsed = JSON.parse(String(raw || '').trim() || 'null') as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return out;
      }
      const nodes: Array<Record<string, unknown>> = [parsed];
      if (parsed.token && typeof parsed.token === 'object' && !Array.isArray(parsed.token)) {
        nodes.push(parsed.token as Record<string, unknown>);
      }
      for (const node of nodes) {
        const rawModels =
          Array.isArray(node.protected_models)
            ? node.protected_models
            : Array.isArray(node.protectedModels)
              ? node.protectedModels
              : [];
        for (const item of rawModels) {
          if (typeof item !== 'string') {
            continue;
          }
          for (const normalized of this.normalizeProtectedModelFlag(item)) {
            out.add(normalized);
          }
        }
      }
      return out;
    } catch {
      return out;
    }
  }

  private isAntigravityModelProtected(alias: string, modelId: string): boolean {
    const protectedModels = this.antigravityProtectedModels.get(alias);
    if (!protectedModels || protectedModels.size === 0) {
      return false;
    }
    const candidates = this.resolveProtectedModelCandidates(modelId);
    for (const candidate of candidates) {
      if (protectedModels.has(candidate)) {
        return true;
      }
    }
    return false;
  }

  private isAntigravityProviderProtected(providerKey: string): boolean {
    const parsed = this.parseAntigravityProviderKey(providerKey);
    if (!parsed) {
      return false;
    }
    return this.isAntigravityModelProtected(parsed.alias, parsed.modelId);
  }

  private reconcileProtectedStateForProviderKey(providerKey: string): void {
    const mgr = this.coreQuotaManager as
      | {
          updateProviderPoolState?: (options: {
            providerKey: string;
            inPool: boolean;
            reason?: string | null;
            cooldownUntil?: number | null;
            blacklistUntil?: number | null;
          }) => void;
          getQuotaView?: () => (providerKey: string) => unknown;
        }
      | null;
    if (!mgr || typeof mgr.updateProviderPoolState !== 'function') {
      return;
    }
    const parsed = this.parseAntigravityProviderKey(providerKey);
    if (!parsed) {
      return;
    }
    if (this.isAntigravityModelProtected(parsed.alias, parsed.modelId)) {
      mgr.updateProviderPoolState({
        providerKey,
        inPool: false,
        reason: ANTIGRAVITY_PROTECTED_REASON,
        cooldownUntil: null,
        blacklistUntil: null
      });
      return;
    }

    let currentReason = '';
    try {
      const viewFn = typeof mgr.getQuotaView === 'function' ? mgr.getQuotaView() : null;
      const current = typeof viewFn === 'function' ? (viewFn(providerKey) as { reason?: unknown } | null) : null;
      currentReason = typeof current?.reason === 'string' ? current.reason.trim().toLowerCase() : '';
    } catch {
      currentReason = '';
    }
    if (currentReason !== ANTIGRAVITY_PROTECTED_REASON) {
      return;
    }
    const snapshotKey = this.buildAntigravityKey(parsed.alias, parsed.modelId);
    const record = this.snapshot[snapshotKey];
    if (record) {
      this.applyAntigravityQuotaToCore(providerKey, record, Date.now());
      return;
    }
    mgr.updateProviderPoolState({
      providerKey,
      inPool: false,
      reason: 'quotaDepleted',
      cooldownUntil: null,
      blacklistUntil: null
    });
  }

  private reconcileProtectedStatesForRegisteredProviders(): void {
    const keys = new Set<string>(this.registeredProviderKeys);
    const snapshot = this.getAdminSnapshot();
    for (const providerKey of Object.keys(snapshot)) {
      keys.add(providerKey);
    }
    for (const key of keys) {
      this.reconcileProtectedStateForProviderKey(key);
    }
  }

  private extractAntigravityAlias(providerKey?: string): string | null {
    if (!providerKey || typeof providerKey !== 'string') {
      return null;
    }
    const trimmed = providerKey.trim();
    if (!trimmed.toLowerCase().startsWith('antigravity.')) {
      return null;
    }
    const segments = trimmed.split('.');
    if (segments.length < 2) {
      return null;
    }
    return segments[1];
  }

  private computeResetAt(raw?: string): number | undefined {
    if (!raw || typeof raw !== 'string' || !raw.trim()) {
      return undefined;
    }
    const value = raw.trim();
    try {
      const normalized = value.endsWith('Z') ? value.replace(/Z$/, '+00:00') : value;
      const parsed = Date.parse(normalized);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async refreshAllAntigravityQuotas(): Promise<{ attempted: number; successCount: number; failureCount: number }> {
    await this.syncAntigravityTokensFromDisk();
    if (this.antigravityTokens.size === 0) {
      return { attempted: 0, successCount: 0, failureCount: 0 };
    }
    let attempted = 0;
    let successCount = 0;
    let failureCount = 0;
    for (const { alias, tokenFile, apiBase } of this.antigravityTokens.values()) {
      try {
        const accessToken = await loadAntigravityAccessToken(tokenFile);
        if (!accessToken) {
          continue;
        }
        attempted += 1;
        const snapshot = await fetchAntigravityQuotaSnapshot(apiBase, accessToken, { alias });
        if (!snapshot) {
          failureCount += 1;
          continue;
        }
        this.updateAntigravityQuota(alias, snapshot);
        successCount += 1;
      } catch {
        failureCount += 1;
        // 单个 alias 失败不影响其他 alias 的刷新
      }
    }
    return { attempted, successCount, failureCount };
  }

  private applyAntigravityQuotaToCore(providerKey: string, record: QuotaRecord, nowMs: number): void {
    const mgr = this.coreQuotaManager;
    if (!mgr || typeof (mgr as any).updateProviderPoolState !== 'function') {
      return;
    }
    if (this.isAntigravityProviderProtected(providerKey)) {
      (mgr as any).updateProviderPoolState({
        providerKey,
        inPool: false,
        reason: ANTIGRAVITY_PROTECTED_REASON,
        cooldownUntil: null,
        blacklistUntil: null
      });
      return;
    }
    const remaining = record.remainingFraction;
    const resetAt = typeof record.resetAt === 'number' && Number.isFinite(record.resetAt) ? record.resetAt : null;
    const withinResetWindow = typeof resetAt === 'number' && resetAt > nowMs;
    const hasQuota = typeof remaining === 'number' && Number.isFinite(remaining) && remaining > 0 && (resetAt === null || withinResetWindow);
    if (hasQuota) {
      (mgr as any).updateProviderPoolState({ providerKey, inPool: true, reason: 'ok', cooldownUntil: null, blacklistUntil: null });
      return;
    }
    (mgr as any).updateProviderPoolState({
      providerKey,
      inPool: false,
      reason: 'quotaDepleted',
      cooldownUntil: null,
      blacklistUntil: null
    });
  }

  private handleSessionUnbindForQuotaPersistenceIssue(reason: string): void {
    const issue = typeof reason === 'string' ? reason.trim() : '';
    if (!issue) {
      return;
    }
    if (this.quotaStoreLastUnbindReason === issue) {
      return;
    }
    this.quotaStoreLastUnbindReason = issue;
    let clearedBySession = 0;
    let clearedByAlias = 0;
    try {
      const out = llmsBridge.clearAntigravitySessionAliasPins?.({ hydrate: true });
      clearedBySession =
        typeof out?.clearedBySession === 'number' && Number.isFinite(out.clearedBySession)
          ? Math.max(0, Math.floor(out.clearedBySession))
          : 0;
      clearedByAlias =
        typeof out?.clearedByAlias === 'number' && Number.isFinite(out.clearedByAlias)
          ? Math.max(0, Math.floor(out.clearedByAlias))
          : 0;
    } catch {
      // best-effort only
    }
    const quotaPath = this.quotaStorePath || '(unknown)';
    console.warn(
      `[quota] persistence issue (${issue}); cleared antigravity session bindings for safety ` +
      `(sessionPins=${clearedBySession}, aliasPins=${clearedByAlias}, store=${quotaPath})`
    );
  }

  private createQuotaStore(): { load: () => Promise<QuotaStoreSnapshot | null>; save: (snapshot: QuotaStoreSnapshot) => Promise<void> } {
    const dir = this.resolveQuotaManagerDir();
    const filePath = path.join(dir, 'quota-manager.json');
    this.quotaStorePath = filePath;
    return {
      load: async () => {
        let primaryLoadFailed = false;
        let primaryExists = false;
        try {
          primaryExists = fs.existsSync(filePath);
        } catch {
          primaryExists = false;
        }
        // Preferred: new snapshot.
        try {
          const raw = await fsAsync.readFile(filePath, 'utf8');
          const parsed = JSON.parse(String(raw || '').trim() || 'null') as QuotaStoreSnapshot | null;
          if (parsed && typeof parsed === 'object' && parsed.providers && typeof parsed.providers === 'object') {
            this.quotaStorePersistenceStatus = 'loaded';
            this.quotaStoreLastUnbindReason = null;
            return parsed;
          }
        } catch {
          primaryLoadFailed = primaryExists;
        }
        // Fallback: migrate from legacy provider-quota snapshot if present.
        try {
          const legacy = await loadProviderQuotaSnapshot();
          if (legacy && legacy.providers && typeof legacy.providers === 'object') {
            const nowMs = Date.now();
            this.quotaStorePersistenceStatus = 'loaded';
            this.quotaStoreLastUnbindReason = null;
            return {
              savedAtMs: Number.isFinite(Date.parse(legacy.updatedAt)) ? Date.parse(legacy.updatedAt) : nowMs,
              providers: legacy.providers as any
            };
          }
        } catch {
          // ignore
        }
        this.quotaStorePersistenceStatus = primaryLoadFailed ? 'load_error' : 'missing';
        return null;
      },
      save: async (snapshot: QuotaStoreSnapshot) => {
        try {
          await fsAsync.mkdir(dir, { recursive: true });
        } catch {
          // ignore
        }
        const tmp = `${filePath}.tmp`;
        const text = `${JSON.stringify(snapshot, null, 2)}\n`;
        try {
          await fsAsync.writeFile(tmp, text, 'utf8');
          await fsAsync.rename(tmp, filePath);
          this.quotaStorePersistenceStatus = 'loaded';
          this.quotaStoreLastUnbindReason = null;
        } catch {
          this.quotaStorePersistenceStatus = 'save_error';
          this.handleSessionUnbindForQuotaPersistenceIssue('quota_store_save_error');
          try { await fsAsync.unlink(tmp); } catch { /* ignore */ }
        }
      }
    };
  }

  private resolveQuotaManagerDir(): string {
    const base = path.join(this.resolveHomeDir(), '.routecodex', 'quota');
    try {
      fs.mkdirSync(base, { recursive: true });
    } catch {
      // ignore
    }
    return base;
  }

  private async subscribeToProviderCenters(): Promise<void> {
    const mgr = this.coreQuotaManager;
    if (!mgr) {
      return;
    }
    let errorCenter: { subscribe?: (handler: (ev: ProviderErrorEvent) => void) => () => void } | null = null;
    try {
      errorCenter = (await llmsBridge.getProviderErrorCenter()) as any;
    } catch {
      errorCenter = null;
    }
    if (errorCenter && typeof errorCenter.subscribe === 'function' && typeof mgr.onProviderError === 'function') {
      try {
        this.providerErrorUnsub = errorCenter.subscribe((ev: ProviderErrorEvent) => {
          try { mgr.onProviderError?.(ev); } catch { /* ignore */ }
        });
      } catch {
        this.providerErrorUnsub = null;
      }
    }

    let successCenter: { subscribe?: (handler: (ev: ProviderSuccessEvent) => void) => () => void } | null = null;
    try {
      successCenter = (await llmsBridge.getProviderSuccessCenter()) as any;
    } catch {
      successCenter = null;
    }
    if (successCenter && typeof successCenter.subscribe === 'function' && typeof mgr.onProviderSuccess === 'function') {
      try {
        this.providerSuccessUnsub = successCenter.subscribe((ev: ProviderSuccessEvent) => {
          try { mgr.onProviderSuccess?.(ev); } catch { /* ignore */ }
        });
      } catch {
        this.providerSuccessUnsub = null;
      }
    }
  }

  /**
   * 每 5 分钟刷新一次 quota（固定间隔）。
   * 启动时会立即刷新一次，随后由该定时器维持周期刷新。
   */
  private async scheduleNextRefresh(): Promise<void> {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.refreshDisabled) {
      return;
    }
    const baseIntervalMs = 5 * 60 * 1000;
    const delayMs = baseIntervalMs;
    this.refreshTimer = setTimeout(() => {
      void this.refreshAllAntigravityQuotas()
        .then((result) => {
          if (result.attempted > 0 && result.successCount === 0) {
            this.refreshFailures += 1;
            if (this.refreshFailures >= 3) {
              this.refreshDisabled = true;
            }
          } else if (result.successCount > 0) {
            this.refreshFailures = 0;
          }
        })
        .catch(() => {
          this.refreshFailures += 1;
          if (this.refreshFailures >= 3) {
            this.refreshDisabled = true;
          }
        })
        .finally(() => {
          if (!this.refreshDisabled) {
            void this.scheduleNextRefresh().catch(() => {
              // ignore reschedule failure
            });
          }
        });
    }, delayMs);
    this.refreshTimer.unref?.();
  }

  /**
   * 自动从本地 auth 目录扫描 antigravity OAuth token，并同步到内存注册表。
   * 这确保「每个 token」都能定期刷新 quota，而不依赖额外的显式注册流程。
   */
  private async syncAntigravityTokensFromDisk(): Promise<void> {
    let matches: Array<{ filePath: string; sequence: number; alias: string }> = [];
    try {
      matches = await scanProviderTokenFiles('antigravity');
    } catch {
      matches = [];
    }
    if (!matches.length) {
      this.antigravityTokens.clear();
      this.antigravityProtectedModels.clear();
      // No token files -> no valid aliases -> drop any persisted snapshot rows.
      if (this.snapshot && Object.keys(this.snapshot).length) {
        this.snapshot = {};
        void this.saveSnapshotToDisk().catch(() => {
      // best-effort; ignore persistence errors
    });
      }
      this.reconcileProtectedStatesForRegisteredProviders();
      return;
    }

    const base = resolveAntigravityApiBase();
    const next = new Map<string, AntigravityTokenRegistration>();
    const nextProtectedModels = new Map<string, Set<string>>();
    const legacyAliases: string[] = [];
    for (const match of matches) {
      // IMPORTANT: alias must match providerKey alias used by VirtualRouter/provider registry:
      // providerKey is `antigravity.<alias>.<modelId>`, where `<alias>` comes from user config entries.
      // Do not prefix with sequence number here, otherwise QUOTA_* events will target keys that routing never uses.
      const alias = (match.alias && match.alias !== 'default' ? match.alias : String(match.sequence)).trim();
      if (!alias) {
        continue;
      }
      const legacyAlias =
        match.alias && match.alias !== 'default' ? `${match.sequence}-${match.alias}`.trim() : null;
      if (legacyAlias) {
        legacyAliases.push(legacyAlias);
      }
      next.set(alias, {
        alias,
        tokenFile: match.filePath,
        apiBase: base
      });
      const protectedModels = await this.readProtectedModelsFromTokenFile(match.filePath);
      if (protectedModels.size > 0) {
        nextProtectedModels.set(alias, protectedModels);
      }
    }

    // 若已有显式注册的 alias，保留其覆盖权
    for (const [alias, reg] of this.antigravityTokens.entries()) {
      if (!next.has(alias)) {
        next.set(alias, reg);
      }
    }

    this.antigravityTokens = next;
    this.antigravityProtectedModels = nextProtectedModels;

    // Cleanup legacy snapshot keys created by older builds (sequence-prefixed alias like "1-foo").
    // Those keys never match VirtualRouter providerKey aliases and only cause duplicate/stale rows in admin views.
    if (legacyAliases.length && this.snapshot && typeof this.snapshot === 'object') {
      const legacyPrefixes = legacyAliases.map((a) => `antigravity://${a}/`);
      const rawEntries = Object.entries(this.snapshot);
      let changed = false;
      const cleaned: Record<string, QuotaRecord> = {};
      for (const [key, value] of rawEntries) {
        const drop = legacyPrefixes.some((prefix) => key.startsWith(prefix));
        if (drop) {
          changed = true;
          continue;
        }
        cleaned[key] = value;
      }
      if (changed) {
        this.snapshot = cleaned;
        void this.saveSnapshotToDisk().catch(() => {
      // best-effort; ignore persistence errors
    });
      }
    }

    // Cleanup stale snapshot keys for aliases that no longer exist on disk.
    // This prevents “phantom aliases” (e.g. a1) from showing up in admin UI when the token file is gone.
    if (this.snapshot && typeof this.snapshot === 'object') {
      const allowedAliases = new Set<string>(Array.from(this.antigravityTokens.keys()));
      const rawEntries = Object.entries(this.snapshot);
      let changed = false;
      const cleaned: Record<string, QuotaRecord> = {};
      for (const [key, value] of rawEntries) {
        const parsed = this.parseAntigravitySnapshotKey(key);
        if (parsed && !allowedAliases.has(parsed.alias)) {
          changed = true;
          continue;
        }
        cleaned[key] = value;
      }
      if (changed) {
        this.snapshot = cleaned;
        void this.saveSnapshotToDisk().catch(() => {
      // best-effort; ignore persistence errors
    });
      }
    }

    this.reconcileProtectedStatesForRegisteredProviders();
  }

  private resolveStatePath(): string {
    const baseDir = path.join(this.resolveHomeDir(), '.routecodex', 'state', 'quota');
    try {
      fs.mkdirSync(baseDir, { recursive: true });
    } catch {
      // best effort
    }
    return path.join(baseDir, 'antigravity.json');
  }

  private loadSnapshotFromDisk(): Record<string, QuotaRecord> {
    const filePath = this.resolveStatePath();
    try {
      if (!fs.existsSync(filePath)) {
        return {};
      }
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = content.trim() ? JSON.parse(content) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
      }
      const raw = parsed as Record<string, QuotaRecord>;
      const result: Record<string, QuotaRecord> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (!value || typeof value !== 'object') {
          continue;
        }
        let remainingFraction: number | null = null;
        if (typeof (value as { remainingFraction?: unknown }).remainingFraction === 'number') {
          remainingFraction = (value as { remainingFraction?: number }).remainingFraction ?? null;
        }
        let resetAt: number | undefined;
        if (typeof (value as { resetAt?: unknown }).resetAt === 'number') {
          resetAt = (value as { resetAt?: number }).resetAt;
        }
        const fetchedAt =
          typeof (value as { fetchedAt?: unknown }).fetchedAt === 'number'
            ? (value as { fetchedAt?: number }).fetchedAt!
            : Date.now();
        result[key] = { remainingFraction, resetAt, fetchedAt };
      }
      return result;
    } catch {
      return {};
    }
  }

  private async saveSnapshotToDisk(): Promise<void> {
    const filePath = this.resolveStatePath();
    try {
      await fsAsync.writeFile(filePath, `${JSON.stringify(this.snapshot, null, 2)}\n`, 'utf8');
    } catch {
      // best effort
    }
  }
}
