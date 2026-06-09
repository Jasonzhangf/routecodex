import { logNonBlockingError as logRequestExecutorNonBlockingError } from './request-executor-error-report.js';
import {
  peekErrorActionBackoffWaitMs,
  recordErrorActionBackoff,
  resetErrorActionBackoff,
  resetErrorActionBackoffByScopePrefix,
  resetErrorActionQueueStateForTests,
  waitErrorActionBackoffWithGate
} from './request-executor-error-action-queue.js';

export function peekScopedErrorBackoffWaitMs(scopeKey: string): number {
  if (!scopeKey) {
    return 0;
  }
  return peekErrorActionBackoffWaitMs({
    category: 'global_error',
    scopeKey
  });
}

export function resetScopedErrorBackoff(scopeKey: string): void {
  if (!scopeKey) {
    return;
  }
  resetErrorActionBackoff({
    category: 'global_error',
    scopeKey
  });
}

export function resetScopedErrorBackoffByProvider(prefixKey: string): void {
  if (!prefixKey) {
    return;
  }
  resetErrorActionBackoffByScopePrefix({
    category: 'global_error',
    scopePrefix: prefixKey
  });
}

export function recordScopedErrorBackoff(scopeKey: string): number {
  if (!scopeKey) {
    return 0;
  }
  return recordErrorActionBackoff({
    category: 'global_error',
    scopeKey
  });
}

export async function waitScopedErrorBackoffWithGate(scopeKey: string, signal?: AbortSignal): Promise<number> {
  if (!scopeKey) {
    return 0;
  }
  return waitErrorActionBackoffWithGate({
    category: 'global_error',
    scopeKey,
    signal,
    logNonBlockingError: logRequestExecutorNonBlockingError
  });
}

export function resetGlobalErrorBackoffStateForTests(): void {
  resetErrorActionQueueStateForTests();
}
