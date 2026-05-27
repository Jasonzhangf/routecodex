import type { ManagerContext, ManagerModule } from '../../types.js';
import type {
  ProviderErrorEvent,
  ProviderSuccessEvent,
  QuotaAuthType,
  QuotaState,
  QuotaStore,
  QuotaStoreSnapshot,
  StaticQuotaConfig
} from '../../../types/llmswitch-local-types.js';
import { createCoreQuotaManager, setProviderRuntimeQuotaHooks } from '../../../modules/llmswitch/bridge.js';
import { x7eGate } from '../../../server/runtime/http-server/daemon-admin/routecodex-x7e-gate.js';
import { ProviderQuotaDaemonModule } from './provider-quota-daemon.js';
import type { QuotaManagerAdapter, QuotaViewEntry } from './quota-adapter.js';
import { loadProviderQuotaSnapshot, saveProviderQuotaSnapshot } from '../../quota/provider-quota-store.js';

export interface QuotaRecord {
  remainingFraction: number | null;
  resetAt?: number;
  fetchedAt: number;
}

type RoutingProviderScope = {
  providerKeys?: string[];
  providerIds?: string[];
  oauthProviderKeys?: string[];
  oauthProviderIds?: string[];
};

type CoreQuotaManagerLike = {
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
  getSnapshot?: () => { updatedAtMs: number; providers: Record<string, QuotaState> };
  persistNow?: () => Promise<void>;
};

type RustQuotaHostSnapshotEntry = {
  providerKey?: unknown;
  inPool?: unknown;
  reason?: unknown;
  authType?: unknown;
  authIssue?: unknown;
  priorityTier?: unknown;
  cooldownUntil?: unknown;
  cooldownKeepsPool?: unknown;
  blacklistUntil?: unknown;
  lastErrorSeries?: unknown;
  lastErrorCode?: unknown;
  lastErrorAtMs?: unknown;
  consecutiveErrorCount?: unknown;
};

type RustQuotaHydrationMutator = {
  getStatus?(): { quotaHostSnapshot?: unknown } | null;
  resetProviderQuota?(providerKey: string): unknown;
  recoverProviderQuota?(providerKey: string): unknown;
  disableProviderQuota?(providerKey: string, mode: 'cooldown' | 'blacklist', durationMs: number): unknown;
  applyKeepPoolCooldownQuota?(providerKey: string, cooldownUntilMs: number, lastErrorCode?: string): unknown;
  handleProviderError?(event: ProviderErrorEvent): unknown;
  handleProviderSuccess?(event: ProviderSuccessEvent): unknown;
};

class ProviderQuotaStoreAdapter implements QuotaStore {
  async load(): Promise<QuotaStoreSnapshot | null> {
    const snapshot = await loadProviderQuotaSnapshot();
    if (!snapshot || !snapshot.providers || typeof snapshot.providers !== 'object') {
      return null;
    }
    const savedAtMs = Date.parse(snapshot.updatedAt);
    return {
      savedAtMs: Number.isFinite(savedAtMs) ? savedAtMs : Date.now(),
      providers: snapshot.providers
    };
  }

  async save(snapshot: QuotaStoreSnapshot): Promise<void> {
    await saveProviderQuotaSnapshot(
      snapshot.providers as unknown as Record<string, import('../../quota/provider-quota-center.js').QuotaState>,
      new Date(snapshot.savedAtMs || Date.now())
    );
  }
}

function normalizeSelectionPenalty(state: QuotaState, nowMs: number): number {
  if (
    typeof state.lastErrorAtMs !== 'number' ||
    !Number.isFinite(state.lastErrorAtMs) ||
    nowMs - state.lastErrorAtMs < 0 ||
    nowMs - state.lastErrorAtMs > 30_000
  ) {
    return 0;
  }
  if (typeof state.consecutiveErrorCount !== 'number' || !Number.isFinite(state.consecutiveErrorCount)) {
    return 0;
  }
  return Math.max(0, Math.floor(state.consecutiveErrorCount));
}

