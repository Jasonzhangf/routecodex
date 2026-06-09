import {
  readString,
  normalizeCodeKey,
  normalizeRuntimeKey
} from './request-executor-error-shared.js';
import {
  type ErrorActionCategory,
  peekErrorActionBackoffConsecutiveForTests,
  peekErrorActionBackoffWaitMs,
  recordErrorActionBackoff,
  resetErrorActionBackoff,
  resetErrorActionBackoffByScopePrefix,
  resetErrorActionQueueStateForTests,
  waitErrorActionBackoffWithGate
} from './request-executor-error-action-queue.js';

const RECOVERABLE_BACKOFF_TTL_MS = 5 * 60_000;

const providerTransportBackoffState = new Map<string, {
  updatedAtMs: number;
}>();
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
    // Keep 429 backoff scope stable across provider-specific wording/code noise.
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
  void args;
  return recordErrorActionBackoff({
    category: 'provider_recoverable',
    scopeKey: key
  });
}

export function consumeProviderScopedRetryBackoffMs(
  key: string,
  args: {
    error: unknown;
    statusCode?: number;
  }
): number {
  void args;
  return recordErrorActionBackoff({
    category: 'provider_recoverable',
    scopeKey: key
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
      resetErrorActionBackoff({
        category: 'provider_transport',
        scopeKey: existingKey
      });
    }
  }
  void args;
  const delayMs = recordErrorActionBackoff({
    category: 'provider_transport',
    scopeKey: key
  });
  providerTransportBackoffState.set(key, {
    updatedAtMs: now
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
    resetErrorActionBackoff({
      category: 'provider_transport',
      scopeKey: key
    });
    return 0;
  }
  return peekErrorActionBackoffWaitMs({
    category: 'provider_transport',
    scopeKey: key
  });
}

export function clearProviderTransportBackoff(key?: string): void {
  if (key) {
    providerTransportBackoffState.delete(key);
    resetErrorActionBackoff({
      category: 'provider_transport',
      scopeKey: key
    });
  }
}

export function clearRecoverableErrorBackoff(key?: string): void {
  if (key) {
    resetErrorActionBackoff({
      category: 'provider_recoverable',
      scopeKey: key
    });
    return;
  }
  resetErrorActionBackoff({
    category: 'provider_recoverable'
  });
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
  for (const prefix of prefixes) {
    resetErrorActionBackoffByScopePrefix({
      category: 'provider_recoverable',
      scopePrefix: prefix
    });
  }
}

function inferActionCategoryForBackoffKey(key: string): ErrorActionCategory {
  return key.startsWith('runtime:') ? 'provider_transport' : 'provider_recoverable';
}

function waitBackoffWithGlobalGate(args: {
  category: ErrorActionCategory;
  key: string;
  ms: number;
  signal?: AbortSignal;
  logNonBlockingError: LogNonBlockingError;
}): Promise<void> {
  return waitErrorActionBackoffWithGate({
    category: args.category,
    scopeKey: args.key,
    ms: args.ms,
    signal: args.signal,
    logNonBlockingError: args.logNonBlockingError
  }).then(() => undefined);
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
  await waitBackoffWithGlobalGate({
    category: 'provider_transport',
    key: args.key,
    ms: args.ms,
    signal: args.signal,
    logNonBlockingError: args.logNonBlockingError
  });
}

export async function waitRecoverableBackoffWithGlobalGate(args: {
  key: string;
  ms: number;
  signal?: AbortSignal;
  logNonBlockingError: LogNonBlockingError;
}): Promise<void> {
  await waitBackoffWithGlobalGate({
    category: inferActionCategoryForBackoffKey(args.key),
    key: args.key,
    ms: args.ms,
    signal: args.signal,
    logNonBlockingError: args.logNonBlockingError
  });
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

export function peekProviderTransportBackoffConsecutiveForTests(key: string): number {
  return peekErrorActionBackoffConsecutiveForTests({
    category: 'provider_transport',
    scopeKey: key
  });
}

export function resetRequestExecutorRetryStateForTests(): void {
  providerTransportBackoffState.clear();
  logicalChainRetryState.clear();
  resetErrorActionQueueStateForTests();
}
