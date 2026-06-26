import {
  readString,
} from './request-executor-error-shared.js';
import {
  type ErrorActionCategory,
  peekErrorActionBackoffConsecutiveForTests,
  resetErrorActionBackoff,
  resetErrorActionBackoffByScopePrefix,
  resetErrorActionQueueStateForTests,
} from './request-executor-error-action-queue.js';

const logicalChainRetryState = new Map<string, {
  recoverableRetries: number;
  updatedAtMs: number;
  activeExecutions: number;
}>();

type LogNonBlockingError = (stage: string, error: unknown, details?: Record<string, unknown>) => void;

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
    if (state.activeExecutions <= 0 && now - state.updatedAtMs >= 5 * 60_000) {
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

export function resetRequestExecutorRetryStateForTests(): void {
  logicalChainRetryState.clear();
  resetErrorActionQueueStateForTests();
}
