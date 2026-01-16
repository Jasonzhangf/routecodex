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
import type { ProviderErrorEvent } from '@jsonstudio/llms/dist/router/virtual-router/types.js';
import { getProviderErrorCenter } from '../../../modules/llmswitch/bridge.js';
import { readTokenFile, evaluateTokenState } from '../../../token-daemon/token-utils.js';
import {
  applyErrorEvent as applyQuotaErrorEvent,
  applySuccessEvent as applyQuotaSuccessEvent,
  applyUsageEvent as applyQuotaUsageEvent,
  createInitialQuotaState,
  tickQuotaStateTime,
  type ErrorEventForQuota,
  type QuotaState,
  type StaticQuotaConfig,
  type QuotaAuthType
} from '../../quota/provider-quota-center.js';
import {
  appendProviderErrorEvent,
  loadProviderQuotaSnapshot,
  saveProviderQuotaSnapshot
} from '../../quota/provider-quota-store.js';

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
  private providerErrorCenter:
    | {
        emit(event: ProviderErrorEvent): void;
      }
    | null = null;

  async init(context: ManagerContext): Promise<void> {
    this.snapshot = this.loadSnapshotFromDisk();
  }

  async start(): Promise<void> {
    // 启动时立即做一次最佳努力刷新，然后根据 token 过期时间和 15 分钟基准动态调度后续刷新。
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
    if (!aliasId) return;
    const now = Date.now();
    const next: Record<string, QuotaRecord> = { ...this.snapshot };
    for (const [modelId, info] of Object.entries(quota.models)) {
      const key = this.buildAntigravityKey(aliasId, modelId);
      const record: QuotaRecord = {
        remainingFraction: Number.isFinite(info.remainingFraction) ? info.remainingFraction : null,
        fetchedAt: quota.fetchedAt
      };
      const resetAt = this.computeResetAt(info.resetTimeRaw);
      if (resetAt && resetAt > now) {
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
   * 根据当前 token 池的过期时间和固定 15 分钟基准，动态安排下一次 quota 刷新：
   * - 如有 token 会在 15 分钟内到期，则在该 token 到期时间附近刷新；
   * - 否则按固定 15 分钟间隔刷新。
   */
  private async scheduleNextRefresh(): Promise<void> {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    const baseIntervalMs = 15 * 60 * 1000;
    let delayMs = baseIntervalMs;
    try {
      const nextExpiryDelay = await this.computeNextTokenExpiryDelayMs();
      if (nextExpiryDelay !== null && nextExpiryDelay > 0 && nextExpiryDelay < baseIntervalMs) {
        delayMs = nextExpiryDelay;
      }
    } catch {
      // 如果计算失败，退回到固定 15 分钟间隔
      delayMs = baseIntervalMs;
    }
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
  }

  /**
   * 扫描 antigravity token 文件，计算距离最近一次 token 过期还剩多少毫秒。
   * 若所有 token 都无过期时间或已过期，则返回 null。
   */
  private async computeNextTokenExpiryDelayMs(): Promise<number | null> {
    let matches: Array<{ filePath: string }> = [];
    try {
      const raw = await scanProviderTokenFiles('antigravity');
      matches = raw.map((m) => ({ filePath: m.filePath }));
    } catch {
      matches = [];
    }
    if (!matches.length) {
      return null;
    }
    const now = Date.now();
    let minDelay: number | null = null;
    for (const match of matches) {
      try {
        const token = await readTokenFile(match.filePath);
        const state = evaluateTokenState(token, now);
        const msLeft = state.msUntilExpiry;
        if (msLeft === null || msLeft <= 0) {
          continue;
        }
        if (minDelay === null || msLeft < minDelay) {
          minDelay = msLeft;
        }
      } catch {
        // ignore single token file errors
      }
    }
    return minDelay;
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
    for (const match of matches) {
      const label =
        match.alias && match.alias !== 'default'
          ? `${match.sequence}-${match.alias}`
          : String(match.sequence);
      const alias = label.trim();
      if (!alias) {
        continue;
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

export class ProviderQuotaDaemonModule implements ManagerModule {
  readonly id = 'provider-quota';

  private quotaStates: Map<string, QuotaState> = new Map();
  private staticConfigs: Map<string, StaticQuotaConfig> = new Map();
  private unsubscribe: (() => void) | null = null;
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;

  async init(_context: ManagerContext): Promise<void> {
    try {
      const snapshot = await loadProviderQuotaSnapshot();
      if (snapshot && snapshot.providers && typeof snapshot.providers === 'object') {
        for (const [providerKey, state] of Object.entries(snapshot.providers)) {
          if (state && typeof state === 'object') {
            this.quotaStates.set(providerKey, normalizeLoadedQuotaState(providerKey, state as QuotaState));
          }
        }
      }
      if (this.quotaStates.size) {
        const nowMs = Date.now();
        let changed = false;
        for (const [providerKey, state] of this.quotaStates.entries()) {
          const next = tickQuotaStateTime(state, nowMs);
          if (next !== state) {
            this.quotaStates.set(providerKey, next);
            changed = true;
          }
        }
        if (changed) {
          this.schedulePersist(nowMs);
        }
      }
    } catch {
      this.quotaStates = new Map();
    }
  }

  async start(): Promise<void> {
    let center:
      | { subscribe?: (handler: (event: ProviderErrorEvent) => void) => () => void }
      | null
      | undefined = null;
    try {
      center = await getProviderErrorCenter();
    } catch {
      center = null;
    }
    if (center && typeof center.subscribe === 'function') {
      this.unsubscribe = center.subscribe((event: ProviderErrorEvent) => {
        void this.handleProviderErrorEvent(event);
      });
    }

    const intervalMs = readPositiveNumberFromEnv('ROUTECODEX_QUOTA_DAEMON_INTERVAL_MS', 60_000);
    if (intervalMs > 0) {
      this.maintenanceTimer = setInterval(() => {
        void this.runMaintenanceTick().catch(() => {
          // ignore maintenance failures
        });
      }, intervalMs);
    }
    // Run a one-off maintenance tick immediately so expired cooldown/blacklist entries
    // are cleared even before the first request hits quotaView.
    void this.runMaintenanceTick().catch(() => {
      // ignore immediate tick failures
    });
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) {
      try {
        this.unsubscribe();
      } catch {
        // ignore unsubscribe failures
      }
      this.unsubscribe = null;
    }
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      await saveProviderQuotaSnapshot(this.toSnapshotObject(), new Date());
    } catch {
      // best-effort persistence
    }
  }

  recordProviderUsage(event: { providerKey: string; requestedTokens?: number | null; timestampMs?: number }): void {
    const providerKey = typeof event?.providerKey === 'string' ? event.providerKey.trim() : '';
    if (!providerKey) {
      return;
    }
    const nowMs =
      typeof event.timestampMs === 'number' && Number.isFinite(event.timestampMs) && event.timestampMs > 0
        ? event.timestampMs
        : Date.now();
    const requestedTokens =
      typeof event.requestedTokens === 'number' && Number.isFinite(event.requestedTokens) && event.requestedTokens > 0
        ? event.requestedTokens
        : 0;

    const previous =
      this.quotaStates.get(providerKey) ??
      createInitialQuotaState(providerKey, this.staticConfigs.get(providerKey), nowMs);
    const nextState = applyQuotaUsageEvent(previous, { providerKey, requestedTokens, timestampMs: nowMs }, nowMs);
    this.quotaStates.set(providerKey, nextState);
    this.schedulePersist(nowMs);
  }

  recordProviderSuccess(event: { providerKey: string; usedTokens?: number | null; timestampMs?: number }): void {
    const providerKey = typeof event?.providerKey === 'string' ? event.providerKey.trim() : '';
    if (!providerKey) {
      return;
    }
    const nowMs =
      typeof event.timestampMs === 'number' && Number.isFinite(event.timestampMs) && event.timestampMs > 0
        ? event.timestampMs
        : Date.now();
    const usedTokens =
      typeof event.usedTokens === 'number' && Number.isFinite(event.usedTokens) && event.usedTokens > 0
        ? event.usedTokens
        : 0;

    const previous =
      this.quotaStates.get(providerKey) ??
      createInitialQuotaState(providerKey, this.staticConfigs.get(providerKey), nowMs);
    const nextState = applyQuotaSuccessEvent(previous, { providerKey, usedTokens, timestampMs: nowMs }, nowMs);
    this.quotaStates.set(providerKey, nextState);
    this.schedulePersist(nowMs);
  }

  registerProviderStaticConfig(providerKey: string, config: { authType?: string | null; priorityTier?: number | null } = {}): void {
    const key = typeof providerKey === 'string' ? providerKey.trim() : '';
    if (!key) {
      return;
    }
    const authTypeRaw = typeof config.authType === 'string' ? config.authType.trim().toLowerCase() : '';
    const authType: QuotaAuthType =
      authTypeRaw === 'apikey' ? 'apikey' : authTypeRaw === 'oauth' ? 'oauth' : 'unknown';
    const staticConfig: StaticQuotaConfig = {
      ...(typeof config.priorityTier === 'number' && Number.isFinite(config.priorityTier)
        ? { priorityTier: config.priorityTier }
        : {}),
      authType
    };
    this.staticConfigs.set(key, staticConfig);
    const existing = this.quotaStates.get(key);
    if (existing) {
      this.quotaStates.set(key, {
        ...existing,
        authType,
        ...(typeof staticConfig.priorityTier === 'number' ? { priorityTier: staticConfig.priorityTier } : {})
      });
    }
  }

  private async handleProviderErrorEvent(event: ProviderErrorEvent): Promise<void> {
    if (!event) {
      return;
    }
    const code = typeof event.code === 'string' ? event.code : '';

    const providerKey = this.extractProviderKey(event);
    if (!providerKey) {
      return;
    }

    const nowMs =
      typeof event.timestamp === 'number' && Number.isFinite(event.timestamp) && event.timestamp > 0
        ? event.timestamp
        : Date.now();

    const previous =
      this.quotaStates.get(providerKey) ??
      createInitialQuotaState(providerKey, this.staticConfigs.get(providerKey), nowMs);

    // QUOTA_* 属于“确定性配额信号”，不进入错误 series 统计。
    if (code === 'QUOTA_DEPLETED') {
      const detailCarrier = (event.details && typeof event.details === 'object') ? (event.details as Record<string, unknown>) : {};
      const raw = detailCarrier.virtualRouterQuotaDepleted;
      const cooldownMs =
        raw && typeof raw === 'object' && typeof (raw as { cooldownMs?: unknown }).cooldownMs === 'number'
          ? ((raw as { cooldownMs?: number }).cooldownMs as number)
          : undefined;
      const ttl =
        typeof cooldownMs === 'number' && Number.isFinite(cooldownMs) && cooldownMs > 0
          ? cooldownMs
          : undefined;
      const nextState: QuotaState = {
        ...previous,
        inPool: false,
        reason: 'quotaDepleted',
        cooldownUntil: ttl ? nowMs + ttl : previous.cooldownUntil
      };
      this.quotaStates.set(providerKey, nextState);
      this.schedulePersist(nowMs);
      return;
    }
    if (code === 'QUOTA_RECOVERY') {
      const withinBlacklist =
        previous.blacklistUntil !== null && nowMs < previous.blacklistUntil;
      const withinFatalBlacklist =
        previous.reason === 'fatal' && previous.blacklistUntil !== null && nowMs < previous.blacklistUntil;
      if (!withinBlacklist && !withinFatalBlacklist) {
        const nextState: QuotaState = {
          ...previous,
          inPool: true,
          reason: 'ok',
          cooldownUntil: null
        };
        this.quotaStates.set(providerKey, nextState);
        this.schedulePersist(nowMs);
      }
      return;
    }

    // Gemini-family quota exhausted errors often carry quota reset delay.
    // When present, treat as deterministic quota depletion signal rather than generic 429 backoff/blacklist.
    if (typeof event.status === 'number' && event.status === 429) {
      const runtime = event.runtime as { providerId?: unknown; providerProtocol?: unknown } | undefined;
      const providerIdRaw = runtime && typeof runtime.providerId === 'string' ? runtime.providerId.trim().toLowerCase() : '';
      const isQuotaProvider = providerIdRaw === 'antigravity' || providerIdRaw === 'gemini-cli';
      if (isQuotaProvider) {
        const ttl = parseQuotaResetDelayMs(event);
        if (ttl && ttl > 0) {
          const nextState: QuotaState = {
            ...previous,
            inPool: false,
            reason: 'quotaDepleted',
            cooldownUntil: nowMs + ttl,
            blacklistUntil: null,
            lastErrorSeries: null,
            consecutiveErrorCount: 0
          };
          this.quotaStates.set(providerKey, nextState);
          this.schedulePersist(nowMs);
          return;
        }
      }
    }

    const errorForQuota: ErrorEventForQuota = {
      providerKey,
      httpStatus: typeof event.status === 'number' ? event.status : undefined,
      code: typeof event.code === 'string' ? event.code : undefined,
      fatal: this.isFatalForQuota(event),
      timestampMs: nowMs
    };

    const nextState = applyQuotaErrorEvent(previous, errorForQuota, nowMs);
    this.quotaStates.set(providerKey, nextState);

    const tsIso = new Date(nowMs).toISOString();
    try {
      await appendProviderErrorEvent({
        ts: tsIso,
        providerKey,
        code: typeof errorForQuota.code === 'string' ? errorForQuota.code : undefined,
        httpStatus: typeof errorForQuota.httpStatus === 'number' ? errorForQuota.httpStatus : undefined,
        message: event.message,
        details: {
          stage: event.stage,
          routeName: (event.runtime as { routeName?: string }).routeName,
          entryEndpoint: (event.runtime as { entryEndpoint?: string }).entryEndpoint
        }
      });
    } catch {
      // logging failure is non-fatal
    }

    try {
      await saveProviderQuotaSnapshot(this.toSnapshotObject(), new Date(nowMs));
    } catch {
      // best-effort persistence only
    }
  }

  private async runMaintenanceTick(): Promise<void> {
    if (!this.quotaStates.size) {
      return;
    }
    const nowMs = Date.now();
    const updated = new Map<string, QuotaState>();
    for (const [providerKey, state] of this.quotaStates.entries()) {
      const next = tickQuotaStateTime(state, nowMs);
      updated.set(providerKey, next);
    }
    this.quotaStates = updated;
    try {
      await saveProviderQuotaSnapshot(this.toSnapshotObject(), new Date(nowMs));
    } catch {
      // ignore persistence errors
    }
  }

  private schedulePersist(_nowMs: number): void {
    if (this.persistTimer) {
      return;
    }
    const debounceMs = readPositiveNumberFromEnv('ROUTECODEX_QUOTA_PERSIST_DEBOUNCE_MS', 5_000);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void saveProviderQuotaSnapshot(this.toSnapshotObject(), new Date()).catch(() => {
        // ignore persistence errors
      });
    }, debounceMs);
  }

  private toSnapshotObject(): Record<string, QuotaState> {
    const result: Record<string, QuotaState> = {};
    for (const [key, state] of this.quotaStates.entries()) {
      result[key] = state;
    }
    return result;
  }

  private extractProviderKey(event: ProviderErrorEvent): string | null {
    const runtime = event.runtime as { providerKey?: unknown; target?: unknown } | undefined;
    const direct =
      runtime && typeof runtime.providerKey === 'string' && runtime.providerKey.trim()
        ? runtime.providerKey.trim()
        : null;
    if (direct) {
      return direct;
    }
    const target = runtime && runtime.target;
    if (target && typeof target === 'object') {
      const targetKey = (target as { providerKey?: unknown }).providerKey;
      if (typeof targetKey === 'string' && targetKey.trim()) {
        return targetKey.trim();
      }
    }
    return null;
  }

  getQuotaView(): (providerKey: string) => {
    providerKey: string;
    inPool: boolean;
    reason?: string;
    priorityTier?: number;
    cooldownUntil?: number | null;
    blacklistUntil?: number | null;
  } | null {
    return (providerKey: string) => {
      const key = typeof providerKey === 'string' ? providerKey.trim() : '';
      if (!key) {
        return null;
      }
      const state = this.quotaStates.get(key);
      if (!state) {
        return null;
      }
      // 视图层做一次“即时修复”，确保即使 maintenance tick 未运行，
      // 冷却/黑名单到期也能立刻恢复可用状态，避免路由长期卡死。
      const nowMs = Date.now();
      const normalized = tickQuotaStateTime(state, nowMs);
      if (normalized !== state) {
        this.quotaStates.set(key, normalized);
        this.schedulePersist(nowMs);
      }
      const effective = normalized;
      return {
        providerKey: effective.providerKey,
        inPool: effective.inPool,
        reason: effective.reason,
        priorityTier: effective.priorityTier,
        cooldownUntil: effective.cooldownUntil ?? null,
        blacklistUntil: effective.blacklistUntil ?? null
      };
    };
  }

  private isFatalForQuota(event: ProviderErrorEvent): boolean {
    const status = typeof event.status === 'number' ? event.status : undefined;
    const code = typeof event.code === 'string' ? event.code.toUpperCase() : '';
    const stage = typeof event.stage === 'string' ? event.stage.toLowerCase() : '';

    if (status === 401 || status === 402 || status === 403) {
      return true;
    }
    if (code.includes('AUTH') || code.includes('UNAUTHORIZED')) {
      return true;
    }
    if (code.includes('CONFIG')) {
      return true;
    }
    if (stage.includes('compat')) {
      return true;
    }
    if (event.recoverable === false && status !== undefined && status >= 500) {
      return true;
    }
    return false;
  }
}

function parseQuotaResetDelayMs(event: ProviderErrorEvent): number | null {
  const message = typeof event.message === 'string' ? event.message : '';
  const raw = message.toLowerCase();

  // Common shape: "reset after 3h22m41s" (Gemini quota exhausted)
  const afterMatch = raw.match(/reset after\s+([0-9a-z\.\s]+)\.?/i);
  if (afterMatch && afterMatch[1]) {
    const parsed = parseDurationToMs(afterMatch[1]);
    if (parsed && parsed > 0) {
      return parsed;
    }
  }

  // Sometimes the upstream JSON is embedded; try extracting quotaResetDelay.
  const embeddedDelayMatch = raw.match(/quotaresetdelay\"\s*:\s*\"([^\"]+)\"/i);
  if (embeddedDelayMatch && embeddedDelayMatch[1]) {
    const parsed = parseDurationToMs(embeddedDelayMatch[1]);
    if (parsed && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function parseDurationToMs(value?: string): number | null {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/gi;
  let totalMs = 0;
  let matched = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    matched = true;
    const amount = Number.parseFloat(match[1]);
    if (!Number.isFinite(amount)) {
      continue;
    }
    const unit = match[2].toLowerCase();
    if (unit === 'ms') {
      totalMs += amount;
    } else if (unit === 'h') {
      totalMs += amount * 3_600_000;
    } else if (unit === 'm') {
      totalMs += amount * 60_000;
    } else if (unit === 's') {
      totalMs += amount * 1_000;
    }
  }
  if (!matched) {
    return null;
  }
  if (totalMs <= 0) {
    return null;
  }
  return Math.round(totalMs);
}

function normalizeLoadedQuotaState(providerKey: string, state: QuotaState): QuotaState {
  const key = typeof providerKey === 'string' && providerKey.trim() ? providerKey.trim() : state.providerKey;
  const rawAuth = typeof (state as unknown as { authType?: unknown }).authType === 'string'
    ? String((state as unknown as { authType?: string }).authType).trim().toLowerCase()
    : '';
  const authType: QuotaAuthType = rawAuth === 'apikey' ? 'apikey' : rawAuth === 'oauth' ? 'oauth' : 'unknown';
  return {
    ...state,
    providerKey: key,
    authType
  };
}

function readPositiveNumberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}
