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

export interface ProviderTrafficGovernorLike {
  acquire(options: {
    runtimeKey: string;
    providerKey?: string;
    requestId: string;
    runtime: ProviderRuntimeProfile;
    softWaitTimeoutMs?: number;
  }): Promise<ProviderTrafficAcquireResult>;
  release(permit: ProviderTrafficPermit): Promise<{ released: boolean; activeInFlight: number }>;
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function resolveProviderTier(runtime: ProviderRuntimeProfile, providerKey?: string): 'single' | 'double' | 'quad' {
  const candidates = [
    runtime.providerFamily,
    runtime.providerId,
    providerKey,
    runtime.providerKey,
    runtime.runtimeKey
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase());
  const isMatch = (needle: string): boolean => candidates.some((item) => item.includes(needle));
  if (isMatch('deepseek') || isMatch('qwenchat')) {
    return 'single';
  }
  if (isMatch('ali-coding-plan') || isMatch('tabglm') || isMatch('crs')) {
    return 'quad';
  }
  return 'double';
}

export function resolveProviderTrafficPolicy(
  runtime: ProviderRuntimeProfile,
  providerKey?: string
): ResolvedProviderTrafficPolicy {
  const tier = resolveProviderTier(runtime, providerKey);
  const defaultMaxInFlight = tier === 'single' ? 1 : (tier === 'quad' ? 4 : 2);
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

export class ProviderTrafficGovernor implements ProviderTrafficGovernorLike {
  private readonly rootDir: string;
  private readonly lockDir: string;
  private readonly stateDir: string;
  private ensureDirsPromise: Promise<void> | null = null;

  constructor(rootDir?: string) {
    const jestWorker = clampPositiveInt(process.env.JEST_WORKER_ID);
    const testScopedRoot = jestWorker
      ? path.join(resolveRccStateDir(), 'provider-traffic-test', `worker-${jestWorker}`, `pid-${process.pid}`)
      : undefined;
    const base = rootDir
      ? path.resolve(rootDir)
      : (testScopedRoot ?? path.join(resolveRccStateDir(), 'provider-traffic'));
    this.rootDir = base;
    this.lockDir = path.join(base, 'locks');
    this.stateDir = path.join(base, 'state');
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
        if (errno !== 'EEXIST') {
          throw error;
        }
        const meta = await tryReadLockMeta(lockFile);
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
    const policy = resolveProviderTrafficPolicy(options.runtime, options.providerKey);
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
    }
  };
}
