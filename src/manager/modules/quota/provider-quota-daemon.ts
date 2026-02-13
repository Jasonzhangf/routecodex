import type { ManagerContext, ManagerModule } from '../../types.js';
import { getProviderErrorCenter } from '../../../modules/llmswitch/bridge.js';
import type { ProviderErrorEvent } from '../../../modules/llmswitch/bridge.js';
import {
  applySuccessEvent as applyQuotaSuccessEvent,
  applyUsageEvent as applyQuotaUsageEvent,
  createInitialQuotaState,
  tickQuotaStateTime,
  type QuotaState,
  type StaticQuotaConfig,
  type QuotaAuthType
} from '../../quota/provider-quota-center.js';
import { saveProviderQuotaSnapshot } from '../../quota/provider-quota-store.js';
import { canonicalizeProviderKey } from './provider-key-normalization.js';
import { handleProviderQuotaErrorEvent } from './provider-quota-daemon.events.js';
import { loadProviderQuotaStates } from './provider-quota-daemon.snapshot.js';
import { buildQuotaViewEntry } from './provider-quota-daemon.view.js';
import { ProviderModelBackoffTracker } from './provider-quota-daemon.model-backoff.js';

const ERROR_PRIORITY_WINDOW_MS = readPositiveNumberFromEnv('ROUTECODEX_QUOTA_ERROR_PRIORITY_WINDOW_MS', 10 * 60_000);

export class ProviderQuotaDaemonModule implements ManagerModule {
  readonly id = 'provider-quota';

  private quotaStates: Map<string, QuotaState> = new Map();
  private staticConfigs: Map<string, StaticQuotaConfig> = new Map();
  private readonly modelBackoff: ProviderModelBackoffTracker = new ProviderModelBackoffTracker();
  private unsubscribe: (() => void) | null = null;
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private quotaRoutingEnabled = true;

  private async loadSnapshotIntoMemory(): Promise<void> {
    const { quotaStates, seeded, needsPersist } = await loadProviderQuotaStates({
      staticConfigs: this.staticConfigs
    });
    this.quotaStates = quotaStates;

    const nowMs = Date.now();
    if (seeded || needsPersist) {
      this.schedulePersist(nowMs);
    }
  }

  async init(context: ManagerContext): Promise<void> {
    this.quotaRoutingEnabled = context.quotaRoutingEnabled !== false;

    try {
      await this.loadSnapshotIntoMemory();
    } catch {
      this.quotaStates = new Map();
    }
  }

  async reloadFromDisk(): Promise<{ loadedAt: number; providerCount: number }> {
    await this.loadSnapshotIntoMemory();
    return { loadedAt: Date.now(), providerCount: this.quotaStates.size };
  }

  async reset(options: { persist?: boolean } = {}): Promise<{ resetAt: number; persisted: boolean }> {
    const nowMs = Date.now();

    this.quotaStates = new Map();
    this.modelBackoff.clearAll();

    if (this.staticConfigs.size) {
      for (const [providerKey, cfg] of this.staticConfigs.entries()) {
        this.quotaStates.set(providerKey, createInitialQuotaState(providerKey, cfg, nowMs));
      }
    }

    const persisted = options.persist !== false;
    if (persisted) {
      try {
        await saveProviderQuotaSnapshot(this.toSnapshotObject(), new Date(nowMs));
      } catch {
        // ignore persistence failure
      }
    }
    return { resetAt: nowMs, persisted };
  }

  async resetProvider(providerKey: string): Promise<{ providerKey: string; state: QuotaState } | null> {
    const raw = typeof providerKey === 'string' ? providerKey.trim() : '';
    const key = raw ? canonicalizeProviderKey(raw) : '';
    if (!key) {
      return null;
    }
    const nowMs = Date.now();
    const next = createInitialQuotaState(key, this.staticConfigs.get(key), nowMs);
    this.modelBackoff.recordSuccess(key);
    this.quotaStates.set(key, next);
    try {
      await saveProviderQuotaSnapshot(this.toSnapshotObject(), new Date(nowMs));
    } catch {
      // ignore persistence failure
    }
    return { providerKey: key, state: next };
  }

