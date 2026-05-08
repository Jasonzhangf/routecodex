/**
 * Error Reporting Helpers
 *
 * Extracted from request-executor.ts.
 * Non-blocking logging and error formatting utilities.
 */

import { readString } from './request-executor-error-shared.js';

const NON_BLOCKING_LOG_THROTTLE_MS = 60_000;
const nonBlockingLogState = new Map<string, number>();

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function cloneErrorForReporting(error: unknown): unknown {
  if (!error || typeof error !== 'object') {
    return error;
  }
  if (error instanceof Error) {
    const cloned = new Error(error.message);
    cloned.name = error.name;
    if (typeof error.stack === 'string') {
      cloned.stack = error.stack;
    }
    return Object.assign(cloned, error);
  }
  if (Array.isArray(error)) {
    return [...error];
  }
  return { ...(error as Record<string, unknown>) };
}

export function logNonBlockingError(stage: string, error: unknown, details?: Record<string, unknown>): void {
  const now = Date.now();
  const last = nonBlockingLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingLogState.set(stage, now);
  try {
    const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[request-executor] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

export function isNetworkTransportLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const record = error as { code?: unknown; message?: unknown; name?: unknown };
  const code = typeof record.code === 'string' ? record.code.trim().toUpperCase() : '';
  if (
    code === 'ECONNRESET'
    || code === 'ECONNREFUSED'
    || code === 'EHOSTUNREACH'
    || code === 'ENOTFOUND'
    || code === 'EAI_AGAIN'
    || code === 'EPIPE'
    || code === 'ETIMEDOUT'
    || code === 'ECONNABORTED'
  ) {
    return true;
  }
  const name = typeof record.name === 'string' ? record.name : '';
  const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';
  if (name === 'AbortError' || message.includes('operation was aborted')) {
    return true;
  }
  return (
    message.includes('fetch failed')
    || message.includes('network timeout')
    || message.includes('socket hang up')
    || message.includes('client network socket disconnected')
    || message.includes('tls handshake timeout')
    || message.includes('unable to verify the first certificate')
    || message.includes('network error')
    || message.includes('temporarily unreachable')
  );
}

export function resetErrorReportStateForTests(): void {
  nonBlockingLogState.clear();
}
