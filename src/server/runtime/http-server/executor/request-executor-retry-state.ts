import {
  computeProviderFailureBackoffDelayMs
} from '../../../../providers/core/runtime/provider-failure-policy.js';
import {
  readString,
  normalizeCodeKey,
  normalizeRuntimeKey
} from './request-executor-error-shared.js';
import {
  waitWithClientAbortSignal
} from './request-executor-abort.js';

const RECOVERABLE_BACKOFF_TTL_MS = 5 * 60_000;

const recoverableErrorBackoffState = new Map<string, { consecutive: number; updatedAtMs: number }>();
const recoverableRetryGateState = new Map<string, Promise<void>>();
const recoverableRetryWaiterState = new Map<string, { activeWaiters: number; updatedAtMs: number }>();
const providerTransportBackoffState = new Map<string, {
  consecutive: number;
  updatedAtMs: number;
  nextAllowedAtMs: number;
}>();
const providerTransportBackoffGateState = new Map<string, Promise<void>>();
const logicalChainRetryState = new Map<string, {
  recoverableRetries: number;
  updatedAtMs: number;
  activeExecutions: number;
}>();

type LogNonBlockingError = (stage: string, error: unknown, details?: Record<string, unknown>) => void;

export function buildRecoverableErrorBackoffKey(args: {
  providerKey?: string;
  runtimeKey?: string;
  statusCode?: number;
  errorCode?: string;
  upstreamCode?: string;
  reason?: string;
}): string {
  const providerScope = (() => {
    const raw =
      (typeof args.providerKey === 'string' && args.providerKey.trim())
      || (typeof args.runtimeKey === 'string' && args.runtimeKey.trim())
      || 'unknown';
    return `provider:${raw}`;
  })();
  const statusPart = typeof args.statusCode === 'number' ? `status:${args.statusCode}` : 'status:none';
  const is429 = args.statusCode === 429
    || normalizeCodeKey(args.errorCode) === 'HTTP_429'
    || normalizeCodeKey(args.upstreamCode) === 'HTTP_429';
  if (is429) {
    // Keep 429 backoff chain stable to preserve exponential growth across
    // provider-specific wording/code noise in upstream payload.
    return `${providerScope}|status:429|rate_limit`;
  }
  const errorPart = normalizeCodeKey(args.errorCode) ?? 'error:none';
  const upstreamPart = normalizeCodeKey(args.upstreamCode) ?? 'upstream:none';
  const reasonPart = (() => {
    if (typeof args.reason !== 'string') {
      return 'reason:none';
    }
    const normalized = args.reason.trim().toLowerCase();
    if (!normalized) {
      return 'reason:none';
    }
    if (normalized.includes('fetch failed')) return 'reason:fetch_failed';
    if (normalized.includes('building not completed')) return 'reason:building_not_completed';
    if (normalized.includes('network')) return 'reason:network';
    if (normalized.includes('timeout')) return 'reason:timeout';
    return 'reason:other';
  })();
  return `${providerScope}|${statusPart}|${errorPart}|${upstreamPart}|${reasonPart}`;
}

export function consumeRecoverableErrorBackoffMs(
  key: string,
  args: {
    statusCode?: number;
    errorCode?: string;
    upstreamCode?: string;
    reason?: string;
  }
): number {
  const now = Date.now();
  for (const [existingKey, state] of recoverableErrorBackoffState.entries()) {
    if (now - state.updatedAtMs >= RECOVERABLE_BACKOFF_TTL_MS) {
      recoverableErrorBackoffState.delete(existingKey);
    }
  }
  const previous = recoverableErrorBackoffState.get(key);
  const consecutive =
    previous && now - previous.updatedAtMs < RECOVERABLE_BACKOFF_TTL_MS
      ? Math.min(previous.consecutive + 1, 16)
      : 1;
  recoverableErrorBackoffState.set(key, { consecutive, updatedAtMs: now });
  return computeProviderFailureBackoffDelayMs({
    scope: 'recoverable',
    statusCode: args.statusCode,
    consecutive
  });
}