  async recoverProvider(providerKey: string): Promise<{ providerKey: string; state: QuotaState } | null> {
    const raw = typeof providerKey === 'string' ? providerKey.trim() : '';
    const key = raw ? canonicalizeProviderKey(raw) : '';
    if (!key) {
      return null;
    }
    const nowMs = Date.now();
    const previous =
      this.quotaStates.get(key) ?? createInitialQuotaState(key, this.staticConfigs.get(key), nowMs);
    const next: QuotaState = {
      ...previous,
      inPool: true,
      reason: 'ok',
      authIssue: null,
      cooldownUntil: null,
      blacklistUntil: null,
      lastErrorSeries: null,
      lastErrorCode: null,
      lastErrorAtMs: null,
      consecutiveErrorCount: 0
    };
    this.modelBackoff.recordSuccess(key);
    this.quotaStates.set(key, next);
    try {
      await saveProviderQuotaSnapshot(this.toSnapshotObject(), new Date(nowMs));
    } catch {
      // ignore persistence failure
    }
    return { providerKey: key, state: next };
  }

  async disableProvider(options: {
    providerKey: string;
    mode: 'cooldown' | 'blacklist';
    durationMs: number;
  }): Promise<{ providerKey: string; state: QuotaState } | null> {
    const raw = typeof options?.providerKey === 'string' ? options.providerKey.trim() : '';
    const key = raw ? canonicalizeProviderKey(raw) : '';
    if (!key) {
      return null;
    }
    const durationMs =
      typeof options.durationMs === 'number' && Number.isFinite(options.durationMs) && options.durationMs > 0
        ? Math.floor(options.durationMs)
        : 0;
    if (!durationMs) {
      return null;
    }
    const mode = options.mode === 'blacklist' ? 'blacklist' : 'cooldown';
    const nowMs = Date.now();
    const previous =
      this.quotaStates.get(key) ?? createInitialQuotaState(key, this.staticConfigs.get(key), nowMs);
    const next: QuotaState =
      mode === 'blacklist'
        ? {
            ...previous,
            inPool: false,
            reason: 'blacklist',
            blacklistUntil: nowMs + durationMs,
            cooldownUntil: null
          }
        : {
            ...previous,
            inPool: false,
            reason: 'cooldown',
            cooldownUntil: nowMs + durationMs
          };
    this.quotaStates.set(key, next);
    try {
      await saveProviderQuotaSnapshot(this.toSnapshotObject(), new Date(nowMs));
    } catch {
      // ignore persistence failure
    }
    return { providerKey: key, state: next };
  }

  getAdminSnapshot(): Record<string, QuotaState> {
    return this.toSnapshotObject();
  }

  async start(): Promise<void> {
    if (!this.quotaRoutingEnabled) {
      return;
    }

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
        void this.handleProviderErrorEvent(event).catch(() => {
          // swallow handler errors; quota updates are best-effort
        });
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
    if (!this.quotaRoutingEnabled) {
      return;
    }
    try {
      await saveProviderQuotaSnapshot(this.toSnapshotObject(), new Date());
    } catch {
      // best-effort persistence
    }
  }

  recordProviderUsage(event: { providerKey: string; requestedTokens?: number | null; timestampMs?: number }): void {
    if (!this.quotaRoutingEnabled) {
      return;
    }
    const rawKey = typeof event?.providerKey === 'string' ? event.providerKey.trim() : '';
    const providerKey = rawKey ? canonicalizeProviderKey(rawKey) : '';
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
    if (!this.quotaRoutingEnabled) {
      return;
    }
    const rawKey = typeof event?.providerKey === 'string' ? event.providerKey.trim() : '';
    const providerKey = rawKey ? canonicalizeProviderKey(rawKey) : '';
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
    this.modelBackoff.recordSuccess(providerKey);
    this.schedulePersist(nowMs);
  }

