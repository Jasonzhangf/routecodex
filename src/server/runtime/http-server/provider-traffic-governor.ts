import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ProviderConcurrencyConfig,
  ProviderRpmConfig,
  ProviderRuntimeProfile
} from '../../../providers/core/api/provider-types.js';
import { resolveRccStateDir } from '../../../config/user-data-paths.js';

type LockHandle = {
  release(): Promise<void>;
};

type ProviderTrafficState = {
  version: 1;
  updatedAt: number;
  leases: TrafficLease[];
  rpmEvents: RpmEvent[];
};

type TrafficLease = {
  leaseId: string;
  requestId: string;
  pid: number;
  startedAt: number;
  expiresAt: number;
};

type RpmEvent = {
  requestId: string;
  startedAt: number;
};

export type ResolvedProviderTrafficPolicy = {
  concurrency: Required<ProviderConcurrencyConfig>;
  rpm: Required<ProviderRpmConfig> & { windowMs: number };
};

export type ProviderTrafficPermit = {
  runtimeKey: string;
  providerKey?: string;
  requestId: string;
  leaseId: string;
  stateKey: string;
};

export class ProviderTrafficSaturatedError extends Error {
  readonly statusCode = 429;
  readonly code = 'PROVIDER_TRAFFIC_SATURATED';
  readonly retryable = true;
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = 'ProviderTrafficSaturatedError';
    this.details = details;
  }
}

export type ProviderTrafficAcquireResult = {
  permit: ProviderTrafficPermit;
  policy: ResolvedProviderTrafficPolicy;
  waitedMs: number;
  activeInFlight: number;
  rpmInWindow: number;
};

export type ProviderTrafficOutcomeEvent = {
  runtimeKey: string;
  providerKey?: string;
  requestId?: string;
  success: boolean;
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
  reason?: string;
  activeInFlight?: number;
  observedAtMs?: number;
  configuredMaxInFlight?: number;
};

export interface ProviderTrafficGovernorLike {
  acquire(options: {
    runtimeKey: string;
    providerKey?: string;
    requestId: string;
    runtime: ProviderRuntimeProfile;
    softWaitTimeoutMs?: number;
  }): Promise<ProviderTrafficAcquireResult>;
  release(permit: ProviderTrafficPermit): Promise<{ released: boolean; activeInFlight: number }>;
  observeOutcome?(event: ProviderTrafficOutcomeEvent): Promise<void>;
}

export type ProviderTrafficResetResult = {
  stateFilesScanned: number;
  stateFilesUpdated: number;
  leasesRemoved: number;
  rpmEventsRemoved: number;
};

