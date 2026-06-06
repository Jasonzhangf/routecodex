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
import { x7eGate } from '../../../server/runtime/http-server/daemon-admin/routecodex-x7e-gate.js';
import type { QuotaManagerAdapter, QuotaViewEntry } from './quota-adapter.js';
import { createQuotaManagerAdapter } from './quota-adapter.js';
import { loadProviderQuotaSnapshot, saveProviderQuotaSnapshot } from '../../quota/provider-quota-store.js';
import { loadRouteCodexConfig } from '../../../config/routecodex-config-loader.js';
import { canonicalizeProviderKey } from './provider-key-normalization.js';

// feature_id: quota.unified_control_surface

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

function buildProviderKeyVariants(providerKey: string): string[] {
  const raw = typeof providerKey === 'string' ? providerKey.trim() : '';
  if (!raw) {
    return [];
  }
  const canonical = canonicalizeProviderKey(raw);
  const normalized = canonical.replace(/\.key(\d+)(?=\.|$)/gi, '.$1');
  const denormalized = canonical.replace(/\.(\d+)(?=\.|$)/g, '.key$1');
  return Array.from(new Set([raw, canonical, normalized, denormalized].filter(Boolean)));
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

function getRustQuotaHostMutatorFromContext(context: ManagerContext | null | undefined): RustQuotaHydrationMutator | null {
  let hubPipeline: unknown = null;
  try {
    hubPipeline = typeof context?.getHubPipeline === 'function' ? context.getHubPipeline() : null;
  } catch {
    return null;
  }
  if (!hubPipeline || typeof hubPipeline !== 'object') {
    return null;
  }
  const getVirtualRouter = (hubPipeline as { getVirtualRouter?: () => unknown | null }).getVirtualRouter;
  if (typeof getVirtualRouter !== 'function') {
    return null;
  }
  let virtualRouter: unknown = null;
  try {
    virtualRouter = getVirtualRouter();
  } catch {
    return null;
  }
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
  store: ProviderQuotaStoreAdapter,
  configuredProviderKeys?: ReadonlySet<string>
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
    if (configuredProviderKeys && configuredProviderKeys.size > 0) {
      const variants = buildProviderKeyVariants(providerKey);
      if (!variants.some((key) => configuredProviderKeys.has(key))) {
        continue;
      }
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
  store: ProviderQuotaStoreAdapter,
  configuredProviderKeys?: ReadonlySet<string>
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
    if (configuredProviderKeys && configuredProviderKeys.size > 0) {
      const variants = buildProviderKeyVariants(normalized.providerKey);
      if (!variants.some((key) => configuredProviderKeys.has(key))) {
        continue;
      }
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

  private context: ManagerContext | null = null;
  private readonly providerQuotaStore = new ProviderQuotaStoreAdapter();
  private rustQuotaHostReady = false;
  private controlAdapter: QuotaManagerAdapter | null = null;
  private readonly configuredProviderKeys = new Set<string>();
  private configuredProviderKeysLoaded = false;

  private async ensureConfiguredProviderKeysLoaded(): Promise<void> {
    if (this.configuredProviderKeysLoaded) {
      return;
    }
    this.configuredProviderKeysLoaded = true;
    const configPath = typeof this.context?.configPath === 'string' ? this.context.configPath.trim() : '';
    if (!configPath) {
      return;
    }
    try {
      const loaded = await loadRouteCodexConfig(configPath);
      const providers = loaded?.userConfig?.virtualrouter
        && typeof loaded.userConfig.virtualrouter === 'object'
        && !Array.isArray(loaded.userConfig.virtualrouter)
        && (loaded.userConfig.virtualrouter as { providers?: unknown }).providers
        && typeof (loaded.userConfig.virtualrouter as { providers?: unknown }).providers === 'object'
        && !Array.isArray((loaded.userConfig.virtualrouter as { providers?: unknown }).providers)
          ? ((loaded.userConfig.virtualrouter as { providers: Record<string, unknown> }).providers)
          : {};
      for (const providerKey of Object.keys(providers)) {
        for (const variant of buildProviderKeyVariants(providerKey)) {
          this.configuredProviderKeys.add(variant);
        }
      }
    } catch {
      this.configuredProviderKeysLoaded = false;
    }
  }

  private async ensureRustQuotaHostHydrated(): Promise<boolean> {
    if (this.rustQuotaHostReady) {
      return true;
    }
    if (!getRustQuotaHostMutatorFromContext(this.context)) {
      return false;
    }
    await this.ensureConfiguredProviderKeysLoaded();
    const hydratedByRust = await hydrateRustQuotaHostSnapshotFromStore(
      this.context,
      this.providerQuotaStore,
      this.getConfiguredProviderKeysForHydration()
    ).catch(() => false);
    if (!hydratedByRust) {
      return false;
    }
    this.rustQuotaHostReady = true;
    return true;
  }

  async init(context: ManagerContext): Promise<void> {
    this.context = context;
    this.controlAdapter = null;
    this.configuredProviderKeys.clear();
    this.configuredProviderKeysLoaded = false;
    if (!x7eGate.phase1UnifiedQuota) {
      throw new Error('legacy quota runtime mode has been removed; enable unified quota (ROUTECODEX_X7E_PHASE_1_UNIFIED_QUOTA=true)');
    }
    // Hub pipeline may not be initialized during daemon module init.
    // Defer hydration until start/runtime readiness when mutator becomes available.
    await this.ensureConfiguredProviderKeysLoaded();
    await this.ensureRustQuotaHostHydrated();
  }

  async start(): Promise<void> {
    // Manager daemon starts before runtime setup/hub pipeline is fully ready.
    // Do not fail server startup on ordering; hydrate lazily when mutator becomes available.
    await this.ensureConfiguredProviderKeysLoaded();
    await this.ensureRustQuotaHostHydrated();
    return;
  }

  async stop(): Promise<void> {
    if (!(await this.ensureRustQuotaHostHydrated())) {
      return;
    }
    const persistedByRust = await persistRustQuotaHostSnapshotToStore(
      this.context,
      this.providerQuotaStore,
      this.configuredProviderKeys
    ).catch(() => false);
    if (!persistedByRust) {
      throw new Error('unified quota rust host persist contract unavailable');
    }
  }

  async updateRoutingScope(_scope?: RoutingProviderScope): Promise<void> {
    return;
  }

  getControlSurface(): QuotaManagerAdapter {
    if (this.controlAdapter) {
      return this.controlAdapter;
    }
    this.controlAdapter = createQuotaManagerAdapter({
      rustHostMutator: getRustQuotaHostMutatorFromContext(this.context),
      quotaRoutingEnabled: this.context?.quotaRoutingEnabled !== false,
    });
    return this.controlAdapter;
  }

  async refreshNow(): Promise<{ refreshedAt: number; tokenCount: number; recordCount: number }> {
    const snapshot = this.getAdminSnapshot();
    return {
      refreshedAt: Date.now(),
      tokenCount: 0,
      recordCount: Object.keys(snapshot ?? {}).length
    };
  }

  getRawSnapshot(): Record<string, QuotaRecord> {
    return {};
  }

  getCoreQuotaManager(): null {
    return null;
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
    for (const variant of buildProviderKeyVariants(providerKey)) {
      this.configuredProviderKeys.add(variant);
    }
    void normalizedConfig;
  }

  getQuotaView(): (providerKey: string) => QuotaViewEntry | null {
    return this.getQuotaViewReadOnly();
  }

  getAdminSnapshot(): Record<string, QuotaState> {
    const rustSnapshot = readRustQuotaHostSnapshotMap(this.context);
    if (rustSnapshot) {
      if (this.configuredProviderKeys.size < 1) {
        return rustSnapshot;
      }
      return Object.fromEntries(
        Object.entries(rustSnapshot).filter(([providerKey]) =>
          buildProviderKeyVariants(providerKey).some((key) => this.configuredProviderKeys.has(key))
        )
      );
    }
    return {};
  }

  private getConfiguredProviderKeysForHydration(): ReadonlySet<string> | undefined {
    return this.configuredProviderKeys.size > 0 ? this.configuredProviderKeys : undefined;
  }

  getQuotaViewReadOnly(): (providerKey: string) => QuotaViewEntry | null {
    const rustSnapshot = readRustQuotaHostSnapshotMap(this.context);
    if (rustSnapshot) {
      return (providerKey: string): QuotaViewEntry | null => {
        const key = typeof providerKey === 'string' ? providerKey.trim() : '';
        if (!key) {
          return null;
        }
        if (
          this.configuredProviderKeys.size > 0 &&
          !buildProviderKeyVariants(key).some((variant) => this.configuredProviderKeys.has(variant))
        ) {
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
    return () => null;
  }

  async persistNow(): Promise<void> {
    if (!(await this.ensureRustQuotaHostHydrated())) {
      throw new Error('unified quota requires hubPipeline virtual router quota host mutator');
    }
    const persistedByRust = await persistRustQuotaHostSnapshotToStore(
      this.context,
      this.providerQuotaStore,
      this.configuredProviderKeys
    ).catch(() => false);
    if (!persistedByRust) {
      throw new Error('unified quota rust host persist contract unavailable');
    }
  }

  async resetProvider(providerKey: string): Promise<{ providerKey: string; state: unknown } | null> {
    const rustMutator = getRustQuotaHostMutatorFromContext(this.context);
    if (typeof rustMutator?.resetProviderQuota === 'function') {
      await Promise.resolve(rustMutator.resetProviderQuota(providerKey));
      const rustSnapshot = readRustQuotaHostSnapshotMap(this.context);
      const state = rustSnapshot?.[providerKey] ?? null;
      return state ? { providerKey, state } : { providerKey, state: null };
    }
    return { providerKey, state: null };
  }

  async recoverProvider(providerKey: string): Promise<{ providerKey: string; state: unknown } | null> {
    const rustMutator = getRustQuotaHostMutatorFromContext(this.context);
    if (typeof rustMutator?.recoverProviderQuota === 'function') {
      await Promise.resolve(rustMutator.recoverProviderQuota(providerKey));
      const rustSnapshot = readRustQuotaHostSnapshotMap(this.context);
      const state = rustSnapshot?.[providerKey] ?? null;
      return state ? { providerKey, state } : { providerKey, state: null };
    }
    return { providerKey, state: null };
  }

  async disableProvider(options: {
    providerKey: string;
    mode: 'cooldown' | 'blacklist';
    durationMs: number;
  }): Promise<{ providerKey: string; state: unknown } | null> {
    const rustMutator = getRustQuotaHostMutatorFromContext(this.context);
    if (typeof rustMutator?.disableProviderQuota === 'function') {
      await Promise.resolve(rustMutator.disableProviderQuota(options.providerKey, options.mode, options.durationMs));
      const rustSnapshot = readRustQuotaHostSnapshotMap(this.context);
      const state = rustSnapshot?.[options.providerKey] ?? null;
      return state ? { providerKey: options.providerKey, state } : { providerKey: options.providerKey, state: null };
    }
    return { providerKey: options.providerKey, state: null };
  }

  async clearCooldown(providerKey: string): Promise<unknown> {
    return this.getControlSurface().clearCooldown(providerKey);
  }

  async restoreNow(providerKey: string): Promise<unknown> {
    return this.getControlSurface().restoreNow(providerKey);
  }

  async setQuota(options: { providerKey: string; quota: number; reason?: string }): Promise<unknown> {
    return this.getControlSurface().setQuota(options);
  }
}