export function consumeProviderScopedRetryBackoffMs(
  key: string,
  args: {
    error: unknown;
    statusCode?: number;
  }
): number {
  const now = Date.now();
  for (const [existingKey, state] of recoverableErrorBackoffState.entries()) {
    if (now - state.updatedAtMs >= RECOVERABLE_BACKOFF_TTL_MS) {
      recoverableErrorBackoffState.delete(existingKey);
    }
  }
  const previous = recoverableErrorBackoffState.get(key);
  const consecutive =
    previous && now - previous.updatedAtMs < RECOVERABLE_BACKOFF_TTL_MS
      ? Math.min(previous.consecutive + 1, 16)
      : 1;
  recoverableErrorBackoffState.set(key, { consecutive, updatedAtMs: now });
  return computeProviderFailureBackoffDelayMs({
    scope: 'provider',
    error: args.error,
    statusCode: args.statusCode,
    consecutive
  });
}

export function buildProviderTransportBackoffKey(args: {
  providerKey?: string;
  runtimeKey?: string;
}): string | undefined {
  const runtimeKey = normalizeRuntimeKey(args.runtimeKey);
  if (runtimeKey) {
    return `runtime:${runtimeKey}`;
  }
  const providerKey = readString(args.providerKey);
  if (providerKey) {
    return `provider:${providerKey}`;
  }
  return undefined;
}

export function consumeProviderTransportBackoffMs(
  key: string,
  args: {
    error: unknown;
    statusCode?: number;
  }
): number {
  const now = Date.now();
  for (const [existingKey, state] of providerTransportBackoffState.entries()) {
    if (now - state.updatedAtMs >= RECOVERABLE_BACKOFF_TTL_MS) {
      providerTransportBackoffState.delete(existingKey);
    }
  }
  const previous = providerTransportBackoffState.get(key);
  const consecutive =
    previous && now - previous.updatedAtMs < RECOVERABLE_BACKOFF_TTL_MS
      ? Math.min(previous.consecutive + 1, 16)
      : 1;
  const delayMs = computeProviderFailureBackoffDelayMs({
    scope: 'provider',
    error: args.error,
    statusCode: args.statusCode,
    consecutive
  });
  providerTransportBackoffState.set(key, {
    consecutive,
    updatedAtMs: now,
    nextAllowedAtMs: now + delayMs
  });
  return delayMs;
}

export function peekProviderTransportBackoffWaitMs(key: string): number {
  const state = providerTransportBackoffState.get(key);
  if (!state) {
    return 0;
  }
  const now = Date.now();
  if (now - state.updatedAtMs >= RECOVERABLE_BACKOFF_TTL_MS) {
    providerTransportBackoffState.delete(key);
    return 0;
  }
  return Math.max(0, state.nextAllowedAtMs - now);
}

export function clearProviderTransportBackoff(key?: string): void {
  if (key) {
    providerTransportBackoffState.delete(key);
  }
}

export function clearRecoverableErrorBackoff(key?: string): void {
  if (key) {
    recoverableErrorBackoffState.delete(key);
    return;
  }
  recoverableErrorBackoffState.clear();
}

export function clearRecoverableErrorBackoffForProvider(args: {
  providerKey?: string;
  runtimeKey?: string;
}): void {
  const prefixes = [args.providerKey, args.runtimeKey]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => `provider:${value.trim()}|`);
  if (prefixes.length === 0) {
    return;
  }
  for (const key of recoverableErrorBackoffState.keys()) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      recoverableErrorBackoffState.delete(key);
    }
  }
}