function buildReadOnlyQuotaViewFromCore(
  core: CoreQuotaManagerLike | null
): ((providerKey: string) => QuotaViewEntry | null) | null {
  if (!core || typeof core.getSnapshot !== 'function') {
    return null;
  }
  return (providerKey: string): QuotaViewEntry | null => {
    const key = typeof providerKey === 'string' ? providerKey.trim() : '';
    if (!key) {
      return null;
    }
    const snapshot = core.getSnapshot?.();
    const state = snapshot?.providers?.[key];
    if (!state) {
      return null;
    }
    const nowMs = Date.now();
    return {
      providerKey: key,
      inPool: Boolean(state.inPool),
      reason: state.reason,
      priorityTier: state.priorityTier,
      selectionPenalty: normalizeSelectionPenalty(state, nowMs),
      lastErrorAtMs: state.lastErrorAtMs,
      consecutiveErrorCount: state.consecutiveErrorCount,
      cooldownUntil: state.cooldownUntil,
      blacklistUntil: state.blacklistUntil
    };
  };
}

function getRustQuotaHostMutatorFromContext(context: ManagerContext | null | undefined): RustQuotaHydrationMutator | null {
  const hubPipeline = typeof context?.getHubPipeline === 'function' ? context.getHubPipeline() : null;
  if (!hubPipeline || typeof hubPipeline !== 'object') {
    return null;
  }
  const getVirtualRouter = (hubPipeline as { getVirtualRouter?: () => unknown | null }).getVirtualRouter;
  if (typeof getVirtualRouter !== 'function') {
    return null;
  }
  const virtualRouter = getVirtualRouter();
  if (!virtualRouter || typeof virtualRouter !== 'object') {
    return null;
  }
  return virtualRouter as RustQuotaHydrationMutator;
}

function normalizeRustQuotaState(entry: RustQuotaHostSnapshotEntry): QuotaState | null {
  const providerKey = typeof entry.providerKey === 'string' ? entry.providerKey.trim() : '';
  if (!providerKey) {
    return null;
  }
  const reasonRaw = typeof entry.reason === 'string' ? entry.reason.trim() : 'ok';
  const reason =
    reasonRaw === 'ok' || reasonRaw === 'cooldown' || reasonRaw === 'blacklist' || reasonRaw === 'quotaDepleted' || reasonRaw === 'fatal' || reasonRaw === 'authVerify'
      ? reasonRaw
      : 'ok';
  const authTypeRaw = typeof entry.authType === 'string' ? entry.authType.trim() : 'unknown';
  const authType = authTypeRaw === 'apikey' || authTypeRaw === 'oauth' || authTypeRaw === 'unknown' ? authTypeRaw : 'unknown';
  return {
    providerKey,
    inPool: Boolean(entry.inPool),
    reason,
    authType,
    authIssue: (entry.authIssue as QuotaState['authIssue']) ?? null,
    priorityTier: typeof entry.priorityTier === 'number' ? entry.priorityTier : 100,
    cooldownUntil: typeof entry.cooldownUntil === 'number' ? entry.cooldownUntil : null,
    cooldownKeepsPool: entry.cooldownKeepsPool === true ? true : undefined,
    blacklistUntil: typeof entry.blacklistUntil === 'number' ? entry.blacklistUntil : null,
    lastErrorSeries: typeof entry.lastErrorSeries === 'string' ? (entry.lastErrorSeries as QuotaState['lastErrorSeries']) : null,
    lastErrorCode: typeof entry.lastErrorCode === 'string' ? entry.lastErrorCode : null,
    lastErrorAtMs: typeof entry.lastErrorAtMs === 'number' ? entry.lastErrorAtMs : null,
    consecutiveErrorCount: typeof entry.consecutiveErrorCount === 'number' ? entry.consecutiveErrorCount : 0
  };
}

function readRustQuotaHostSnapshotMap(context: ManagerContext | null | undefined): Record<string, QuotaState> | null {
  const rustMutator = getRustQuotaHostMutatorFromContext(context);
  if (!rustMutator || typeof rustMutator.getStatus !== 'function') {
    return null;
  }
  const status = rustMutator.getStatus();
  const snapshot = Array.isArray(status?.quotaHostSnapshot) ? status?.quotaHostSnapshot : null;
  if (!snapshot || snapshot.length === 0) {
    return null;
  }
  const providers: Record<string, QuotaState> = {};
  for (const entry of snapshot) {
    const normalized = normalizeRustQuotaState(entry as RustQuotaHostSnapshotEntry);
    if (!normalized) {
      continue;
    }
    providers[normalized.providerKey] = normalized;
  }
  return Object.keys(providers).length > 0 ? providers : null;
}