const DEFAULT_CONCURRENCY_TIMEOUT_MS = 60_000;
const DEFAULT_CONCURRENCY_STALE_MS = 300_000;
const DEFAULT_RPM_TIMEOUT_MS = 60_000;
const DEFAULT_RPM_WINDOW_MS = 60_000;
const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_BASE_MS = 20;
const ACQUIRE_WAIT_BASE_MS = 100;
const ACQUIRE_WAIT_MAX_MS = 2_000;
const ACQUIRE_JITTER_MS = 40;
const LOCK_WAIT_MAX_MS = 250;
const PROVIDER_TRAFFIC_RUN_NAMESPACE =
  `run-${process.pid}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

const ADAPTIVE_WINDOW_MINUTES = 15;
const ADAPTIVE_TREND_SPLIT_MINUTES = 5;
const ADAPTIVE_TREND_THRESHOLD = 0.2;
const ADAPTIVE_BURST_429_THRESHOLD = 3;
const ADAPTIVE_COOLDOWN_DOWN_MS = 3 * 60_000;
const ADAPTIVE_COOLDOWN_UP_MS = 2 * 60_000;
const ADAPTIVE_DEFAULT_HARD_MAX = 64;
const ADAPTIVE_DEFAULT_HARD_MULTIPLIER = 2;

type AdaptiveMinuteBucket = {
  minute: number;
  requests: number;
  http429: number;
  peakInFlight: number;
};

type AdaptiveRuntimeState = {
  runtimeKey: string;
  baseCap: number;
  minCap: number;
  hardMaxCap: number;
  currentCap: number;
  safeCap: number;
  cooldownUntilMs: number;
  lastDecisionMinute: number;
  triedIncreaseCaps: Set<number>;
  buckets: AdaptiveMinuteBucket[];
  updatedAtMs: number;
};

type AdaptivePersistedRuntimeState = {
  baseCap: number;
  minCap: number;
  hardMaxCap: number;
  currentCap: number;
  safeCap: number;
  cooldownUntilMs: number;
  triedIncreaseCaps: number[];
  updatedAtMs: number;
};

type AdaptivePersistedConfig = {
  version: 1;
  updatedAt: number;
  runtimes: Record<string, AdaptivePersistedRuntimeState>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toMinuteBucket(ms: number): number {
  return Math.floor(ms / 60_000);
}

function clampPositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeCode(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().toUpperCase();
}

function readAdaptiveEnvInt(keys: string[], fallback: number): number {
  for (const key of keys) {
    const parsed = clampPositiveInt(process.env[key]);
    if (parsed) {
      return parsed;
    }
  }
  return fallback;
}

function isRecoverable429Like(event: ProviderTrafficOutcomeEvent): boolean {
  if (event.statusCode === 429) {
    return true;
  }
  const errorCode = normalizeCode(event.errorCode);
  const upstreamCode = normalizeCode(event.upstreamCode);
  if (
    errorCode.includes('429')
    || upstreamCode.includes('429')
    || errorCode.includes('RATE_LIMIT')
    || upstreamCode.includes('RATE_LIMIT')
    || errorCode.includes('INSUFFICIENT_QUOTA')
    || upstreamCode.includes('INSUFFICIENT_QUOTA')
  ) {
    return true;
  }
  const reason = typeof event.reason === 'string' ? event.reason.trim().toLowerCase() : '';
  if (!reason) {
    return false;
  }
  return (
    reason.includes('too many requests')
    || reason.includes('rate limit')
    || reason.includes('insufficient_quota')
    || reason.includes('quota')
  );
}

function createAdaptivePersistedConfig(): AdaptivePersistedConfig {
  return {
    version: 1,
    updatedAt: Date.now(),
    runtimes: {}
  };
}

function toStateKey(runtimeKey: string): string {
  return encodeURIComponent(runtimeKey.trim());
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!Number.isFinite(pid) || (pid as number) <= 0) {
    return false;
  }
  try {
    process.kill(pid as number, 0);
    return true;
  } catch {
    return false;
  }
}

export function resolveProviderTrafficPolicy(
  runtime: ProviderRuntimeProfile,
  _providerKey?: string
): ResolvedProviderTrafficPolicy {
  const defaultMaxInFlight = 2;
  const defaultRpm = defaultMaxInFlight * 60;
  const configuredConcurrency = runtime.concurrency;
  const configuredRpm = runtime.rpm;
  const maxInFlight = clampPositiveInt(configuredConcurrency?.maxInFlight) ?? defaultMaxInFlight;
  const concurrencyTimeoutMs =
    clampPositiveInt(configuredConcurrency?.acquireTimeoutMs) ?? DEFAULT_CONCURRENCY_TIMEOUT_MS;
  const staleLeaseMs =
    clampPositiveInt(configuredConcurrency?.staleLeaseMs) ?? DEFAULT_CONCURRENCY_STALE_MS;
  const requestsPerMinute = clampPositiveInt(configuredRpm?.requestsPerMinute) ?? defaultRpm;
  const rpmTimeoutMs = clampPositiveInt(configuredRpm?.acquireTimeoutMs) ?? DEFAULT_RPM_TIMEOUT_MS;
  return {
    concurrency: {
      maxInFlight,
      acquireTimeoutMs: concurrencyTimeoutMs,
      staleLeaseMs
    },
    rpm: {
      requestsPerMinute,
      acquireTimeoutMs: rpmTimeoutMs,
      windowMs: DEFAULT_RPM_WINDOW_MS
    }
  };
}

async function readTrafficState(filePath: string): Promise<ProviderTrafficState> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = raw.trim() ? (JSON.parse(raw) as unknown) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { version: 1, updatedAt: Date.now(), leases: [], rpmEvents: [] };
    }
    const record = parsed as Record<string, unknown>;
    const leases = Array.isArray(record.leases)
      ? record.leases
          .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
          .map((entry) => {
            const value = entry as Record<string, unknown>;
            return {
              leaseId: typeof value.leaseId === 'string' ? value.leaseId : '',
              requestId: typeof value.requestId === 'string' ? value.requestId : '',
              pid: clampPositiveInt(value.pid) ?? 0,
              startedAt: clampPositiveInt(value.startedAt) ?? 0,
              expiresAt: clampPositiveInt(value.expiresAt) ?? 0
            } satisfies TrafficLease;
          })
          .filter((entry) => entry.leaseId && entry.requestId && entry.pid > 0 && entry.startedAt > 0 && entry.expiresAt > 0)
      : [];
    const rpmEvents = Array.isArray(record.rpmEvents)
      ? record.rpmEvents
          .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
          .map((entry) => {
            const value = entry as Record<string, unknown>;
            return {
              requestId: typeof value.requestId === 'string' ? value.requestId : '',
              startedAt: clampPositiveInt(value.startedAt) ?? 0
            } satisfies RpmEvent;
          })
          .filter((entry) => entry.requestId && entry.startedAt > 0)
      : [];
    return {
      version: 1,
      updatedAt: clampPositiveInt(record.updatedAt) ?? Date.now(),
      leases,
      rpmEvents
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { version: 1, updatedAt: Date.now(), leases: [], rpmEvents: [] };
    }
    throw error;
  }
}

async function writeTrafficState(filePath: string, state: ProviderTrafficState): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const payload = JSON.stringify(state);
  await fs.writeFile(tempPath, payload, 'utf8');
  await fs.rename(tempPath, filePath);
}

async function tryReadLockMeta(lockFile: string): Promise<{ pid?: number; createdAt?: number }> {
  try {
    const raw = await fs.readFile(lockFile, 'utf8');
    const parsed = raw.trim() ? (JSON.parse(raw) as unknown) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    return {
      pid: clampPositiveInt(record.pid),
      createdAt: clampPositiveInt(record.createdAt)
    };
  } catch {
    return {};
  }
}

function hasValidLockMeta(meta: { pid?: number; createdAt?: number }): boolean {
  return Number.isFinite(meta.pid) && (meta.pid as number) > 0
    && Number.isFinite(meta.createdAt) && (meta.createdAt as number) > 0;
}

export class ProviderTrafficGovernor implements ProviderTrafficGovernorLike {
  private readonly rootDir: string;
  private readonly lockDir: string;
  private readonly stateDir: string;
  private readonly adaptiveEnabled: boolean;
  private readonly adaptiveConfigPath: string;
  private readonly adaptiveHardMax: number;
  private readonly adaptiveHardMultiplier: number;
  private readonly adaptiveStateByRuntime = new Map<string, AdaptiveRuntimeState>();
  private readonly waiterStateByRuntime = new Map<string, { activeWaiters: number; updatedAtMs: number }>();
  private ensureDirsPromise: Promise<void> | null = null;
  private adaptiveLoadPromise: Promise<void> | null = null;
  private adaptiveWritePromise: Promise<void> | null = null;
  private adaptiveWriteTimer: NodeJS.Timeout | null = null;

  constructor(rootDir?: string) {
    const jestWorker = clampPositiveInt(process.env.JEST_WORKER_ID);
    const testScopedRoot = jestWorker
      ? path.join(resolveRccStateDir(), 'provider-traffic-test', `worker-${jestWorker}`, `pid-${process.pid}`)
      : undefined;
    const sharedNamespaceEnabled =
      process.env.ROUTECODEX_PROVIDER_TRAFFIC_SHARED === '1'
      || process.env.RCC_PROVIDER_TRAFFIC_SHARED === '1';
    const defaultRoot = sharedNamespaceEnabled
      ? path.join(resolveRccStateDir(), 'provider-traffic')
      : path.join(resolveRccStateDir(), 'provider-traffic', PROVIDER_TRAFFIC_RUN_NAMESPACE);
    const base = rootDir
      ? path.resolve(rootDir)
      : (testScopedRoot ?? defaultRoot);
    this.rootDir = base;
    this.lockDir = path.join(base, 'locks');
    this.stateDir = path.join(base, 'state');
    this.adaptiveEnabled = (() => {
      const raw = String(
        process.env.ROUTECODEX_DYNAMIC_CONCURRENCY_ENABLED
          ?? process.env.RCC_DYNAMIC_CONCURRENCY_ENABLED
          ?? '1'
      ).trim().toLowerCase();
      return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
    })();
    this.adaptiveHardMax = readAdaptiveEnvInt(
      ['ROUTECODEX_DYNAMIC_CONCURRENCY_HARD_MAX', 'RCC_DYNAMIC_CONCURRENCY_HARD_MAX'],
      ADAPTIVE_DEFAULT_HARD_MAX
    );
    this.adaptiveHardMultiplier = readAdaptiveEnvInt(
      ['ROUTECODEX_DYNAMIC_CONCURRENCY_HARD_MULTIPLIER', 'RCC_DYNAMIC_CONCURRENCY_HARD_MULTIPLIER'],
      ADAPTIVE_DEFAULT_HARD_MULTIPLIER
    );
    this.adaptiveConfigPath = (() => {
      const fromEnv =
        process.env.ROUTECODEX_DYNAMIC_CONCURRENCY_CONFIG_PATH
        || process.env.RCC_DYNAMIC_CONCURRENCY_CONFIG_PATH;
      if (typeof fromEnv === 'string' && fromEnv.trim()) {
        return path.resolve(fromEnv.trim());
      }
      return path.join(resolveRccStateDir(), 'provider-traffic', 'dynamic-concurrency-overrides.json');
    })();
  }

  private resolveAdaptiveHardMax(baseCap: number): number {
    const fallbackHardMax = Math.max(baseCap, Math.min(this.adaptiveHardMax, baseCap * this.adaptiveHardMultiplier));
    return clampInt(fallbackHardMax, 1, this.adaptiveHardMax);
  }

  private resolveMaxAcquireWaiters(): number {
    return readAdaptiveEnvInt(
      ['ROUTECODEX_PROVIDER_TRAFFIC_MAX_WAITERS', 'RCC_PROVIDER_TRAFFIC_MAX_WAITERS'],
      64
    );
  }

  private acquireWaiterSlot(runtimeKey: string): { activeWaiters: number } {
    const normalizedKey = runtimeKey.trim();
    const now = Date.now();
    for (const [existingKey, state] of this.waiterStateByRuntime.entries()) {
      if (state.activeWaiters <= 0 || now - state.updatedAtMs >= DEFAULT_CONCURRENCY_STALE_MS) {
        this.waiterStateByRuntime.delete(existingKey);
      }
    }
    const current = this.waiterStateByRuntime.get(normalizedKey);
    const nextActiveWaiters = (current?.activeWaiters ?? 0) + 1;
    const maxWaiters = this.resolveMaxAcquireWaiters();
    if (nextActiveWaiters > maxWaiters) {
      throw new ProviderTrafficSaturatedError(
        `provider traffic waiter queue overloaded for runtime ${normalizedKey}`,
        {
          reason: 'acquire_waiter_overload',
          runtimeKey: normalizedKey,
          activeWaiters: current?.activeWaiters ?? 0,
          maxWaiters
        }
      );
    }
    this.waiterStateByRuntime.set(normalizedKey, {
      activeWaiters: nextActiveWaiters,
      updatedAtMs: now
    });
    return {
      activeWaiters: nextActiveWaiters
    };
  }

  private releaseWaiterSlot(runtimeKey: string): void {
    const normalizedKey = runtimeKey.trim();
    const current = this.waiterStateByRuntime.get(normalizedKey);
    if (!current) {
      return;
    }
    const nextActiveWaiters = Math.max(0, current.activeWaiters - 1);
    if (nextActiveWaiters === 0) {
      this.waiterStateByRuntime.delete(normalizedKey);
      return;
    }
    this.waiterStateByRuntime.set(normalizedKey, {
      activeWaiters: nextActiveWaiters,
      updatedAtMs: Date.now()
    });
  }

  private async ensureAdaptiveLoaded(): Promise<void> {
    if (!this.adaptiveEnabled) {
      return;
    }
    if (!this.adaptiveLoadPromise) {
      this.adaptiveLoadPromise = (async () => {
        try {
          const raw = await fs.readFile(this.adaptiveConfigPath, 'utf8');
          const parsed = raw.trim() ? (JSON.parse(raw) as unknown) : null;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return;
          }
          const runtimesRaw = (parsed as { runtimes?: unknown }).runtimes;
          if (!runtimesRaw || typeof runtimesRaw !== 'object' || Array.isArray(runtimesRaw)) {
            return;
          }
          for (const [runtimeKey, value] of Object.entries(runtimesRaw as Record<string, unknown>)) {
            if (typeof runtimeKey !== 'string' || !runtimeKey.trim()) {
              continue;
            }
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
              continue;
            }
            const row = value as Record<string, unknown>;
            const baseCap = clampPositiveInt(row.baseCap) ?? 2;
            const minCap = clampPositiveInt(row.minCap) ?? 1;
            const hardMaxCap = clampPositiveInt(row.hardMaxCap) ?? this.resolveAdaptiveHardMax(baseCap);
            const currentCap = clampPositiveInt(row.currentCap) ?? baseCap;
            const safeCap = clampPositiveInt(row.safeCap) ?? baseCap;
            const cooldownUntilMs = clampPositiveInt(row.cooldownUntilMs) ?? 0;
            const triedIncreaseCaps = Array.isArray(row.triedIncreaseCaps)
              ? row.triedIncreaseCaps
                  .map((entry) => clampPositiveInt(entry))
                  .filter((entry): entry is number => typeof entry === 'number')
              : [];
            const normalizedMin = clampInt(minCap, 1, hardMaxCap);
            const normalizedState: AdaptiveRuntimeState = {
              runtimeKey: runtimeKey.trim(),
              baseCap: clampInt(baseCap, normalizedMin, hardMaxCap),
              minCap: normalizedMin,
              hardMaxCap,
              currentCap: clampInt(currentCap, normalizedMin, hardMaxCap),
              safeCap: clampInt(safeCap, normalizedMin, hardMaxCap),
              cooldownUntilMs,
              lastDecisionMinute: -1,
              triedIncreaseCaps: new Set(triedIncreaseCaps),
              buckets: [],
              updatedAtMs: clampPositiveInt(row.updatedAtMs) ?? Date.now()
            };
            this.adaptiveStateByRuntime.set(normalizedState.runtimeKey, normalizedState);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            // eslint-disable-next-line no-console
            console.warn(
              `[adaptive-concurrency] load failed path=${this.adaptiveConfigPath} reason=${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      })();
    }
    await this.adaptiveLoadPromise;
  }

  private toAdaptivePersistedConfig(): AdaptivePersistedConfig {
    const payload = createAdaptivePersistedConfig();
    for (const [runtimeKey, state] of this.adaptiveStateByRuntime.entries()) {
      payload.runtimes[runtimeKey] = {
        baseCap: state.baseCap,
        minCap: state.minCap,
        hardMaxCap: state.hardMaxCap,
        currentCap: state.currentCap,
        safeCap: state.safeCap,
        cooldownUntilMs: state.cooldownUntilMs,
        triedIncreaseCaps: Array.from(state.triedIncreaseCaps.values()).sort((a, b) => a - b),
        updatedAtMs: state.updatedAtMs
      };
    }
    payload.updatedAt = Date.now();
    return payload;
  }

  private scheduleAdaptivePersist(): void {
    if (!this.adaptiveEnabled) {
      return;
    }
    if (this.adaptiveWriteTimer) {
      return;
    }
    this.adaptiveWriteTimer = setTimeout(() => {
      this.adaptiveWriteTimer = null;
      this.adaptiveWritePromise = this.persistAdaptiveConfig().catch((error) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[adaptive-concurrency] persist failed path=${this.adaptiveConfigPath} reason=${error instanceof Error ? error.message : String(error)}`
        );
      });
    }, 400);
    this.adaptiveWriteTimer.unref?.();
  }

  private async persistAdaptiveConfig(): Promise<void> {
    const payload = this.toAdaptivePersistedConfig();
    await fs.mkdir(path.dirname(this.adaptiveConfigPath), { recursive: true });
    const tempPath = `${this.adaptiveConfigPath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(payload), 'utf8');
    await fs.rename(tempPath, this.adaptiveConfigPath);
  }

  private getOrCreateAdaptiveState(runtimeKey: string, baseCapRaw: number): AdaptiveRuntimeState {
    const runtimeId = runtimeKey.trim();
    const baseCap = Math.max(1, baseCapRaw);
    const existing = this.adaptiveStateByRuntime.get(runtimeId);
    const hardMaxCap = this.resolveAdaptiveHardMax(baseCap);
    if (existing) {
      existing.baseCap = clampInt(baseCap, 1, Math.max(existing.hardMaxCap, hardMaxCap));
      existing.hardMaxCap = Math.max(existing.hardMaxCap, hardMaxCap);
      existing.minCap = clampInt(existing.minCap || 1, 1, existing.hardMaxCap);
      existing.currentCap = clampInt(existing.currentCap || existing.baseCap, existing.minCap, existing.hardMaxCap);
      existing.safeCap = clampInt(existing.safeCap || existing.baseCap, existing.minCap, existing.hardMaxCap);
      return existing;
    }
    const state: AdaptiveRuntimeState = {
      runtimeKey: runtimeId,
      baseCap,
      minCap: 1,
      hardMaxCap,
      currentCap: clampInt(baseCap, 1, hardMaxCap),
      safeCap: clampInt(baseCap, 1, hardMaxCap),
      cooldownUntilMs: 0,
      lastDecisionMinute: -1,
      triedIncreaseCaps: new Set<number>(),
      buckets: [],
      updatedAtMs: Date.now()
    };
    this.adaptiveStateByRuntime.set(runtimeId, state);
    this.scheduleAdaptivePersist();
    return state;
  }

  private getOrCreateMinuteBucket(state: AdaptiveRuntimeState, minute: number): AdaptiveMinuteBucket {
    const existing = state.buckets.find((entry) => entry.minute === minute);
    if (existing) {
      return existing;
    }
    const next: AdaptiveMinuteBucket = {
      minute,
      requests: 0,
      http429: 0,
      peakInFlight: 0
    };
    state.buckets.push(next);
    state.buckets.sort((a, b) => a.minute - b.minute);
    const minMinute = minute - Math.max(ADAPTIVE_WINDOW_MINUTES * 2, 30);
    state.buckets = state.buckets.filter((entry) => entry.minute >= minMinute);
    return next;
  }

  private getWindowBuckets(state: AdaptiveRuntimeState, nowMinute: number): AdaptiveMinuteBucket[] {
    const out: AdaptiveMinuteBucket[] = [];
    const byMinute = new Map<number, AdaptiveMinuteBucket>();
    for (const entry of state.buckets) {
      byMinute.set(entry.minute, entry);
    }
    for (let minute = nowMinute - (ADAPTIVE_WINDOW_MINUTES - 1); minute <= nowMinute; minute += 1) {
      out.push(
        byMinute.get(minute) ?? {
          minute,
          requests: 0,
          http429: 0,
          peakInFlight: 0
        }
      );
    }
    return out;
  }

  private maybeEvaluateAdaptiveState(runtimeKey: string, state: AdaptiveRuntimeState, nowMs: number): void {
    const nowMinute = toMinuteBucket(nowMs);
    if (state.lastDecisionMinute === nowMinute) {
      return;
    }
    state.lastDecisionMinute = nowMinute;
    const window = this.getWindowBuckets(state, nowMinute);
    const total429 = window.reduce((sum, row) => sum + row.http429, 0);
    const totalRequests = window.reduce((sum, row) => sum + row.requests, 0);
    const prev5 = window
      .slice(ADAPTIVE_WINDOW_MINUTES - (ADAPTIVE_TREND_SPLIT_MINUTES * 2), ADAPTIVE_WINDOW_MINUTES - ADAPTIVE_TREND_SPLIT_MINUTES)
      .reduce((sum, row) => sum + row.http429, 0) / ADAPTIVE_TREND_SPLIT_MINUTES;
    const last5 = window
      .slice(ADAPTIVE_WINDOW_MINUTES - ADAPTIVE_TREND_SPLIT_MINUTES)
      .reduce((sum, row) => sum + row.http429, 0) / ADAPTIVE_TREND_SPLIT_MINUTES;
    const trendUp = (last5 - prev5) > ADAPTIVE_TREND_THRESHOLD;
    const latest429 = window[window.length - 1]?.http429 ?? 0;
    const canAdjustDown = state.currentCap > state.minCap;
    const beforeCap = state.currentCap;
    let changed = false;
    let reason = '';

    if ((latest429 >= ADAPTIVE_BURST_429_THRESHOLD || (trendUp && total429 >= 2)) && canAdjustDown) {
      state.currentCap = latest429 >= ADAPTIVE_BURST_429_THRESHOLD
        ? clampInt(state.currentCap - 2, state.minCap, state.hardMaxCap)
        : clampInt(Math.floor(state.currentCap * 0.8), state.minCap, state.hardMaxCap);
      state.cooldownUntilMs = nowMs + ADAPTIVE_COOLDOWN_DOWN_MS;
      changed = state.currentCap !== beforeCap;
      reason = latest429 >= ADAPTIVE_BURST_429_THRESHOLD ? 'burst_429' : 'avg_429_trend_up';
    } else if (total429 === 0 && totalRequests > 0) {
      const peak = window.reduce((max, row) => Math.max(max, row.peakInFlight), 0);
      const nextSafeCap = clampInt(Math.max(state.safeCap, peak), state.minCap, state.hardMaxCap);
      if (nextSafeCap !== state.safeCap) {
        state.safeCap = nextSafeCap;
        changed = true;
      }
      const cooldownDone = nowMs >= state.cooldownUntilMs;
      const utilizationHigh = peak >= Math.max(1, Math.ceil(state.currentCap * 0.8));
      const canProbeUp =
        cooldownDone
        && utilizationHigh
        && state.currentCap < state.hardMaxCap
        && !state.triedIncreaseCaps.has(state.currentCap)
        && state.currentCap >= state.safeCap;
      if (canProbeUp) {
        const fromCap = state.currentCap;
        state.triedIncreaseCaps.add(fromCap);
        state.currentCap = clampInt(fromCap + 1, state.minCap, state.hardMaxCap);
        state.cooldownUntilMs = nowMs + ADAPTIVE_COOLDOWN_UP_MS;
        changed = true;
        reason = 'no_429_probe_up';
      }
    }

    state.updatedAtMs = nowMs;
    if (changed) {
      this.scheduleAdaptivePersist();
      // eslint-disable-next-line no-console
      console.log(
        `[adaptive-concurrency] runtime=${runtimeKey} cap=${beforeCap}->${state.currentCap} ` +
          `safe=${state.safeCap} total429=${total429} prev5=${prev5.toFixed(2)} last5=${last5.toFixed(2)} reason=${reason || 'state_update'}`
      );
    }
  }

  private async ensureDirs(): Promise<void> {
    if (!this.ensureDirsPromise) {
      this.ensureDirsPromise = (async () => {
        await fs.mkdir(this.rootDir, { recursive: true });
        await fs.mkdir(this.lockDir, { recursive: true });
        await fs.mkdir(this.stateDir, { recursive: true });
      })();
    }
    await this.ensureDirsPromise;
  }

  private getLockFile(stateKey: string): string {
    return path.join(this.lockDir, `${stateKey}.lock`);
  }

  private getStateFile(stateKey: string): string {
    return path.join(this.stateDir, `${stateKey}.json`);
  }

  async resetCurrentProcessState(): Promise<ProviderTrafficResetResult> {
    await this.ensureDirs();
    const result: ProviderTrafficResetResult = {
      stateFilesScanned: 0,
      stateFilesUpdated: 0,
      leasesRemoved: 0,
      rpmEventsRemoved: 0
    };
    let files: string[] = [];
    try {
      files = await fs.readdir(this.stateDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return result;
      }
      throw error;
    }

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }
      const stateKey = file.slice(0, -'.json'.length);
      if (!stateKey) {
        continue;
      }
      result.stateFilesScanned += 1;
      const stateFile = this.getStateFile(stateKey);
      const lockFile = this.getLockFile(stateKey);
      const lock = await this.acquireFileLock(lockFile, Date.now() + DEFAULT_CONCURRENCY_TIMEOUT_MS);
      try {
        const state = await readTrafficState(stateFile);
        const removedRequestIds = new Set(
          state.leases
            .filter((lease) => lease.pid === process.pid)
            .map((lease) => lease.requestId)
        );
        const nextLeases = state.leases.filter((lease) => lease.pid !== process.pid);
        const nextRpmEvents = state.rpmEvents.filter((event) => !removedRequestIds.has(event.requestId));
        const leaseDelta = Math.max(0, state.leases.length - nextLeases.length);
        const rpmDelta = Math.max(0, state.rpmEvents.length - nextRpmEvents.length);
        if (leaseDelta <= 0 && rpmDelta <= 0) {
          continue;
        }
        result.leasesRemoved += leaseDelta;
        result.rpmEventsRemoved += rpmDelta;
        result.stateFilesUpdated += 1;
        await writeTrafficState(stateFile, {
          version: 1,
          updatedAt: Date.now(),
          leases: nextLeases,
          rpmEvents: nextRpmEvents
        });
      } finally {
        await lock.release();
      }
    }

    return result;
  }

  private async acquireFileLock(lockFile: string, deadlineAt: number): Promise<LockHandle> {
    await this.ensureDirs();
    let waitAttempt = 0;
    while (true) {
      const now = Date.now();
      if (now >= deadlineAt) {
        throw new ProviderTrafficSaturatedError('provider traffic lock acquire timed out', {
          reason: 'lock_acquire_timeout',
          lockFile
        });
      }
      try {
        const payload = JSON.stringify({ pid: process.pid, createdAt: now });
        await fs.writeFile(lockFile, payload, { flag: 'wx' });
        return {
          release: async () => {
            try {
              await fs.unlink(lockFile);
            } catch (error) {
              if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
                throw error;
              }
            }
          }
        };
      } catch (error) {
        const errno = (error as NodeJS.ErrnoException)?.code;
        if (errno === 'ENOENT') {
          await this.ensureDirs();
          continue;
        }
        if (errno !== 'EEXIST') {
          throw error;
        }
        const meta = await tryReadLockMeta(lockFile);
        if (!hasValidLockMeta(meta)) {
          try {
            await fs.unlink(lockFile);
            continue;
          } catch (unlinkError) {
            if ((unlinkError as NodeJS.ErrnoException)?.code !== 'ENOENT') {
              // another process may race us; fallback to wait
            }
          }
        }
        const createdAt = meta.createdAt ?? 0;
        const lockAgeMs = createdAt > 0 ? now - createdAt : 0;
        const stale = lockAgeMs > LOCK_STALE_MS || !isProcessAlive(meta.pid);
        if (stale) {
          try {
            await fs.unlink(lockFile);
            continue;
          } catch (unlinkError) {
            if ((unlinkError as NodeJS.ErrnoException)?.code !== 'ENOENT') {
              // another process may race us; fallback to wait
            }
          }
        }
      }
      waitAttempt += 1;
      const delayMs = Math.min(
        LOCK_WAIT_MAX_MS,
        LOCK_WAIT_BASE_MS * Math.pow(2, Math.min(6, waitAttempt - 1))
      );
      await sleep(delayMs);
    }
  }

  private pruneState(
    state: ProviderTrafficState,
    now: number,
    policy: ResolvedProviderTrafficPolicy
  ): ProviderTrafficState {
    const rpmFloor = now - policy.rpm.windowMs;
    const leases = state.leases.filter((lease) => {
      if (lease.expiresAt <= now) {
        return false;
      }
      if (!isProcessAlive(lease.pid)) {
        return false;
      }
      return true;
    });
    const rpmEvents = state.rpmEvents.filter((event) => event.startedAt >= rpmFloor);
    return {
      version: 1,
      updatedAt: now,
      leases,
      rpmEvents
    };
  }

  async acquire(options: {
    runtimeKey: string;
    providerKey?: string;
    requestId: string;
    runtime: ProviderRuntimeProfile;
    softWaitTimeoutMs?: number;
  }): Promise<ProviderTrafficAcquireResult> {
    const runtimeKey = options.runtimeKey.trim();
    if (!runtimeKey) {
      throw new Error('[provider-traffic] acquire requires runtimeKey');
    }
    const requestId = options.requestId.trim();
    if (!requestId) {
      throw new Error('[provider-traffic] acquire requires requestId');
    }
    await this.ensureAdaptiveLoaded();
    const policyBase = resolveProviderTrafficPolicy(options.runtime, options.providerKey);
    const adaptiveState = this.adaptiveEnabled
      ? this.getOrCreateAdaptiveState(runtimeKey, policyBase.concurrency.maxInFlight)
      : null;
    const policy: ResolvedProviderTrafficPolicy = adaptiveState
      ? {
          ...policyBase,
          concurrency: {
            ...policyBase.concurrency,
            maxInFlight: clampInt(
              adaptiveState.currentCap,
              adaptiveState.minCap,
              adaptiveState.hardMaxCap
            )
          }
        }
      : policyBase;
    const waitTimeoutMs = Math.min(
      policy.concurrency.acquireTimeoutMs,
      policy.rpm.acquireTimeoutMs
    );
    const startedAt = Date.now();
    const deadlineAt = startedAt + waitTimeoutMs;
    const softWaitTimeoutMs = clampPositiveInt(options.softWaitTimeoutMs) ?? 0;
    const stateKey = toStateKey(runtimeKey);
    const stateFile = this.getStateFile(stateKey);
    const lockFile = this.getLockFile(stateKey);
    let waitAttempt = 0;
    let lastReason: 'concurrency' | 'rpm' | 'mixed' = 'mixed';
    let waiterSlotHeld = false;
    try {
      while (true) {
        let delayAfterReleaseMs = 0;
        const lock = await this.acquireFileLock(lockFile, deadlineAt);
        try {
          const now = Date.now();
          let state = await readTrafficState(stateFile);
          state = this.pruneState(state, now, policy);
          const activeInFlight = state.leases.length;
          const rpmInWindow = state.rpmEvents.length;
          const concurrencyBlocked = activeInFlight >= policy.concurrency.maxInFlight;
          const rpmBlocked = rpmInWindow >= policy.rpm.requestsPerMinute;
          if (!concurrencyBlocked && !rpmBlocked) {
            const leaseId = randomUUID();
            state.leases.push({
              leaseId,
              requestId,
              pid: process.pid,
              startedAt: now,
              expiresAt: now + policy.concurrency.staleLeaseMs
            });
            state.rpmEvents.push({
              requestId,
              startedAt: now
            });
            state.updatedAt = now;
            await writeTrafficState(stateFile, state);
            if (adaptiveState) {
              const minute = toMinuteBucket(now);
              const bucket = this.getOrCreateMinuteBucket(adaptiveState, minute);
              bucket.requests += 1;
              bucket.peakInFlight = Math.max(bucket.peakInFlight, activeInFlight + 1);
              adaptiveState.updatedAtMs = now;
            }
            const waitedMs = Math.max(0, now - startedAt);
            return {
              permit: {
                runtimeKey,
                providerKey: options.providerKey,
                requestId,
                leaseId,
                stateKey
              },
              policy,
              waitedMs,
              activeInFlight: activeInFlight + 1,
              rpmInWindow: rpmInWindow + 1
            };
          }

          if (!waiterSlotHeld) {
            this.acquireWaiterSlot(runtimeKey);
            waiterSlotHeld = true;
          }

          if (concurrencyBlocked && rpmBlocked) {
            lastReason = 'mixed';
          } else if (concurrencyBlocked) {
            lastReason = 'concurrency';
          } else {
            lastReason = 'rpm';
          }

          const nowAfterCheck = Date.now();
          const waitedMs = Math.max(0, nowAfterCheck - startedAt);
          if (softWaitTimeoutMs > 0 && waitedMs >= softWaitTimeoutMs) {
            throw new ProviderTrafficSaturatedError(
              `provider traffic wait exceeded soft timeout for runtime ${runtimeKey}`,
              {
                reason: `acquire_soft_timeout_${lastReason}`,
                runtimeKey,
                providerKey: options.providerKey,
                maxInFlight: policy.concurrency.maxInFlight,
                requestsPerMinute: policy.rpm.requestsPerMinute,
                activeInFlight,
                rpmInWindow,
                waitedMs,
                softWaitTimeoutMs
              }
            );
          }
          if (nowAfterCheck >= deadlineAt) {
            throw new ProviderTrafficSaturatedError(
              `provider traffic saturated for runtime ${runtimeKey}`,
              {
                reason: `acquire_timeout_${lastReason}`,
                runtimeKey,
                providerKey: options.providerKey,
                maxInFlight: policy.concurrency.maxInFlight,
                requestsPerMinute: policy.rpm.requestsPerMinute,
                activeInFlight,
                rpmInWindow,
                waitedMs
              }
            );
          }

          waitAttempt += 1;
          const backoffMs = Math.min(
            ACQUIRE_WAIT_MAX_MS,
            ACQUIRE_WAIT_BASE_MS * Math.pow(2, Math.min(6, waitAttempt - 1))
          );
          let rpmWaitMs = 0;
          if (rpmBlocked && state.rpmEvents.length > 0) {
            const oldest = state.rpmEvents[0];
            rpmWaitMs = Math.max(0, oldest.startedAt + policy.rpm.windowMs - nowAfterCheck);
          }
          const combinedWaitMs = Math.min(
            ACQUIRE_WAIT_MAX_MS,
            Math.max(backoffMs, rpmWaitMs)
          );
          const jitterMs = Math.floor(Math.random() * ACQUIRE_JITTER_MS);
          delayAfterReleaseMs = Math.max(40, Math.min(combinedWaitMs + jitterMs, deadlineAt - nowAfterCheck));
        } finally {
          await lock.release();
        }
        if (delayAfterReleaseMs > 0) {
          await sleep(delayAfterReleaseMs);
        }
      }
    } finally {
      if (waiterSlotHeld) {
        this.releaseWaiterSlot(runtimeKey);
      }
    }
  }

  async release(permit: ProviderTrafficPermit): Promise<{ released: boolean; activeInFlight: number }> {
    const runtimeKey = permit.runtimeKey.trim();
    if (!runtimeKey) {
      throw new Error('[provider-traffic] release requires runtimeKey');
    }
    const stateKey = permit.stateKey || toStateKey(runtimeKey);
    const stateFile = this.getStateFile(stateKey);
    const lockFile = this.getLockFile(stateKey);
    const lock = await this.acquireFileLock(lockFile, Date.now() + DEFAULT_CONCURRENCY_TIMEOUT_MS);
    try {
      const now = Date.now();
      let state = await readTrafficState(stateFile);
      const fallbackPolicy: ResolvedProviderTrafficPolicy = {
        concurrency: {
          maxInFlight: 1,
          acquireTimeoutMs: DEFAULT_CONCURRENCY_TIMEOUT_MS,
          staleLeaseMs: DEFAULT_CONCURRENCY_STALE_MS
        },
        rpm: {
          requestsPerMinute: 60,
          acquireTimeoutMs: DEFAULT_RPM_TIMEOUT_MS,
          windowMs: DEFAULT_RPM_WINDOW_MS
        }
      };
      state = this.pruneState(state, now, fallbackPolicy);
      const before = state.leases.length;
      state.leases = state.leases.filter((lease) => lease.leaseId !== permit.leaseId);
      const released = state.leases.length < before;
      state.updatedAt = now;
      await writeTrafficState(stateFile, state);
      return {
        released,
        activeInFlight: state.leases.length
      };
    } finally {
      await lock.release();
    }
  }

  async observeOutcome(event: ProviderTrafficOutcomeEvent): Promise<void> {
    if (!this.adaptiveEnabled) {
      return;
    }
    const runtimeKey = typeof event.runtimeKey === 'string' ? event.runtimeKey.trim() : '';
    if (!runtimeKey) {
      return;
    }
    await this.ensureAdaptiveLoaded();
    const state = this.getOrCreateAdaptiveState(
      runtimeKey,
      clampPositiveInt(event.configuredMaxInFlight) ?? 2
    );
    const nowMs =
      typeof event.observedAtMs === 'number' && Number.isFinite(event.observedAtMs)
        ? Math.max(0, Math.floor(event.observedAtMs))
        : Date.now();
    const minute = toMinuteBucket(nowMs);
    const bucket = this.getOrCreateMinuteBucket(state, minute);
    if (bucket.requests <= 0) {
      bucket.requests = 1;
    }
    if (typeof event.activeInFlight === 'number' && Number.isFinite(event.activeInFlight)) {
      bucket.peakInFlight = Math.max(bucket.peakInFlight, Math.max(0, Math.floor(event.activeInFlight)));
    }
    if (!event.success && isRecoverable429Like(event)) {
      bucket.http429 += 1;
    }
    this.maybeEvaluateAdaptiveState(runtimeKey, state, nowMs);
  }
}

let sharedGovernor: ProviderTrafficGovernor | null = null;

export function getSharedProviderTrafficGovernor(): ProviderTrafficGovernor {
  if (!sharedGovernor) {
    sharedGovernor = new ProviderTrafficGovernor();
  }
  return sharedGovernor;
}

export function createNoopProviderTrafficGovernor(): ProviderTrafficGovernorLike {
  return {
    async acquire(options) {
      const policy = resolveProviderTrafficPolicy(options.runtime, options.providerKey);
      return {
        permit: {
          runtimeKey: options.runtimeKey,
          providerKey: options.providerKey,
          requestId: options.requestId,
          leaseId: `noop-${randomUUID()}`,
          stateKey: 'noop'
        },
        policy,
        waitedMs: 0,
        activeInFlight: 1,
        rpmInWindow: 1
      };
    },
    async release() {
      return {
        released: true,
        activeInFlight: 0
      };
    },
    async observeOutcome() {
      return;
    }
  };
}