export async function waitProviderTransportBackoffWithGate(args: {
  key: string;
  ms: number;
  signal?: AbortSignal;
  logNonBlockingError: LogNonBlockingError;
}): Promise<void> {
  if (!(args.ms > 0)) {
    return;
  }
  const normalizedKey = args.key.trim() || 'provider:unknown';
  const previous = providerTransportBackoffGateState.get(normalizedKey) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  providerTransportBackoffGateState.set(normalizedKey, current);
  try {
    await previous.catch((error: unknown) => {
      args.logNonBlockingError('waitProviderTransportBackoffWithGate.previous', error, {
        key: normalizedKey
      });
    });
    await waitWithClientAbortSignal(args.ms, args.signal, args.logNonBlockingError);
  } finally {
    release();
    if (providerTransportBackoffGateState.get(normalizedKey) === current) {
      providerTransportBackoffGateState.delete(normalizedKey);
    }
  }
}

function resolveRecoverableBackoffMaxWaiters(): number {
  const raw =
    process.env.ROUTECODEX_RECOVERABLE_BACKOFF_MAX_WAITERS
    ?? process.env.RCC_RECOVERABLE_BACKOFF_MAX_WAITERS
    ?? '';
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (Number.isFinite(parsed) && parsed >= 1) {
    return parsed;
  }
  return 64;
}

function acquireRecoverableWaiterSlot(key: string): { key: string; activeWaiters: number } {
  const normalizedKey = key.trim() || 'recoverable:unknown';
  const now = Date.now();
  for (const [existingKey, state] of recoverableRetryWaiterState.entries()) {
    if (state.activeWaiters <= 0 || now - state.updatedAtMs >= RECOVERABLE_BACKOFF_TTL_MS) {
      recoverableRetryWaiterState.delete(existingKey);
    }
  }
  const current = recoverableRetryWaiterState.get(normalizedKey);
  const nextActiveWaiters = (current?.activeWaiters ?? 0) + 1;
  const maxWaiters = resolveRecoverableBackoffMaxWaiters();
  if (nextActiveWaiters > maxWaiters) {
    throw Object.assign(
      new Error(`recoverable retry waiters overloaded for key ${normalizedKey}`),
      {
        statusCode: 429,
        code: 'PROVIDER_TRAFFIC_SATURATED',
        retryable: true,
        details: {
          reason: 'recoverable_waiter_overload',
          recoverableKey: normalizedKey,
          activeWaiters: current?.activeWaiters ?? 0,
          maxWaiters
        }
      }
    );
  }
  recoverableRetryWaiterState.set(normalizedKey, {
    activeWaiters: nextActiveWaiters,
    updatedAtMs: now
  });
  return {
    key: normalizedKey,
    activeWaiters: nextActiveWaiters
  };
}

function releaseRecoverableWaiterSlot(key: string): void {
  const normalizedKey = key.trim() || 'recoverable:unknown';
  const current = recoverableRetryWaiterState.get(normalizedKey);
  if (!current) {
    return;
  }
  const nextActiveWaiters = Math.max(0, current.activeWaiters - 1);
  if (nextActiveWaiters === 0) {
    recoverableRetryWaiterState.delete(normalizedKey);
    return;
  }
  recoverableRetryWaiterState.set(normalizedKey, {
    activeWaiters: nextActiveWaiters,
    updatedAtMs: Date.now()
  });
}

export function acquireRecoverableRetryWaiterSlotForTests(key: string): { key: string; activeWaiters: number } {
  return acquireRecoverableWaiterSlot(key);
}

export function releaseRecoverableRetryWaiterSlotForTests(key: string): void {
  releaseRecoverableWaiterSlot(key);
}