async function hydrateRustQuotaHostSnapshotFromStore(
  context: ManagerContext | null | undefined,
  store: ProviderQuotaStoreAdapter
): Promise<boolean> {
  const rustMutator = getRustQuotaHostMutatorFromContext(context);
  if (!rustMutator) {
    return false;
  }
  const snapshot = await store.load();
  if (!snapshot?.providers || typeof snapshot.providers !== 'object') {
    return true;
  }
  const nowMs = Date.now();
  for (const rawState of Object.values(snapshot.providers)) {
    const state = rawState as QuotaState | null;
    const providerKey = typeof state?.providerKey === 'string' ? state.providerKey.trim() : '';
    if (!providerKey) {
      continue;
    }
    if (state?.reason === 'blacklist') {
      const until = typeof state.blacklistUntil === 'number' ? state.blacklistUntil : nowMs + 60_000;
      const durationMs = Math.max(1, until - nowMs);
      await Promise.resolve(rustMutator.disableProviderQuota?.(providerKey, 'blacklist', durationMs));
      continue;
    }
    if (state?.reason === 'cooldown' || state?.reason === 'quotaDepleted' || (typeof state?.cooldownUntil === 'number' && state.cooldownUntil > nowMs)) {
      const until = typeof state.cooldownUntil === 'number' ? state.cooldownUntil : nowMs + 60_000;
      if (state?.reason === 'cooldown' && state.cooldownKeepsPool === true && until > nowMs) {
        await Promise.resolve(rustMutator.applyKeepPoolCooldownQuota?.(providerKey, until, state.lastErrorCode ?? undefined));
        continue;
      }
      const durationMs = Math.max(1, until - nowMs);
      await Promise.resolve(rustMutator.disableProviderQuota?.(providerKey, 'cooldown', durationMs));
      continue;
    }
    await Promise.resolve(rustMutator.resetProviderQuota?.(providerKey));
  }
  return true;
}

async function persistRustQuotaHostSnapshotToStore(
  context: ManagerContext | null | undefined,
  store: ProviderQuotaStoreAdapter
): Promise<boolean> {
  const rustMutator = getRustQuotaHostMutatorFromContext(context);
  if (!rustMutator || typeof rustMutator.getStatus !== 'function') {
    return false;
  }
  const status = rustMutator.getStatus();
  const snapshot = Array.isArray(status?.quotaHostSnapshot) ? status?.quotaHostSnapshot : [];
  const providers: Record<string, QuotaState> = {};
  for (const entry of snapshot) {
    const normalized = normalizeRustQuotaState(entry as RustQuotaHostSnapshotEntry);
    if (!normalized) {
      continue;
    }
    providers[normalized.providerKey] = normalized;
  }
  await store.save({
    savedAtMs: Date.now(),
    providers
  });
  return true;
}

export class QuotaManagerModule implements ManagerModule {
  readonly id = 'quota';

  private readonly legacyDelegate = new ProviderQuotaDaemonModule();
  private coreManager: CoreQuotaManagerLike | null = null;
  private useCore = false;
  private context: ManagerContext | null = null;
  private readonly providerQuotaStore = new ProviderQuotaStoreAdapter();
  private readonly providerRuntimeHookOwner = Symbol('quota-manager-module');
  private hooksRegistered = false;

  async init(context: ManagerContext): Promise<void> {
    this.context = context;
    this.useCore = x7eGate.phase1UnifiedQuota;
    if (this.useCore) {
      const store = this.providerQuotaStore;
      const core = (await createCoreQuotaManager({ store })) as CoreQuotaManagerLike | null;
      this.coreManager = core;
      const hydratedByRust = await hydrateRustQuotaHostSnapshotFromStore(this.context, store).catch(() => false);
      if (!hydratedByRust) {
        await this.coreManager?.hydrateFromStore?.();
      }
      return;
    }
    await this.legacyDelegate.init(context);
  }