  registerProviderStaticConfig(
    providerKey: string,
    config: { authType?: string | null; priorityTier?: number | null; apikeyDailyResetTime?: string | null } = {}
  ): void {
    if (!this.quotaRoutingEnabled) {
      return;
    }

    const raw = typeof providerKey === 'string' ? providerKey.trim() : '';
    const key = raw ? canonicalizeProviderKey(raw) : '';
    if (!key) {
      return;
    }

    const authTypeRaw = typeof config.authType === 'string' ? config.authType.trim().toLowerCase() : '';
    const authType: QuotaAuthType = authTypeRaw === 'apikey' ? 'apikey' : authTypeRaw === 'oauth' ? 'oauth' : 'unknown';
    const apikeyDailyResetTime =
      typeof config.apikeyDailyResetTime === 'string' && config.apikeyDailyResetTime.trim().length
        ? config.apikeyDailyResetTime.trim()
        : null;
    const staticConfig: StaticQuotaConfig = {
      ...(typeof config.priorityTier === 'number' && Number.isFinite(config.priorityTier)
        ? { priorityTier: config.priorityTier }
        : {}),
      authType,
      ...(apikeyDailyResetTime ? { apikeyDailyResetTime } : {})
    };

    this.staticConfigs.set(key, staticConfig);

    const nowMs = Date.now();
    const existing = this.quotaStates.get(key);
    if (existing) {
      const merged: QuotaState = {
        ...existing,
        ...(staticConfig.authType ? { authType: staticConfig.authType } : {}),
        ...(typeof staticConfig.priorityTier === 'number' ? { priorityTier: staticConfig.priorityTier } : {})
      };
      this.quotaStates.set(key, merged);
      this.schedulePersist(nowMs);
      return;
    }

    const initialBase = createInitialQuotaState(key, staticConfig, nowMs);
    const shouldGateAntigravityOauth =
      authType === 'oauth' && key.toLowerCase().startsWith('antigravity.');
    const initial: QuotaState = shouldGateAntigravityOauth
      ? {
          ...initialBase,
          // Antigravity OAuth providers must remain out of pool until quota recovery arrives.
          // This avoids selecting accounts that are not yet verified as usable.
          inPool: false,
          reason: 'cooldown'
        }
      : initialBase;
    this.quotaStates.set(key, initial);

    this.schedulePersist(nowMs);
  }

  private async handleProviderErrorEvent(event: ProviderErrorEvent): Promise<void> {
    await handleProviderQuotaErrorEvent(
      {
        quotaStates: this.quotaStates,
        staticConfigs: this.staticConfigs,
        quotaRoutingEnabled: this.quotaRoutingEnabled,
        modelBackoff: this.modelBackoff,
        schedulePersist: (nowMs: number) => this.schedulePersist(nowMs),
        toSnapshotObject: () => this.toSnapshotObject()
      },
      event
    );
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

  getQuotaView(): (providerKey: string) => {
    providerKey: string;
    inPool: boolean;
    reason?: string;
    priorityTier?: number;
    cooldownUntil?: number | null;
    blacklistUntil?: number | null;
  } | null {
    if (!this.quotaRoutingEnabled) {
      return () => null;
    }

    return (providerKey: string) => {
      const raw = typeof providerKey === 'string' ? providerKey.trim() : '';
      const key = raw ? canonicalizeProviderKey(raw) : '';
      if (!key) {
        return null;
      }
      const state = this.quotaStates.get(key);
      if (!state) {
        return null;
      }

      const nowMs = Date.now();
      const normalized = tickQuotaStateTime(state, nowMs);
      if (normalized !== state) {
        this.quotaStates.set(key, normalized);
        this.schedulePersist(nowMs);
      }
      return buildQuotaViewEntry({
        state: normalized,
        nowMs,
        modelBackoff: this.modelBackoff,
        errorPriorityWindowMs: ERROR_PRIORITY_WINDOW_MS
      });
    };
  }

  getQuotaViewReadOnly(): (providerKey: string) => {
    providerKey: string;
    inPool: boolean;
    reason?: string;
    priorityTier?: number;
    cooldownUntil?: number | null;
    blacklistUntil?: number | null;
  } | null {
    if (!this.quotaRoutingEnabled) {
      return () => null;
    }

    return (providerKey: string) => {
      const raw = typeof providerKey === 'string' ? providerKey.trim() : '';
      const key = raw ? canonicalizeProviderKey(raw) : '';
      if (!key) {
        return null;
      }
      const state = this.quotaStates.get(key);
      if (!state) {
        return null;
      }
      const nowMs = Date.now();
      const effective = tickQuotaStateTime(state, nowMs);
      return buildQuotaViewEntry({
        state: effective,
        nowMs,
        modelBackoff: this.modelBackoff,
        errorPriorityWindowMs: ERROR_PRIORITY_WINDOW_MS
      });
    };
  }
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