export async function waitRecoverableBackoffWithGlobalGate(args: {
  key: string;
  ms: number;
  signal?: AbortSignal;
  logNonBlockingError: LogNonBlockingError;
}): Promise<void> {
  const waiter = acquireRecoverableWaiterSlot(args.key);
  const normalizedKey = waiter.key;
  const previous = recoverableRetryGateState.get(normalizedKey) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  recoverableRetryGateState.set(normalizedKey, current);
  try {
    await previous.catch((error: unknown) => {
      args.logNonBlockingError('waitRecoverableBackoffWithGlobalGate.previous', error, {
        key: normalizedKey
      });
    });
    await waitWithClientAbortSignal(args.ms, args.signal, args.logNonBlockingError);
  } finally {
    release();
    if (recoverableRetryGateState.get(normalizedKey) === current) {
      recoverableRetryGateState.delete(normalizedKey);
    }
    releaseRecoverableWaiterSlot(normalizedKey);
  }
}

export function deriveLogicalRequestChainKey(requestId: string): string {
  const normalized = typeof requestId === 'string' ? requestId.trim() : '';
  if (!normalized) {
    return 'request-chain:unknown';
  }
  const root = normalized.split(':')[0]?.trim() || normalized;
  return root || 'request-chain:unknown';
}

export function retainLogicalRequestChain(key: string): string {
  const normalizedKey = key.trim() || 'request-chain:unknown';
  const now = Date.now();
  for (const [existingKey, state] of logicalChainRetryState.entries()) {
    if (state.activeExecutions <= 0 && now - state.updatedAtMs >= RECOVERABLE_BACKOFF_TTL_MS) {
      logicalChainRetryState.delete(existingKey);
    }
  }
  const current = logicalChainRetryState.get(normalizedKey);
  logicalChainRetryState.set(normalizedKey, {
    recoverableRetries: current?.recoverableRetries ?? 0,
    updatedAtMs: now,
    activeExecutions: (current?.activeExecutions ?? 0) + 1
  });
  return normalizedKey;
}

export function releaseLogicalRequestChain(key: string): void {
  const current = logicalChainRetryState.get(key);
  if (!current) {
    return;
  }
  const nextActiveExecutions = Math.max(0, current.activeExecutions - 1);
  if (nextActiveExecutions === 0) {
    logicalChainRetryState.delete(key);
    return;
  }
  logicalChainRetryState.set(key, {
    ...current,
    activeExecutions: nextActiveExecutions,
    updatedAtMs: Date.now()
  });
}

function resolveLogicalChainRecoverableRetryLimit(): number {
  const raw =
    process.env.ROUTECODEX_LOGICAL_CHAIN_RECOVERABLE_RETRY_LIMIT
    ?? process.env.RCC_LOGICAL_CHAIN_RECOVERABLE_RETRY_LIMIT
    ?? '';
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (Number.isFinite(parsed) && parsed >= 1) {
    return parsed;
  }
  return 8;
}

export function consumeLogicalChainRecoverableRetry(key: string): {
  allowed: boolean;
  count: number;
  limit: number;
} {
  const normalizedKey = key.trim() || 'request-chain:unknown';
  const limit = resolveLogicalChainRecoverableRetryLimit();
  const current = logicalChainRetryState.get(normalizedKey) ?? {
    recoverableRetries: 0,
    updatedAtMs: 0,
    activeExecutions: 0
  };
  const count = current.recoverableRetries + 1;
  logicalChainRetryState.set(normalizedKey, {
    ...current,
    recoverableRetries: count,
    updatedAtMs: Date.now()
  });
  return {
    allowed: count <= limit,
    count,
    limit
  };
}

export function peekRecoverableRetryWaitersForTests(key: string): number {
  const normalizedKey = key.trim() || 'recoverable:unknown';
  return recoverableRetryWaiterState.get(normalizedKey)?.activeWaiters ?? 0;
}

export function peekProviderTransportBackoffConsecutiveForTests(key: string): number {
  return providerTransportBackoffState.get(key)?.consecutive ?? 0;
}

export function resetRequestExecutorRetryStateForTests(): void {
  recoverableErrorBackoffState.clear();
  recoverableRetryGateState.clear();
  recoverableRetryWaiterState.clear();
  providerTransportBackoffState.clear();
  providerTransportBackoffGateState.clear();
  logicalChainRetryState.clear();
}