  async start(): Promise<void> {
    if (this.useCore) {
      try {
        const runtimeHooks = {
          onProviderError: (event: ProviderErrorEvent) => {
            const rustMutator = getRustQuotaHostMutatorFromContext(this.context);
            if (typeof rustMutator?.handleProviderError === 'function') {
              rustMutator.handleProviderError(event);
              return;
            }
            this.coreManager?.onProviderError?.(event);
          },
          onProviderSuccess: (event: ProviderSuccessEvent) => {
            const rustMutator = getRustQuotaHostMutatorFromContext(this.context);
            if (typeof rustMutator?.handleProviderSuccess === 'function') {
              rustMutator.handleProviderSuccess(event);
              return;
            }
            this.coreManager?.onProviderSuccess?.(event);
          }
        };
        this.hooksRegistered = await setProviderRuntimeQuotaHooks(this.providerRuntimeHookOwner, runtimeHooks);
      } catch {
        this.hooksRegistered = false;
      }
      return;
    }
    await this.legacyDelegate.start();
  }

  async stop(): Promise<void> {
    if (this.useCore) {
      if (this.hooksRegistered) {
        try {
          await setProviderRuntimeQuotaHooks(this.providerRuntimeHookOwner, undefined);
        } catch {
          // best-effort
        }
        this.hooksRegistered = false;
      }
      const persistedByRust = await persistRustQuotaHostSnapshotToStore(this.context, this.providerQuotaStore).catch(() => false);
      if (!persistedByRust) {
        await this.coreManager?.persistNow?.();
      }
      return;
    }
    await this.legacyDelegate.stop();
  }

  async updateRoutingScope(_scope?: RoutingProviderScope): Promise<void> {
    return;
  }

  async refreshNow(): Promise<{ refreshedAt: number; tokenCount: number; recordCount: number }> {
    if (this.useCore) {
      const snapshot = this.coreManager?.getSnapshot?.();
      return {
        refreshedAt: Date.now(),
        tokenCount: 0,
        recordCount: Object.keys(snapshot?.providers ?? {}).length
      };
    }
    const snapshot = this.legacyDelegate.getAdminSnapshot();
    return {
      refreshedAt: Date.now(),
      tokenCount: 0,
      recordCount: Object.keys(snapshot).length
    };
  }

  getRawSnapshot(): Record<string, QuotaRecord> {
    return {};
  }

  getCoreQuotaManager(): CoreQuotaManagerLike | null {
    return this.useCore ? this.coreManager : null;
  }

  registerProviderStaticConfig(
    providerKey: string,
    config: { authType?: string | null; priorityTier?: number | null; apikeyDailyResetTime?: string | null } = {}
  ): void {
    const normalizedConfig: StaticQuotaConfig = {
      ...(typeof config.priorityTier === 'number' ? { priorityTier: config.priorityTier } : {}),
      ...(typeof config.apikeyDailyResetTime === 'string' ? { apikeyDailyResetTime: config.apikeyDailyResetTime } : {}),
      ...(config.authType === 'apikey' || config.authType === 'oauth' || config.authType === 'unknown'
        ? { authType: config.authType as QuotaAuthType }
        : {})
    };
    if (this.useCore) {
      this.coreManager?.registerProviderStaticConfig?.(providerKey, normalizedConfig);
      return;
    }
    this.legacyDelegate.registerProviderStaticConfig(providerKey, normalizedConfig);
  }

  getQuotaView():
    | ReturnType<ProviderQuotaDaemonModule['getQuotaView']>
    | ((providerKey: string) => QuotaViewEntry | null) {
    if (this.useCore) {
      return this.getQuotaViewReadOnly();
    }
    return this.legacyDelegate.getQuotaView();
  }

  getQuotaViewReadOnly():
    | ReturnType<ProviderQuotaDaemonModule['getQuotaViewReadOnly']>
    | ((providerKey: string) => QuotaViewEntry | null) {
    if (this.useCore) {
      const rustSnapshot = readRustQuotaHostSnapshotMap(this.context);
      if (rustSnapshot) {
        return (providerKey: string): QuotaViewEntry | null => {
          const key = typeof providerKey === 'string' ? providerKey.trim() : '';
          if (!key) {
            return null;
          }
          const state = rustSnapshot[key];
          if (!state) {
            return null;
          }
          const nowMs = Date.now();
          return {
            providerKey: key,
            inPool: Boolean(state.inPool),
            reason: state.reason,
            priorityTier: state.priorityTier,
            selectionPenalty: normalizeSelectionPenalty(state, nowMs),
            lastErrorAtMs: state.lastErrorAtMs,
            consecutiveErrorCount: state.consecutiveErrorCount,
            cooldownUntil: state.cooldownUntil,
            blacklistUntil: state.blacklistUntil,
            authIssue: state.authIssue,
            authType: state.authType
          };
        };
      }
      return buildReadOnlyQuotaViewFromCore(this.coreManager) ?? (() => null);
    }
    return this.legacyDelegate.getQuotaViewReadOnly();
  }

