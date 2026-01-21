import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

import type { ManagerContext, ManagerModule } from '../../types.js';
import {
  fetchAntigravityQuotaSnapshot,
  loadAntigravityAccessToken,
  type AntigravityQuotaSnapshot
} from '../../../providers/core/runtime/antigravity-quota-client.js';
import { scanProviderTokenFiles } from '../../../providers/auth/token-scanner/index.js';
import { resolveAntigravityApiBase } from '../../../providers/auth/antigravity-userinfo-helper.js';
import { getProviderErrorCenter } from '../../../modules/llmswitch/bridge.js';
import type { ProviderErrorEvent } from '../../../modules/llmswitch/bridge.js';

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

export class QuotaManagerModule implements ManagerModule {
  readonly id = 'quota';

  private snapshot: Record<string, QuotaRecord> = {};
  private antigravityTokens: Map<string, AntigravityTokenRegistration> = new Map();
  private refreshTimer: NodeJS.Timeout | null = null;
  private quotaRoutingEnabled = true;
  private providerErrorCenter:
    | {
        emit(event: ProviderErrorEvent): void;
      }
    | null = null;

  async init(context: ManagerContext): Promise<void> {
    this.snapshot = this.loadSnapshotFromDisk();
    this.quotaRoutingEnabled = context.quotaRoutingEnabled !== false;
  }

  async start(): Promise<void> {
    // 启动时立即做一次最佳努力刷新，然后根据 token 过期时间和 5 分钟基准动态调度后续刷新。
    try {
      await this.refreshAllAntigravityQuotas();
    } catch {
      // ignore startup refresh failures
    }
    void this.scheduleNextRefresh().catch(() => {
      // ignore scheduling failures
    });
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.saveSnapshotToDisk();
  }

  /**
   * Admin operation: force-refresh quota snapshots immediately (best-effort).
   * Exposed via daemon-admin endpoint `/quota/refresh`.
   */
  async refreshNow(): Promise<{ refreshedAt: number; tokenCount: number; recordCount: number }> {
    const refreshedAt = Date.now();
    try {
      await this.refreshAllAntigravityQuotas();
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
      if (record.remainingFraction !== null && record.remainingFraction > 0) {
        void this.emitQuotaRecoveryEvent(providerKey, modelId);
      } else {
        const cooldownHint = record.resetAt ? Math.max(0, record.resetAt - now) : undefined;
        void this.emitQuotaDepletedEvent(providerKey, modelId, cooldownHint);
      }
    }
    this.snapshot = next;
    this.saveSnapshotToDisk();
  }

  /**
   * 判断给定 providerKey+model 是否有可用配额（仅针对 antigravity 语义）。
   */
  hasQuotaForAntigravity(providerKey: string, modelId?: string): boolean {
    const alias = this.extractAntigravityAlias(providerKey);
    if (!alias || !modelId) {
      return true;
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

  private buildAntigravityKey(alias: string, modelId: string): string {
    return `antigravity://${alias}/${modelId}`;
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

  private async refreshAllAntigravityQuotas(): Promise<void> {
    await this.syncAntigravityTokensFromDisk();
    if (this.antigravityTokens.size === 0) {
      return;
    }
    for (const { alias, tokenFile, apiBase } of this.antigravityTokens.values()) {
      try {
        const accessToken = await loadAntigravityAccessToken(tokenFile);
        if (!accessToken) {
          continue;
        }
        const snapshot = await fetchAntigravityQuotaSnapshot(apiBase, accessToken);
        if (!snapshot) {
          continue;
        }
        this.updateAntigravityQuota(alias, snapshot);
      } catch {
        // 单个 alias 失败不影响其他 alias 的刷新
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
    const baseIntervalMs = 5 * 60 * 1000;
    const delayMs = baseIntervalMs;
    this.refreshTimer = setTimeout(() => {
      void this.refreshAllAntigravityQuotas()
        .catch(() => {
          // ignore refresh failure
        })
        .finally(() => {
          void this.scheduleNextRefresh().catch(() => {
            // ignore reschedule failure
          });
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
      return;
    }

    const base = resolveAntigravityApiBase();
    const next = new Map<string, AntigravityTokenRegistration>();
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
    }

    // 若已有显式注册的 alias，保留其覆盖权
    for (const [alias, reg] of this.antigravityTokens.entries()) {
      if (!next.has(alias)) {
        next.set(alias, reg);
      }
    }

    this.antigravityTokens = next;

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
        this.saveSnapshotToDisk();
      }
    }
  }

  private resolveStatePath(): string {
    const baseDir = path.join(homedir(), '.routecodex', 'state', 'quota');
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

  private saveSnapshotToDisk(): void {
    const filePath = this.resolveStatePath();
    try {
      fs.writeFileSync(filePath, `${JSON.stringify(this.snapshot, null, 2)}\n`, 'utf8');
    } catch {
      // best effort
    }
  }

  private async getProviderErrorCenterInstance(): Promise<QuotaManagerModule['providerErrorCenter']> {
    if (this.providerErrorCenter) {
      return this.providerErrorCenter;
    }
    try {
      const center = await getProviderErrorCenter();
      if (center && typeof center.emit === 'function') {
        this.providerErrorCenter = center as { emit(event: ProviderErrorEvent): void };
      } else {
        this.providerErrorCenter = null;
      }
    } catch {
      this.providerErrorCenter = null;
    }
    return this.providerErrorCenter;
  }

  private async emitQuotaRecoveryEvent(providerKey: string, modelId: string): Promise<void> {
    if (!providerKey || !modelId) {
      return;
    }
    if (!this.quotaRoutingEnabled) {
      return;
    }
    const center = await this.getProviderErrorCenterInstance();
    if (!center) {
      return;
    }
    const now = Date.now();
    const event: ProviderErrorEvent = {
      code: 'QUOTA_RECOVERY',
      message: 'Quota manager: provider quota refreshed',
      stage: 'quota',
      status: 200,
      recoverable: true,
      runtime: {
        requestId: `quota_${now}`,
        providerKey,
        providerId: 'antigravity'
      },
      timestamp: now,
      details: {
        virtualRouterQuotaRecovery: {
          providerKey,
          reason: `quota>0 for model ${modelId}`,
          source: 'quota-manager'
        }
      }
    };
    try {
      center.emit(event);
    } catch {
      // 忽略 error center 失败，避免影响配额刷新流程
    }
  }

  private async emitQuotaDepletedEvent(
    providerKey: string,
    modelId: string,
    cooldownMs?: number
  ): Promise<void> {
    if (!providerKey || !modelId) {
      return;
    }
    if (!this.quotaRoutingEnabled) {
      return;
    }
    const center = await this.getProviderErrorCenterInstance();
    if (!center) {
      return;
    }
    const now = Date.now();
    const detail: Record<string, unknown> = {
      virtualRouterQuotaDepleted: {
        providerKey,
        reason: `quota<=0 for model ${modelId}`,
        ...(typeof cooldownMs === 'number' && cooldownMs > 0 ? { cooldownMs } : {})
      }
    };
    const event: ProviderErrorEvent = {
      code: 'QUOTA_DEPLETED',
      message: 'Quota manager: provider quota exhausted',
      stage: 'quota',
      status: 429,
      recoverable: false,
      runtime: {
        requestId: `quota_${now}`,
        providerKey,
        providerId: 'antigravity'
      },
      timestamp: now,
      details: detail
    };
    try {
      center.emit(event);
    } catch {
      // ignore emit errors
    }
  }
}