  getAdminSnapshot(): Record<string, QuotaState> {
    if (this.useCore) {
      const rustSnapshot = readRustQuotaHostSnapshotMap(this.context);
      if (rustSnapshot) {
        return rustSnapshot;
      }
      return this.coreManager?.getSnapshot?.()?.providers ?? {};
    }
    return this.legacyDelegate.getAdminSnapshot();
  }

  async persistNow(): Promise<void> {
    if (this.useCore) {
      const persistedByRust = await persistRustQuotaHostSnapshotToStore(this.context, this.providerQuotaStore).catch(() => false);
      if (!persistedByRust) {
        await this.coreManager?.persistNow?.();
      }
      return;
    }
  }

  async resetProvider(providerKey: string): Promise<{ providerKey: string; state: unknown } | null> {
    if (this.useCore) {
      const rustMutator = getRustQuotaHostMutatorFromContext(this.context);
      if (typeof rustMutator?.resetProviderQuota === 'function') {
        await Promise.resolve(rustMutator.resetProviderQuota(providerKey));
        const rustSnapshot = readRustQuotaHostSnapshotMap(this.context);
        const state = rustSnapshot?.[providerKey] ?? null;
        return state ? { providerKey, state } : { providerKey, state: null };
      }
      this.coreManager?.resetProvider?.(providerKey);
      const state = this.coreManager?.getSnapshot?.()?.providers?.[providerKey] ?? null;
      await this.coreManager?.persistNow?.();
      return state ? { providerKey, state } : null;
    }
    return await this.legacyDelegate.resetProvider(providerKey);
  }

  async recoverProvider(providerKey: string): Promise<{ providerKey: string; state: unknown } | null> {
    if (this.useCore) {
      const rustMutator = getRustQuotaHostMutatorFromContext(this.context);
      if (typeof rustMutator?.recoverProviderQuota === 'function') {
        await Promise.resolve(rustMutator.recoverProviderQuota(providerKey));
        const rustSnapshot = readRustQuotaHostSnapshotMap(this.context);
        const state = rustSnapshot?.[providerKey] ?? null;
        return state ? { providerKey, state } : { providerKey, state: null };
      }
      this.coreManager?.recoverProvider?.(providerKey);
      const state = this.coreManager?.getSnapshot?.()?.providers?.[providerKey] ?? null;
      await this.coreManager?.persistNow?.();
      return state ? { providerKey, state } : null;
    }
    return await this.legacyDelegate.recoverProvider(providerKey);
  }

  async disableProvider(options: {
    providerKey: string;
    mode: 'cooldown' | 'blacklist';
    durationMs: number;
  }): Promise<{ providerKey: string; state: unknown } | null> {
    if (this.useCore) {
      const rustMutator = getRustQuotaHostMutatorFromContext(this.context);
      if (typeof rustMutator?.disableProviderQuota === 'function') {
        await Promise.resolve(rustMutator.disableProviderQuota(options.providerKey, options.mode, options.durationMs));
        const rustSnapshot = readRustQuotaHostSnapshotMap(this.context);
        const state = rustSnapshot?.[options.providerKey] ?? null;
        return state ? { providerKey: options.providerKey, state } : { providerKey: options.providerKey, state: null };
      }
      this.coreManager?.disableProvider?.({
        providerKey: options.providerKey,
        mode: options.mode,
        durationMs: options.durationMs,
        reason: options.mode === 'blacklist' ? 'operator' : 'auto'
      });
      const state = this.coreManager?.getSnapshot?.()?.providers?.[options.providerKey] ?? null;
      await this.coreManager?.persistNow?.();
      return state ? { providerKey: options.providerKey, state } : null;
    }
    return await this.legacyDelegate.disableProvider(options);
  }
}
